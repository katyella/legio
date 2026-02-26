/**
 * Tier 0 mechanical process monitoring daemon.
 *
 * Runs on a configurable interval, checking the health of all active agent
 * sessions. Implements progressive nudging for stalled agents instead of
 * immediately escalating to AI triage:
 *
 *   Level 0 (warn):      Log warning via onHealthCheck callback, no direct action
 *   Level 1 (nudge):     Send tmux nudge via nudgeAgent()
 *   Level 2 (escalate):  Invoke Tier 1 AI triage (if tier1Enabled), else skip
 *   Level 3 (terminate): Kill tmux session
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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadCheckpoint } from "../agents/checkpoint.ts";
import { nudgeAgent } from "../commands/nudge.ts";
import { createEventStore } from "../events/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, EventStore, HealthCheck, SessionCheckpoint } from "../types.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";
import { evaluateHealth, transitionState } from "./health.ts";
import { triageAgent } from "./triage.ts";

/** Maximum escalation level (terminate). */
const MAX_ESCALATION_LEVEL = 3;

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
async function writeRecoveryCount(agentsDir: string, agentName: string, count: number): Promise<void> {
	const dir = join(agentsDir, agentName);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "recovery-count"), String(count), "utf-8");
}

/**
 * Default sling implementation: spawn `legio sling` as a subprocess.
 */
async function reSling(args: string[], root: string): Promise<{ exitCode: number; stderr: string }> {
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
			stdio: ["ignore", "pipe", "pipe"],
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
	const { session, legioDir, root, maxRecoveryAttempts, eventStore, runId, sling, loadCheckpointFn, sendRecoveryMail } =
		options;
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

/** Options shared between startDaemon and runDaemonTick. */
export interface DaemonOptions {
	root: string;
	staleThresholdMs: number;
	zombieThresholdMs: number;
	nudgeIntervalMs?: number;
	tier1Enabled?: boolean;
	onHealthCheck?: (check: HealthCheck) => void;
	/** Dependency injection for testing. Uses real implementations when omitted. */
	_tmux?: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	/** Dependency injection for testing. Uses real triageAgent when omitted. */
	_triage?: (options: {
		agentName: string;
		root: string;
		lastActivity: string;
	}) => Promise<"retry" | "terminate" | "extend">;
	/** Dependency injection for testing. Uses real nudgeAgent when omitted. */
	_nudge?: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
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
 * @param options.staleThresholdMs - Time after which an agent is considered stale
 * @param options.zombieThresholdMs - Time after which an agent is considered a zombie
 * @param options.nudgeIntervalMs - Time between progressive nudge stage transitions (default 60000)
 * @param options.tier1Enabled - Whether Tier 1 AI triage is enabled (default false)
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
	const {
		root,
		staleThresholdMs,
		zombieThresholdMs,
		nudgeIntervalMs = 60_000,
		tier1Enabled = false,
		onHealthCheck,
	} = options;
	const tmux = options._tmux ?? { isSessionAlive, killSession };
	const triage = options._triage ?? triageAgent;
	const nudge = options._nudge ?? nudgeAgent;
	const recordFailureFn = options._recordFailure ?? recordFailure;
	const maxRecoveryAttempts = options.maxRecoveryAttempts ?? 1;
	const slingFn = options._sling ?? ((args: string[]) => reSling(args, root));
	const loadCheckpointFn = options._loadCheckpoint ?? loadCheckpoint;
	const sendRecoveryMailFn = options._sendRecoveryMail ?? ((args: string[]) => sendMailSubprocess(args, root));

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
			staleMs: staleThresholdMs,
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
				}
			} else if (check.action === "investigate") {
				// ZFC: tmux alive but SessionStore says zombie.
				// Log the conflict but do NOT auto-kill.
				// The onHealthCheck callback surfaces this to the operator.
				// No state change — keep zombie until a human or higher-tier agent decides.
			} else if (check.action === "escalate") {
				// Progressive nudging: increment escalation level based on elapsed time
				// instead of immediately delegating to AI triage.

				// Initialize stalledSince on first escalation detection
				if (session.stalledSince === null) {
					session.stalledSince = new Date().toISOString();
					session.escalationLevel = 0;
					store.updateEscalation(session.agentName, 0, session.stalledSince);
				}

				// Check if enough time has passed to advance to the next escalation level
				const stalledMs = Date.now() - new Date(session.stalledSince).getTime();
				const expectedLevel = Math.min(
					Math.floor(stalledMs / nudgeIntervalMs),
					MAX_ESCALATION_LEVEL,
				);

				if (expectedLevel > session.escalationLevel) {
					session.escalationLevel = expectedLevel;
					store.updateEscalation(session.agentName, expectedLevel, session.stalledSince);
				}

				// Execute the action for the current escalation level
				const actionResult = await executeEscalationAction({
					session,
					root,
					legioDir,
					tmuxAlive,
					tier1Enabled,
					tmux,
					triage,
					nudge,
					eventStore,
					runId,
					recordFailure: recordFailureFn,
					maxRecoveryAttempts,
					sling: slingFn,
					loadCheckpointFn,
					sendRecoveryMailFn,
				});

				if (actionResult.terminated) {
					store.updateState(session.agentName, "zombie");
					store.updateEscalation(session.agentName, 0, null);
					session.state = "zombie";
					session.escalationLevel = 0;
					session.stalledSince = null;
				}
			} else if (check.action === "none" && session.stalledSince !== null) {
				// Agent recovered — reset escalation tracking
				store.updateEscalation(session.agentName, 0, null);
				session.stalledSince = null;
				session.escalationLevel = 0;
			}
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

/**
 * Execute the escalation action corresponding to the agent's current escalation level.
 *
 * Level 0 (warn):      No direct action — onHealthCheck callback already fired above.
 * Level 1 (nudge):     Send a tmux nudge to the agent.
 * Level 2 (escalate):  Invoke Tier 1 AI triage (if tier1Enabled; skip otherwise).
 * Level 3 (terminate): Kill the tmux session.
 *
 * @returns Object indicating whether the agent was terminated or state changed.
 */
async function executeEscalationAction(ctx: {
	session: AgentSession;
	root: string;
	legioDir: string;
	tmuxAlive: boolean;
	tier1Enabled: boolean;
	tmux: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	triage: (options: {
		agentName: string;
		root: string;
		lastActivity: string;
	}) => Promise<"retry" | "terminate" | "extend">;
	nudge: (
		projectRoot: string,
		agentName: string,
		message: string,
		force: boolean,
	) => Promise<{ delivered: boolean; reason?: string }>;
	eventStore: EventStore | null;
	runId: string | null;
	recordFailure: (
		root: string,
		session: AgentSession,
		reason: string,
		tier: 0 | 1,
		triageSuggestion?: string,
	) => Promise<void>;
	maxRecoveryAttempts: number;
	sling: (args: string[]) => Promise<{ exitCode: number; stderr: string }>;
	loadCheckpointFn: (agentsDir: string, agentName: string) => Promise<SessionCheckpoint | null>;
	sendRecoveryMailFn: (args: string[]) => Promise<void>;
}): Promise<{ terminated: boolean; stateChanged: boolean }> {
	const {
		session,
		root,
		legioDir,
		tmuxAlive,
		tier1Enabled,
		tmux,
		triage,
		nudge,
		eventStore,
		runId,
		recordFailure,
		maxRecoveryAttempts,
		sling,
		loadCheckpointFn,
		sendRecoveryMailFn,
	} = ctx;

	switch (session.escalationLevel) {
		case 0: {
			// Level 0: warn — onHealthCheck callback already fired, no direct action
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "escalation", escalationLevel: 0, action: "warn" },
			});
			return { terminated: false, stateChanged: false };
		}

		case 1: {
			// Level 1: nudge — send a tmux nudge to the agent
			let delivered = false;
			try {
				const result = await nudge(
					root,
					session.agentName,
					`[WATCHDOG] Agent "${session.agentName}" appears stalled. Please check your current task and report status.`,
					true, // force — skip debounce for watchdog nudges
				);
				delivered = result.delivered;
			} catch {
				// Nudge delivery failure is non-fatal for the watchdog
			}
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "nudge", escalationLevel: 1, delivered },
			});
			return { terminated: false, stateChanged: false };
		}

		case 2: {
			// Level 2: escalate — invoke Tier 1 AI triage if enabled
			if (!tier1Enabled) {
				// Tier 1 disabled — skip triage, progressive nudging continues to level 3
				return { terminated: false, stateChanged: false };
			}

			const verdict = await triage({
				agentName: session.agentName,
				root,
				lastActivity: session.lastActivity,
			});

			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "warn",
				data: { type: "triage", escalationLevel: 2, verdict },
			});

			if (verdict === "terminate") {
				// Record the failure via mulch (Tier 1 AI triage)
				await recordFailure(root, session, "AI triage classified as terminal failure", 1, verdict);

				if (tmuxAlive) {
					try {
						await tmux.killSession(session.tmuxSession);
					} catch {
						// Session may have died — not an error
					}
				}
				return { terminated: true, stateChanged: true };
			}

			if (verdict === "retry") {
				// Send a nudge with a recovery message
				try {
					await nudge(
						root,
						session.agentName,
						"[WATCHDOG] Triage suggests recovery is possible. " +
							"Please retry your current operation or check for errors.",
						true, // force — skip debounce
					);
				} catch {
					// Nudge delivery failure is non-fatal
				}
			}

			// "retry" (after nudge) and "extend" leave the session running
			return { terminated: false, stateChanged: false };
		}

		default: {
			// Level 3+: terminate — kill the tmux session
			recordEvent(eventStore, {
				runId,
				agentName: session.agentName,
				eventType: "custom",
				level: "error",
				data: { type: "escalation", escalationLevel: 3, action: "terminate" },
			});

			// Record the failure via mulch (Tier 0: progressive escalation to terminal level)
			await recordFailure(root, session, "Progressive escalation reached terminal level", 0);

			if (tmuxAlive) {
				try {
					await tmux.killSession(session.tmuxSession);
				} catch {
					// Session may have died — not an error
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
				sling,
				loadCheckpointFn,
				sendRecoveryMail: sendRecoveryMailFn,
			});

			return { terminated: !recovered, stateChanged: true };
		}
	}
}
