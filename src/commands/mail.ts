/**
 * CLI command: legio mail send/check/list/read/reply
 *
 * Parses CLI args and delegates to the mail client.
 * Supports --inject for hook context injection, --json for machine output,
 * and various filters for listing messages.
 */

import { access, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectRoot } from "../config.ts";
import { MailError, ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { isGroupAddress, resolveGroupAddress } from "../mail/broadcast.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { MailAudience, MailMessage } from "../types.ts";
import { MAIL_MESSAGE_TYPES } from "../types.ts";
import { nudgeAgent } from "./nudge.ts";

/** Valid audience values for mail messages. */
const VALID_AUDIENCES = ["human", "agent", "both"] as const;

/**
 * Protocol message types that default to audience 'agent'.
 * Semantic types (status, question, result, error) default to 'both'.
 * Named differently from PROTOCOL_TYPES in client.ts to avoid confusion.
 */
const AGENT_AUDIENCE_TYPES: ReadonlySet<string> = new Set([
	"worker_done",
	"merge_ready",
	"merged",
	"merge_failed",
	"escalation",
	"health_check",
	"dispatch",
	"assign",
]);

/**
 * Parse a named flag value from an args array.
 * Returns the value after the flag, or undefined if not present.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/** Check if a boolean flag is present in the args. */
function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/** Boolean flags that do NOT consume the next arg as a value. */
const BOOLEAN_FLAGS = new Set([
	"--json",
	"--inject",
	"--unread",
	"--all",
	"--signal",
	"--help",
	"-h",
]);

/**
 * Extract positional arguments from an args array, skipping flag-value pairs.
 *
 * Iterates through args, skipping `--flag value` pairs for value-bearing flags
 * and lone boolean flags. Everything else is a positional arg.
 */
function getPositionalArgs(args: string[]): string[] {
	const positional: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg?.startsWith("-")) {
			// It's a flag. If it's boolean, skip just it; otherwise skip it + its value.
			if (BOOLEAN_FLAGS.has(arg)) {
				i += 1;
			} else {
				i += 2; // skip flag + its value
			}
		} else {
			if (arg !== undefined) {
				positional.push(arg);
			}
			i += 1;
		}
	}
	return positional;
}

/** Format a single message for human-readable output. */
function formatMessage(msg: MailMessage): string {
	const readMarker = msg.read ? " " : "*";
	const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
	const audienceTag = msg.audience !== "agent" ? ` [${msg.audience}]` : "";
	const lines: string[] = [
		`${readMarker} ${msg.id}  From: ${msg.from} → To: ${msg.to}${priorityTag}`,
		`  Subject: ${msg.subject}  (${msg.type}${audienceTag})`,
		`  ${msg.body}`,
	];
	if (msg.payload !== null) {
		lines.push(`  Payload: ${msg.payload}`);
	}
	lines.push(`  ${msg.createdAt}`);
	return lines.join("\n");
}

/**
 * Format messages for injection into agent context (audience-filtered inject path).
 *
 * Duplicates the format from client.ts's formatForInjection, needed because that
 * function is not exported. Used when --audience filtering must only mark matching
 * messages as read (requires direct store access rather than client.checkInject).
 */
function formatMessagesForInjection(messages: MailMessage[]): string {
	if (messages.length === 0) {
		return "";
	}
	const lines: string[] = [
		`📬 You have ${messages.length} new message${messages.length === 1 ? "" : "s"}:`,
		"",
	];
	for (const msg of messages) {
		const priorityTag = msg.priority !== "normal" ? ` [${msg.priority.toUpperCase()}]` : "";
		lines.push(`--- From: ${msg.from}${priorityTag} (${msg.type}) ---`);
		lines.push(`Subject: ${msg.subject}`);
		lines.push(msg.body);
		if (msg.payload !== null && AGENT_AUDIENCE_TYPES.has(msg.type)) {
			lines.push(`Payload: ${msg.payload}`);
		}
		lines.push(`[Reply with: legio mail reply ${msg.id} --body "..."]`);
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Open a mail store connected to the project's mail.db.
 * The cwd must already be resolved to the canonical project root.
 */
function openStore(cwd: string) {
	const dbPath = join(cwd, ".legio", "mail.db");
	return createMailStore(dbPath);
}

// === Pending Nudge Markers ===
//
// Instead of sending tmux keys (which corrupt tool I/O), auto-nudge writes
// a JSON marker file per agent. The `mail check --inject` flow reads and
// clears these markers, prepending a priority banner to the injected output.

/** Directory where pending nudge markers are stored. */
function pendingNudgeDir(cwd: string): string {
	return join(cwd, ".legio", "pending-nudges");
}

/**
 * Check if an agent is idle (not actively executing a tool).
 *
 * An agent is considered idle when `.legio/agent-busy/{agentName}` does NOT exist
 * or when the marker is stale (older than 5 minutes, indicating a crashed agent).
 * The busy marker contains an ISO timestamp written by hooks during active tool execution.
 * Idle agents can receive a direct tmux nudge; busy agents only get the pending marker.
 */
async function isAgentIdle(cwd: string, agentName: string): Promise<boolean> {
	const busyPath = join(cwd, ".legio", "agent-busy", agentName);
	try {
		const timestamp = await readFile(busyPath, "utf-8");
		const age = Date.now() - new Date(timestamp.trim()).getTime();
		if (age > 5 * 60 * 1000) {
			// Stale marker from crashed agent — clean up
			await unlink(busyPath).catch(() => {});
			return true;
		}
		return false; // busy marker present and fresh — agent is actively working
	} catch {
		return true; // no busy marker — agent is idle
	}
}

/** Shape of a pending nudge marker file. */
interface PendingNudge {
	from: string;
	reason: string;
	subject: string;
	messageId: string;
	createdAt: string;
}

/**
 * Write a pending nudge marker for an agent.
 *
 * Creates `.legio/pending-nudges/{agent}.json` so that the next
 * `mail check --inject` call surfaces a priority banner for this message.
 * Overwrites any existing marker (only the latest nudge matters).
 */
async function writePendingNudge(
	cwd: string,
	agentName: string,
	nudge: Omit<PendingNudge, "createdAt">,
): Promise<void> {
	const dir = pendingNudgeDir(cwd);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });

	const marker: PendingNudge = {
		...nudge,
		createdAt: new Date().toISOString(),
	};
	const filePath = join(dir, `${agentName}.json`);
	const tmpPath = `${filePath}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(marker, null, "\t")}\n`);
	await rename(tmpPath, filePath);
}

/**
 * Read and clear pending nudge markers for an agent.
 *
 * Returns the pending nudge (if any) and removes the marker file.
 * Called by `mail check --inject` to prepend a priority banner.
 */
async function readAndClearPendingNudge(
	cwd: string,
	agentName: string,
): Promise<PendingNudge | null> {
	const filePath = join(pendingNudgeDir(cwd), `${agentName}.json`);
	try {
		await access(filePath);
	} catch {
		return null;
	}
	try {
		const text = await readFile(filePath, "utf-8");
		const nudge = JSON.parse(text) as PendingNudge;
		const { unlink } = await import("node:fs/promises");
		await unlink(filePath);
		return nudge;
	} catch {
		// Corrupt or race condition — clear it and move on
		try {
			const { unlink } = await import("node:fs/promises");
			await unlink(filePath);
		} catch {
			// Already gone
		}
		return null;
	}
}

/**
 * Open a mail client connected to the project's mail.db.
 * The cwd must already be resolved to the canonical project root.
 */
function openClient(cwd: string) {
	const store = openStore(cwd);
	const client = createMailClient(store);
	return client;
}

/** legio mail send */
async function handleSend(args: string[], cwd: string): Promise<void> {
	const to = getFlag(args, "--to");
	const subject = getFlag(args, "--subject");
	const body = getFlag(args, "--body");
	const from = getFlag(args, "--agent") ?? getFlag(args, "--from") ?? "orchestrator";
	const rawPayload = getFlag(args, "--payload");
	const VALID_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

	const rawType = getFlag(args, "--type") ?? "status";
	const rawPriority = getFlag(args, "--priority") ?? "normal";

	if (!MAIL_MESSAGE_TYPES.includes(rawType as MailMessage["type"])) {
		throw new ValidationError(
			`Invalid --type "${rawType}". Must be one of: ${MAIL_MESSAGE_TYPES.join(", ")}`,
			{ field: "type", value: rawType },
		);
	}
	if (!VALID_PRIORITIES.includes(rawPriority as MailMessage["priority"])) {
		throw new ValidationError(
			`Invalid --priority "${rawPriority}". Must be one of: ${VALID_PRIORITIES.join(", ")}`,
			{ field: "priority", value: rawPriority },
		);
	}

	const type = rawType as MailMessage["type"];
	let priority = rawPriority as MailMessage["priority"];

	// escalation and dispatch default to high priority when no explicit --priority was given
	const HIGH_PRIORITY_DEFAULT_TYPES = new Set(["escalation", "dispatch"]);
	const explicitPriority = getFlag(args, "--priority") !== undefined;
	if (!explicitPriority && HIGH_PRIORITY_DEFAULT_TYPES.has(type)) {
		priority = "high";
	}

	// Parse --audience flag (optional, auto-derived from type if not specified)
	const rawAudience = getFlag(args, "--audience");
	let audience: MailAudience;
	if (rawAudience !== undefined) {
		if (!(VALID_AUDIENCES as readonly string[]).includes(rawAudience)) {
			throw new ValidationError(
				`Invalid --audience "${rawAudience}". Must be one of: ${VALID_AUDIENCES.join(", ")}`,
				{ field: "audience", value: rawAudience },
			);
		}
		audience = rawAudience as MailAudience;
	} else {
		// Auto-derive: protocol types -> "agent", semantic types -> "both"
		audience = AGENT_AUDIENCE_TYPES.has(type) ? "agent" : "both";
	}

	// Validate JSON payload if provided
	let payload: string | undefined;
	if (rawPayload !== undefined) {
		try {
			JSON.parse(rawPayload);
			payload = rawPayload;
		} catch {
			throw new ValidationError("--payload must be valid JSON", {
				field: "payload",
				value: rawPayload,
			});
		}
	}

	if (!to) {
		throw new ValidationError("--to is required for mail send", { field: "to" });
	}
	if (!subject) {
		throw new ValidationError("--subject is required for mail send", { field: "subject" });
	}
	if (!body) {
		throw new ValidationError("--body is required for mail send", { field: "body" });
	}

	// audience field will be added to MailClient.send() by schema-lead (legio-9c89).
	// Cast to pass audience through until the interface is updated.
	type SendWithAudience = (msg: {
		from: string;
		to: string;
		subject: string;
		body: string;
		type?: MailMessage["type"];
		priority?: MailMessage["priority"];
		threadId?: string;
		payload?: string;
		audience?: string;
	}) => string;

	// Handle broadcast messages (group addresses)
	if (isGroupAddress(to)) {
		const legioDir = join(cwd, ".legio");
		const { store: sessionStore } = openSessionStore(legioDir);

		try {
			const activeSessions = sessionStore.getActive();
			const recipients = resolveGroupAddress(to, activeSessions, from);

			const client = openClient(cwd);
			const messageIds: string[] = [];

			try {
				// Fan out: send individual message to each recipient
				for (const recipient of recipients) {
					const id = (client.send as SendWithAudience)({
						from,
						to: recipient,
						subject,
						body,
						type,
						priority,
						payload,
						audience,
					});
					messageIds.push(id);

					// Record mail_sent event for each individual message (fire-and-forget)
					try {
						const eventsDbPath = join(cwd, ".legio", "events.db");
						const eventStore = createEventStore(eventsDbPath);
						try {
							let runId: string | null = null;
							const runIdPath = join(cwd, ".legio", "current-run.txt");
							try {
								const text = await readFile(runIdPath, "utf-8");
								const trimmed = text.trim();
								if (trimmed.length > 0) {
									runId = trimmed;
								}
							} catch {
								/* file doesn't exist */
							}
							eventStore.insert({
								runId,
								agentName: from,
								sessionId: null,
								eventType: "mail_sent",
								toolName: null,
								toolArgs: null,
								toolDurationMs: null,
								level: "info",
								data: JSON.stringify({
									to: recipient,
									subject,
									type,
									priority,
									messageId: id,
									broadcast: true,
								}),
							});
						} finally {
							eventStore.close();
						}
					} catch {
						// Event recording failure is non-fatal
					}

					// Auto-nudge for each individual message (always fire for all types/priorities)
					const nudgeReason = type;
					await writePendingNudge(cwd, recipient, {
						from,
						reason: nudgeReason,
						subject,
						messageId: id,
					});
					// Smart push: if recipient is idle, also deliver direct tmux nudge
					if (await isAgentIdle(cwd, recipient)) {
						await nudgeAgent(
							cwd,
							recipient,
							`[mail from ${from}] ${nudgeReason}: ${subject}`,
							true,
						).catch(() => {
							/* non-fatal: pending marker is the reliable path */
						});
					}
				}
			} finally {
				client.close();
			}

			// Output broadcast summary
			if (hasFlag(args, "--json")) {
				process.stdout.write(
					`${JSON.stringify({ messageIds, recipientCount: recipients.length })}\n`,
				);
			} else {
				process.stdout.write(
					`📢 Broadcast sent to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"} (${to})\n`,
				);
				for (let i = 0; i < recipients.length; i++) {
					const recipient = recipients[i];
					const msgId = messageIds[i];
					process.stdout.write(`   → ${recipient} (${msgId})\n`);
				}
			}

			return; // Early return — broadcast handled
		} finally {
			sessionStore.close();
		}
	}

	// Single-recipient message (existing logic)
	const client = openClient(cwd);
	try {
		const id = (client.send as SendWithAudience)({
			from,
			to,
			subject,
			body,
			type,
			priority,
			payload,
			audience,
		});

		// Record mail_sent event to EventStore (fire-and-forget)
		try {
			const eventsDbPath = join(cwd, ".legio", "events.db");
			const eventStore = createEventStore(eventsDbPath);
			try {
				let runId: string | null = null;
				const runIdPath = join(cwd, ".legio", "current-run.txt");
				try {
					const text = await readFile(runIdPath, "utf-8");
					const trimmed = text.trim();
					if (trimmed.length > 0) {
						runId = trimmed;
					}
				} catch {
					/* file doesn't exist */
				}
				eventStore.insert({
					runId,
					agentName: from,
					sessionId: null,
					eventType: "mail_sent",
					toolName: null,
					toolArgs: null,
					toolDurationMs: null,
					level: "info",
					data: JSON.stringify({ to, subject, type, priority, messageId: id }),
				});
			} finally {
				eventStore.close();
			}
		} catch {
			// Event recording failure is non-fatal
		}

		if (hasFlag(args, "--json")) {
			process.stdout.write(`${JSON.stringify({ id })}\n`);
		} else {
			process.stdout.write(`✉️  Sent message ${id} to ${to}\n`);
		}

		// Auto-nudge: write a pending nudge marker instead of sending tmux keys.
		// Direct tmux sendKeys during tool execution corrupts the agent's I/O,
		// causing SIGKILL (exit 137) and "request interrupted" errors (legio-ii1o).
		// The message is already in the DB — the UserPromptSubmit hook's
		// `mail check --inject` will surface it on the next prompt cycle.
		// Auto-nudge fires for ALL message types and priorities — no type/priority gate.
		// The nudge mechanism has debounce protection to prevent rapid-fire nudges.
		const nudgeReason = type;
		await writePendingNudge(cwd, to, {
			from,
			reason: nudgeReason,
			subject,
			messageId: id,
		});
		// Smart push: if recipient is idle, also deliver direct tmux nudge
		if (await isAgentIdle(cwd, to)) {
			await nudgeAgent(cwd, to, `[mail from ${from}] ${nudgeReason}: ${subject}`, true).catch(
				() => {
					/* non-fatal: pending marker is the reliable path */
				},
			);
		}
		if (!hasFlag(args, "--json")) {
			process.stdout.write(
				`📢 Queued nudge for "${to}" (${nudgeReason}, delivered on next prompt)\n`,
			);
		}
		// Reviewer coverage check for merge_ready (advisory warning)
		if (type === "merge_ready") {
			try {
				const legioDir = join(cwd, ".legio");
				const { store: sessionStore } = openSessionStore(legioDir);
				try {
					const allSessions = sessionStore.getAll();
					const myBuilders = allSessions.filter(
						(s) => s.parentAgent === from && s.capability === "builder",
					);
					const myReviewers = allSessions.filter(
						(s) => s.parentAgent === from && s.capability === "reviewer",
					);
					if (myBuilders.length > 0 && myReviewers.length === 0) {
						process.stderr.write(
							`\n⚠️  WARNING: merge_ready sent but NO reviewer sessions found for "${from}".\n` +
								`⚠️  ${myBuilders.length} builder(s) completed without review. This violates the review-before-merge requirement.\n` +
								`⚠️  Spawn reviewers for each builder before merge. See REVIEW_SKIP in agents/lead.md.\n\n`,
						);
					} else if (myReviewers.length > 0 && myReviewers.length < myBuilders.length) {
						process.stderr.write(
							`\n⚠️  NOTE: Only ${myReviewers.length} reviewer(s) for ${myBuilders.length} builder(s). Ensure all builder work is review-verified.\n\n`,
						);
					}
				} finally {
					sessionStore.close();
				}
			} catch {
				// Reviewer check failure is non-fatal — do not block mail send
			}
		}
	} finally {
		client.close();
	}
}

/** legio mail check */
async function handleCheck(args: string[], cwd: string): Promise<void> {
	const agent = getFlag(args, "--agent") ?? "orchestrator";
	const inject = hasFlag(args, "--inject");
	const json = hasFlag(args, "--json");
	const signal = hasFlag(args, "--signal");
	const audience = getFlag(args, "--audience");

	// --debounce is deprecated (no-op). Accept silently for backward compat.
	// The --signal flag replaces debounce — signal files are the authoritative trigger.
	if (getFlag(args, "--debounce") !== undefined) {
		process.stderr.write(
			"⚠️  --debounce is deprecated and ignored. Use --signal for signal-gated mail checks.\n",
		);
	}

	if (audience !== undefined && !(VALID_AUDIENCES as readonly string[]).includes(audience)) {
		throw new ValidationError(
			`Invalid --audience "${audience}". Must be one of: ${VALID_AUDIENCES.join(", ")}`,
			{ field: "audience", value: audience },
		);
	}

	// Signal-gated mode: skip DB query entirely if no signal file exists.
	// The signal file is the pending nudge marker written by `mail send`.
	if (signal) {
		const signalPath = join(pendingNudgeDir(cwd), `${agent}.json`);
		try {
			await access(signalPath);
		} catch {
			// No signal file — no new mail. Exit immediately (zero cost).
			return;
		}
	}

	const client = openClient(cwd);
	try {
		if (inject) {
			// Check for pending nudge markers (written by auto-nudge instead of tmux keys)
			const pendingNudge = await readAndClearPendingNudge(cwd, agent);
			let injectOutput: string;

			if (audience !== undefined) {
				// Audience-filtered inject: use store directly to mark only filtered messages as read.
				// This prevents silently consuming messages intended for a different audience.
				const store = openStore(cwd);
				try {
					const allUnread = store.getUnread(agent);
					const filtered = allUnread.filter((m) => m.audience === audience);
					for (const msg of filtered) {
						store.markRead(msg.id);
					}
					injectOutput = formatMessagesForInjection(filtered);
				} finally {
					store.close();
				}
			} else {
				injectOutput = client.checkInject(agent);
			}

			// Prepend a priority banner if there's a pending nudge
			if (pendingNudge) {
				const banner = `🚨 PRIORITY: ${pendingNudge.reason} message from ${pendingNudge.from} — "${pendingNudge.subject}"\n\n`;
				process.stdout.write(banner);
			}

			if (injectOutput.length > 0) {
				process.stdout.write(injectOutput);
			}
		} else {
			let messages = client.check(agent);
			if (audience !== undefined) {
				messages = messages.filter((m) => m.audience === audience);
			}

			if (json) {
				process.stdout.write(`${JSON.stringify(messages)}\n`);
			} else if (messages.length === 0) {
				process.stdout.write("No new messages.\n");
			} else {
				process.stdout.write(
					`📬 ${messages.length} new message${messages.length === 1 ? "" : "s"}:\n\n`,
				);
				for (const msg of messages) {
					process.stdout.write(`${formatMessage(msg)}\n\n`);
				}
			}
		}
	} finally {
		client.close();
	}
}

/** legio mail list */
function handleList(args: string[], cwd: string): void {
	const from = getFlag(args, "--from");
	// --agent is an alias for --to, providing agent-scoped perspective (like mail check)
	const to = getFlag(args, "--to") ?? getFlag(args, "--agent");
	const unread = hasFlag(args, "--unread") ? true : undefined;
	const json = hasFlag(args, "--json");
	const audience = getFlag(args, "--audience");
	if (audience !== undefined && !(VALID_AUDIENCES as readonly string[]).includes(audience)) {
		throw new ValidationError(
			`Invalid --audience "${audience}". Must be one of: ${VALID_AUDIENCES.join(", ")}`,
			{ field: "audience", value: audience },
		);
	}

	const client = openClient(cwd);
	try {
		const messages = client.list({ from, to, unread, audience });

		if (json) {
			process.stdout.write(`${JSON.stringify(messages)}\n`);
		} else if (messages.length === 0) {
			process.stdout.write("No messages found.\n");
		} else {
			for (const msg of messages) {
				process.stdout.write(`${formatMessage(msg)}\n\n`);
			}
			process.stdout.write(
				`Total: ${messages.length} message${messages.length === 1 ? "" : "s"}\n`,
			);
		}
	} finally {
		client.close();
	}
}

/** legio mail read */
function handleRead(args: string[], cwd: string): void {
	const positional = getPositionalArgs(args);
	const id = positional[0];
	if (!id) {
		throw new ValidationError("Message ID is required for mail read", { field: "id" });
	}

	const client = openClient(cwd);
	try {
		const { alreadyRead } = client.markRead(id);
		if (alreadyRead) {
			process.stdout.write(`Message ${id} was already read.\n`);
		} else {
			process.stdout.write(`Marked ${id} as read.\n`);
		}
	} finally {
		client.close();
	}
}

/** legio mail reply */
function handleReply(args: string[], cwd: string): void {
	const positional = getPositionalArgs(args);
	const id = positional[0];
	const body = getFlag(args, "--body");
	const from = getFlag(args, "--agent") ?? getFlag(args, "--from") ?? "orchestrator";

	if (!id) {
		throw new ValidationError("Message ID is required for mail reply", { field: "id" });
	}
	if (!body) {
		throw new ValidationError("--body is required for mail reply", { field: "body" });
	}

	const client = openClient(cwd);
	try {
		const replyId = client.reply(id, body, from);

		if (hasFlag(args, "--json")) {
			process.stdout.write(`${JSON.stringify({ id: replyId })}\n`);
		} else {
			process.stdout.write(`✉️  Reply sent: ${replyId}\n`);
		}
	} finally {
		client.close();
	}
}

/** legio mail purge */
function handlePurge(args: string[], cwd: string): void {
	const all = hasFlag(args, "--all");
	const daysStr = getFlag(args, "--days");
	const agent = getFlag(args, "--agent");
	const json = hasFlag(args, "--json");

	if (!all && daysStr === undefined && agent === undefined) {
		throw new ValidationError(
			"mail purge requires at least one filter: --all, --days <n>, or --agent <name>",
			{ field: "purge" },
		);
	}

	let olderThanMs: number | undefined;
	if (daysStr !== undefined) {
		const days = Number.parseInt(daysStr, 10);
		if (Number.isNaN(days) || days <= 0) {
			throw new ValidationError("--days must be a positive integer", {
				field: "days",
				value: daysStr,
			});
		}
		olderThanMs = days * 24 * 60 * 60 * 1000;
	}

	const store = openStore(cwd);
	try {
		const purged = store.purge({ all, olderThanMs, agent });

		if (json) {
			process.stdout.write(`${JSON.stringify({ purged })}\n`);
		} else {
			process.stdout.write(`Purged ${purged} message${purged === 1 ? "" : "s"}.\n`);
		}
	} finally {
		store.close();
	}
}

/**
 * Entry point for `legio mail <subcommand> [args...]`.
 *
 * Subcommands: send, check, list, read, reply, purge.
 */
const MAIL_HELP = `legio mail — Agent messaging system

Usage: legio mail <subcommand> [args...]

Subcommands:
  send     Send a message
             --to <agent>  --subject <text>  --body <text>
             [--from <name>] [--agent <name> (alias for --from)]
             [--type <type>] [--priority <low|normal|high|urgent>]
             [--audience <human|agent|both>]
             [--payload <json>] [--json]
           Types: status, question, result, error (semantic)
                  worker_done, merge_ready, merged, merge_failed,
                  escalation, health_check, dispatch, assign (protocol)
           Audience: defaults to 'agent' for protocol types, 'both' for semantic types
  check    Check inbox (unread messages)
             [--agent <name>] [--audience <human|agent|both>]
             [--inject] [--signal] [--json]
  list     List messages with filters
             [--from <name>] [--to <name>] [--agent <name> (alias for --to)]
             [--audience <human|agent|both>] [--unread] [--json]
  read     Mark a message as read
             <message-id>
  reply    Reply to a message
             <message-id> --body <text> [--from <name>]
             [--agent <name> (alias for --from)] [--json]
  purge    Delete old messages
             --all | --days <n> | --agent <name>
             [--json]

Options:
  --help, -h   Show this help`;

export async function mailCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${MAIL_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	// Resolve the actual project root (handles git worktrees).
	// Mail commands may run from agent worktrees via hooks, so we must
	// resolve up to the main project root where .legio/mail.db lives.
	const root = await resolveProjectRoot(process.cwd());

	switch (subcommand) {
		case "send":
			await handleSend(subArgs, root);
			break;
		case "check":
			await handleCheck(subArgs, root);
			break;
		case "list":
			handleList(subArgs, root);
			break;
		case "read":
			handleRead(subArgs, root);
			break;
		case "reply":
			handleReply(subArgs, root);
			break;
		case "purge":
			handlePurge(subArgs, root);
			break;
		default:
			throw new MailError(
				`Unknown mail subcommand: ${subcommand ?? "(none)"}. Use: send, check, list, read, reply, purge`,
			);
	}
}
