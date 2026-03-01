/**
 * Tier 0 mechanical process monitoring daemon.
 *
 * Runs on a configurable interval, checking the health of all active agent
 * sessions. Detects zombie agents (dead tmux or process) and attempts
 * auto-recovery from checkpoints.
 *
 * Phase 4 tier numbering:
 *   Tier 0 = Mechanical daemon (this file)
 *   Tier 1 = Triage agent (triage.ts)
 *   Tier 2 = Monitor agent (not yet implemented)
 *   Tier 3 = Supervisor monitors (per-project)
 *
 * ZFC Principle: Observable state (tmux alive, pid alive) is the source of
 * truth. See health.ts for the full ZFC documentation.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCheckpoint } from "../agents/checkpoint.ts";
import { loadConfig } from "../config.ts";
import { createEventStore } from "../events/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, EventStore, HealthCheck, SessionCheckpoint } from "../types.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";
import { evaluateHealth, transitionState } from "./health.ts";

/**
 * Record an agent failure to mulch for future reference.
 * Fire-and-forget: never throws, logs errors internally if mulch fails.
 *
 * @param root - Project root directory
 * @param session - The agent session that failed
 * @param reason - Human-readable failure reason
 * @param tier - Which watchdog tier detected the failure (0 or 1)
 * @param triageSuggestion - Optional triage verdict from Tier 1 AI analysis
 */
async function recordFailure(
	root: string,
	session: AgentSession,
	reason: string,
	tier: 0 | 1,
	triageSuggestion?: string,
): Promise<void> {
	try {
		const mulch = createMulchClient(root);
		const tierLabel = tier === 0 ? "Tier 0 (process death)" : "Tier 1 (AI triage)";
		const description = [
			`Agent: ${session.agentName}`,
			`Capability: ${session.capability}`,
			`Failure reason: ${reason}`,
			triageSuggestion ? `Triage suggestion: ${triageSuggestion}` : null,
			`Detected by: ${tierLabel}`,
		]
			.filter((line) => line !== null)
			.join("\n");

		await mulch.record("agents", {
			type: "failure",
			description,
			tags: ["watchdog", "auto-recorded"],
			evidenceBead: session.beadId || undefined,
		});
	} catch {
		// Fire-and-forget: recording failures must not break the watchdog
	}
}

/**
 * Read the current run ID from current-run.txt, or null if no active run.
 */
async function readCurrentRunId(legioDir: string): Promise<string | null> {
	const path = join(legioDir, "current-run.txt");
	try {
		const text = await readFile(path, "utf-8");
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Fire-and-forget: record an event to EventStore. Never throws.
 */
function recordEvent(
	eventStore: EventStore | null,
	event: {
		runId: string | null;
		agentName: string;
		eventType: "custom" | "mail_sent";
		level: "debug" | "info" | "warn" | "error";
		data: Record<string, unknown>;
	},
): void {
	if (!eventStore) return;
	try {
		eventStore.insert({
			runId: event.runId,
			agentName: event.agentName,
			sessionId: null,
			eventType: event.eventType,
			toolName: null,
			toolArgs: null,
			toolDurationMs: null,
			level: event.level,
			data: JSON.stringify(event.data),
		});
	} catch {
		// Fire-and-forget: event recording must never break the daemon
	}
}

/**
 * Read the recovery attempt count for an agent from disk.
 * Returns 0 if the file doesn't exist.
 */
async function readRecoveryCount(agentsDir: string, agentName: string): Promise<number> {
	try {
		const text = await readFile(join(agentsDir, agentName, "recovery-count"), "utf-8");
		return parseInt(text.trim(), 10) || 0;
	} catch {
		return 0;
	}
}

/**
 * Write the recovery attempt count for an agent to disk.
 * Creates the directory if it doesn't exist.
 */
async function writeRecoveryCount(
	agentsDir: string,
	agentName: string,
	count: number,
): Promise<void> {
	const dir = join(agentsDir, agentName);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "recovery-count"), String(count), "utf-8");
}

/**
 * Default sling implementation: spawn `legio sling` as a subprocess.
 */
async function reSling(
	args: string[],
	root: string,
): Promise<{ exitCode: number; stderr: string }> {
	return new Promise((resolve) => {
		const proc = spawn("legio", ["sling", ...args], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
	});
}

/**
 * Default recovery mail implementation: spawn `legio mail send` as a subprocess.
 */
async function sendMailSubprocess(args: string[], root: string): Promise<void> {
	return new Promise((resolve) => {
		const proc = spawn("legio", ["mail", "send", ...args], {
			cwd: root,
			stdio: ["ignore", "ignore", "ignore"],
		});
		proc.on("close", () => resolve());
	});
}

/**
 * Attempt to auto-recover a dead agent from its checkpoint by re-slinging it.
 *
 * @returns `{ recovered: true }` if sling succeeded, `{ recovered: false }` otherwise.
 */
async function attemptRecovery(options: {
	session: AgentSession;
	legioDir: string;
	root: string;
	maxRecoveryAttempts: number;
	eventStore: EventStore | null;
	runId: string | null;
	sling: (args: string[]) => Promise<{ exitCode: number; stderr: string }>;
	loadCheckpointFn: (agentsDir: string, agentName: string) => Promise<SessionCheckpoint | null>;
	sendRecoveryMail: (args: string[]) => Promise<void>;
}): Promise<{ recovered: boolean }> {
	const {
		session,
		legioDir,
		maxRecoveryAttempts,
		eventStore,
		runId,
		sling,
		loadCheckpointFn,
		sendRecoveryMail,
	} = options;
	const agentsDir = join(legioDir, "agents");

	// Load checkpoint — if none exists, recovery is not possible
	let checkpoint: SessionCheckpoint | null = null;
	try {
		checkpoint = await loadCheckpointFn(agentsDir, session.agentName);
	} catch {
		return { recovered: false };
	}

	if (!checkpoint) {
		return { recovered: false };
	}

	// Check retry count — if exhausted, send escalation mail and bail
	const recoveryCount = await readRecoveryCount(agentsDir, session.agentName);
	if (recoveryCount >= maxRecoveryAttempts) {
		if (session.parentAgent) {
			try {
				await sendRecoveryMail([
					"--to",
					session.parentAgent,
					"--subject",
					`Recovery failed: ${session.agentName}`,
					"--body",
					`Auto-recovery exhausted for ${session.agentName} after ${recoveryCount} attempts. Agent marked zombie.`,
					"--type",
					"error",
					"--priority",
					"high",
					"--from",
					"watchdog",
				]);
			} catch {
				// Fire-and-forget: mail failure must not break the watchdog
			}
		}
		return { recovered: false };
	}

	// Increment recovery count before attempting
	try {
		await writeRecoveryCount(agentsDir, session.agentName, recoveryCount + 1);
	} catch {
		// Non-fatal: proceed with recovery even if count write fails
	}

	const attempt = recoveryCount + 1;

	// Record recovery_attempt event
	recordEvent(eventStore, {
		runId,
		agentName: session.agentName,
		eventType: "custom",
		level: "info",
		data: { type: "recovery_attempt", attempt, maxAttempts: maxRecoveryAttempts },
	});

	// Send mail to parent notifying of recovery attempt
	if (session.parentAgent) {
		try {
			await sendRecoveryMail([
				"--to",
				session.parentAgent,
				"--subject",
				`Recovery: ${session.agentName}`,
				"--body",
				`Watchdog attempting auto-recovery from checkpoint for ${session.agentName} (attempt ${attempt}/${maxRecoveryAttempts}).`,
				"--type",
				"health_check",
				"--from",
				"watchdog",
			]);
		} catch {
			// Fire-and-forget: mail failure must not break the watchdog
		}
	}

	// Build sling args from checkpoint + session
	const specPath = join(legioDir, "specs", `${checkpoint.beadId}.md`);
	const slingArgs: string[] = [
		checkpoint.beadId,
		"--capability",
		session.capability,
		"--name",
		session.agentName,
		"--spec",
		specPath,
	];

	if (checkpoint.filesModified.length > 0) {
		slingArgs.push("--files", checkpoint.filesModified.join(","));
	}

	if (session.parentAgent) {
		slingArgs.push("--parent", session.parentAgent);
	}

	slingArgs.push("--depth", String(session.depth));

	// Attempt sling subprocess
	try {
		const result = await sling(slingArgs);
		if (result.exitCode === 0) {
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "info",
				data: { type: "recovery_success", attempt },
			});
			return { recovered: true };
		}

		recordEvent(eventStore, {
			runId,
			agentName: session.agentName,
			eventType: "custom",
			level: "error",
			data: { type: "recovery_failed", attempt, stderr: result.stderr },
		});
		return { recovered: false };
	} catch {
		recordEvent(eventStore, {
			runId,
			agentName: session.agentName,
			eventType: "custom",
			level: "error",
			data: { type: "recovery_failed", attempt },
		});
		return { recovered: false };
	}
}

/**
 * List all tmux session names that match a given prefix.
 * Returns an empty array if tmux is not running or returns no sessions.
 */
async function listTmuxSessions(prefix: string): Promise<string[]> {
	return new Promise((resolve) => {
		const proc = spawn("tmux", ["list-sessions", "-F", "#{session_name}"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				resolve([]);
				return;
			}
			const sessions = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && line.startsWith(prefix));
			resolve(sessions);
		});
		proc.on("error", () => resolve([]));
	});
}

/** Options shared between startDaemon and runDaemonTick. */
export interface DaemonOptions {
	root: string;
	zombieThresholdMs: number;
	onHealthCheck?: (check: HealthCheck) => void;
	/** Dependency injection for testing. Uses real implementations when omitted. */
	_tmux?: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	/** Dependency injection for testing. Overrides EventStore creation. */
	_eventStore?: EventStore | null;
	/** Dependency injection for testing. Uses real recordFailure when omitted. */
	_recordFailure?: (
		root: string,
		session: AgentSession,
		reason: string,
		tier: 0 | 1,
		triageSuggestion?: string,
	) => Promise<void>;
	/** Max recovery attempts per agent before escalating (default: 1). */
	maxRecoveryAttempts?: number;
	/** DI for testing. Overrides sling subprocess spawn. */
	_sling?: (args: string[]) => Promise<{ exitCode: number; stderr: string }>;
	/** DI for testing. Overrides checkpoint loading. */
	_loadCheckpoint?: (agentsDir: string, agentName: string) => Promise<SessionCheckpoint | null>;
	/** DI for testing. Overrides mail sending for recovery notifications. */
	_sendRecoveryMail?: (args: string[]) => Promise<void>;
	/**
	 * Boot timeout in milliseconds for agents stuck in booting state (default: 90000).
	 * When an agent has been in the "booting" state longer than this threshold,
	 * it is treated as a zombie and an urgent alert is sent to its parent.
	 */
	bootTimeoutMs?: number;
	/** DI for testing. Overrides tmux session listing for unregistered agent detection. */
	_listTmuxSessions?: (prefix: string) => Promise<string[]>;
	/** DI for testing. Overrides project name lookup (bypasses loadConfig). */
	_projectName?: string;
}

/**
 * Start the watchdog daemon that periodically monitors agent health.
 *
 * On each tick:
 * 1. Loads sessions from SessionStore (sessions.db)
 * 2. For each session (including zombies — ZFC requires re-checking observable
 *    state), checks tmux liveness and evaluates health
 * 3. For "terminate" actions: kills tmux session immediately
 * 4. For "investigate" actions: surfaces via onHealthCheck, no auto-kill
 * 5. For "escalate" actions: applies progressive nudging based on escalationLevel
 * 6. Persists updated session states back to SessionStore
 *
 * @param options.root - Project root directory (contains .legio/)
 * @param options.intervalMs - Polling interval in milliseconds
 * @param options.zombieThresholdMs - Time after which an agent is considered a zombie
 * @param options.onHealthCheck - Optional callback for each health check result
 * @returns An object with a `stop` function to halt the daemon
 */
export function startDaemon(options: DaemonOptions & { intervalMs: number }): { stop: () => void } {
	const { intervalMs } = options;

	// Run the first tick immediately, then on interval
	runDaemonTick(options).catch(() => {
		// Swallow errors in the first tick — daemon must not crash
	});

	const interval = setInterval(() => {
		runDaemonTick(options).catch(() => {
			// Swallow errors in periodic ticks — daemon must not crash
		});
	}, intervalMs);

	return {
		stop(): void {
			clearInterval(interval);
		},
	};
}

/**
 * Run a single daemon tick. Exported for testing — allows direct invocation
 * of the monitoring logic without starting the interval-based daemon loop.
 *
 * @param options - Same options as startDaemon (minus intervalMs)
 */
export async function runDaemonTick(options: DaemonOptions): Promise<void> {
	const { root, zombieThresholdMs, onHealthCheck } = options;
	const tmux = options._tmux ?? { isSessionAlive, killSession };
	const recordFailureFn = options._recordFailure ?? recordFailure;
	const maxRecoveryAttempts = options.maxRecoveryAttempts ?? 1;
	const slingFn = options._sling ?? ((args: string[]) => reSling(args, root));
	const loadCheckpointFn = options._loadCheckpoint ?? loadCheckpoint;
	const sendRecoveryMailFn =
		options._sendRecoveryMail ?? ((args: string[]) => sendMailSubprocess(args, root));

	const legioDir = join(root, ".legio");
	const { store } = openSessionStore(legioDir);

	// Open EventStore for recording daemon events (fire-and-forget)
	let eventStore: EventStore | null = null;
	let runId: string | null = null;
	const useInjectedEventStore = options._eventStore !== undefined;
	if (useInjectedEventStore) {
		eventStore = options._eventStore ?? null;
	} else {
		try {
			const eventsDbPath = join(legioDir, "events.db");
			eventStore = createEventStore(eventsDbPath);
		} catch {
			// EventStore creation failure is non-fatal for the daemon
		}
	}
	try {
		runId = await readCurrentRunId(legioDir);
	} catch {
		// Reading run ID failure is non-fatal
	}

	try {
		const thresholds = {
			zombieMs: zombieThresholdMs,
		};

		const sessions = store.getAll();

		for (const session of sessions) {
			// Skip completed sessions — they are terminal and don't need monitoring
			if (session.state === "completed") {
				continue;
			}

			// ZFC: Don't skip zombies. Re-check tmux liveness on every tick.
			// A zombie with a live tmux session needs investigation, not silence.

			const tmuxAlive = await tmux.isSessionAlive(session.tmuxSession);
			const check = evaluateHealth(session, tmuxAlive, thresholds);

			// Boot timeout detection: agent stuck in booting state beyond threshold.
			// Fires when tmux is alive (the session started) but the agent never
			// transitioned out of "booting" within the allowed window.
			if (session.state === "booting" && tmuxAlive) {
				const bootElapsed = Date.now() - new Date(session.startedAt).getTime();
				const bootTimeoutMs = options.bootTimeoutMs ?? 90_000;
				if (bootElapsed > bootTimeoutMs) {
					const notifyTarget = session.parentAgent ?? "coordinator";
					try {
						await sendRecoveryMailFn([
							"--to",
							notifyTarget,
							"--subject",
							`Boot timeout: ${session.agentName}`,
							"--body",
							`Agent ${session.agentName} stuck in booting state for ${Math.round(bootElapsed / 1000)}s (threshold: ${Math.round(bootTimeoutMs / 1000)}s). Marking zombie.`,
							"--type",
							"error",
							"--priority",
							"urgent",
							"--from",
							"watchdog",
						]);
					} catch {
						// Fire-and-forget: mail failure must not break the watchdog
					}
					recordEvent(eventStore, {
						runId,
						agentName: session.agentName,
						eventType: "custom",
						level: "warn",
						data: { type: "boot_timeout", bootElapsedMs: bootElapsed, bootTimeoutMs },
					});
					store.updateState(session.agentName, "zombie");
					session.state = "zombie";
					if (onHealthCheck) {
						onHealthCheck(check);
					}
					continue;
				}
			}

			// Transition state forward only (investigate action holds state)
			const newState = transitionState(session.state, check);
			if (newState !== session.state) {
				store.updateState(session.agentName, newState);
				session.state = newState;
			}

			if (onHealthCheck) {
				onHealthCheck(check);
			}

			if (check.action === "terminate") {
				// Record the failure via mulch (Tier 0 detection)
				const reason = check.reconciliationNote ?? "Process terminated";
				await recordFailureFn(root, session, reason, 0);

				// Kill the tmux session if it's still alive
				if (tmuxAlive) {
					try {
						await tmux.killSession(session.tmuxSession);
					} catch {
						// Session may have died between check and kill — not an error
					}
				}

				// Attempt auto-recovery from checkpoint before marking zombie
				const { recovered } = await attemptRecovery({
					session,
					legioDir,
					root,
					maxRecoveryAttempts,
					eventStore,
					runId,
					sling: slingFn,
					loadCheckpointFn,
					sendRecoveryMail: sendRecoveryMailFn,
				});

				if (!recovered) {
					store.updateState(session.agentName, "zombie");
					// Reset escalation tracking on terminal state
					store.updateEscalation(session.agentName, 0, null);
					session.state = "zombie";
					session.escalationLevel = 0;
					session.stalledSince = null;
				} else {
					// Recovery succeeded — clear zombie state set by transitionState above
					store.updateState(session.agentName, "completed");
					store.updateEscalation(session.agentName, 0, null);
					session.state = "completed";
					session.escalationLevel = 0;
					session.stalledSince = null;
				}
			} else if (check.action === "investigate") {
				// ZFC: tmux alive but SessionStore says zombie.
				// Log the conflict but do NOT auto-kill.
				// The onHealthCheck callback surfaces this to the operator.
				// No state change — keep zombie until a human or higher-tier agent decides.
			}
		}

		// Unregistered agent detection: find tmux sessions with no DB registration.
		// Compares live tmux sessions against sessions.db. Sessions that appear in
		// tmux but not in the DB may be rogue processes or orphaned from a crash.
		// On first sighting, writes a marker file. On subsequent ticks, if the session
		// has been running unregistered for >3 minutes, sends an urgent alert.
		try {
			let projectName: string;
			if (options._projectName !== undefined) {
				projectName = options._projectName;
			} else {
				const config = await loadConfig(root);
				projectName = config.project.name;
			}
			const sessionPrefix = `legio-${projectName}-`;
			const listSessionsFn = options._listTmuxSessions ?? listTmuxSessions;
			const tmuxSessionNames = await listSessionsFn(sessionPrefix);

			// Build set of all registered tmux session names (including completed/zombie)
			const registeredTmuxSessions = new Set(sessions.map((s) => s.tmuxSession));

			// Persistent coordination agents are excluded — they may not always be in sessions.db
			const EXCLUDED_AGENTS = new Set(["coordinator", "gateway", "monitor"]);
			const unregisteredDir = join(legioDir, "unregistered-agents");

			for (const tmuxSession of tmuxSessionNames) {
				if (registeredTmuxSessions.has(tmuxSession)) continue;

				// Extract agent name by stripping the session prefix
				const agentName = tmuxSession.slice(sessionPrefix.length);
				if (EXCLUDED_AGENTS.has(agentName)) continue;

				const markerPath = join(unregisteredDir, `${agentName}.txt`);
				let firstSeenMs: number | null = null;
				try {
					const content = await readFile(markerPath, "utf-8");
					firstSeenMs = Number.parseInt(content.trim(), 10) || null;
				} catch {
					// Marker doesn't exist — first sighting: write the timestamp
					try {
						await mkdir(unregisteredDir, { recursive: true });
						await writeFile(markerPath, String(Date.now()), "utf-8");
					} catch {
						// Non-fatal: marker write failure
					}
					continue;
				}

				if (firstSeenMs !== null) {
					const elapsed = Date.now() - firstSeenMs;
					if (elapsed > 3 * 60 * 1000) {
						// Session has been unregistered for >3 minutes — send alert
						try {
							await sendRecoveryMailFn([
								"--to",
								"coordinator",
								"--subject",
								`Unregistered agent: ${agentName}`,
								"--body",
								`Tmux session ${tmuxSession} has been running for ${Math.round(elapsed / 60000)}min but is not registered in sessions.db. Possible zombie or rogue process.`,
								"--type",
								"error",
								"--priority",
								"urgent",
								"--from",
								"watchdog",
							]);
						} catch {
							// Fire-and-forget: mail failure must not break the watchdog
						}
						recordEvent(eventStore, {
							runId,
							agentName,
							eventType: "custom",
							level: "warn",
							data: { type: "unregistered_zombie", tmuxSession, elapsedMs: elapsed },
						});
						// Clean up the marker so we don't re-alert on every tick
						try {
							await unlink(markerPath);
						} catch {
							// Non-fatal: marker cleanup failure
						}
					}
				}
			}
		} catch {
			// Non-fatal: unregistered agent detection must not break the daemon
		}
	} finally {
		store.close();
		// Close EventStore only if we created it (not injected)
		if (eventStore && !useInjectedEventStore) {
			try {
				eventStore.close();
			} catch {
				// Non-fatal
			}
		}
	}
}
