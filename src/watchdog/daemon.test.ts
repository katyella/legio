/**
 * Integration tests for the watchdog daemon tick loop.
 *
 * Uses real filesystem (temp directories via mkdtemp) and real SessionStore
 * (better-sqlite3) for session persistence, plus real health evaluation logic.
 *
 * Only tmux operations (isSessionAlive, killSession) are mocked via dependency
 * injection (_tmux params) because real tmux interferes with developer sessions
 * and is fragile in CI.
 *
 * Does NOT use mock.module() — it leaks across test files. See mulch record
 * mx-56558b for background.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createEventStore } from "../events/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, HealthCheck, SessionCheckpoint, StoredEvent } from "../types.ts";
import { runDaemonTick } from "./daemon.ts";

// === Test constants ===

const THRESHOLDS = {
	zombieThresholdMs: 120_000,
};

// === Helpers ===

/** Create a temp directory with .legio/ subdirectory, ready for sessions.db. */
async function createTempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "legio-daemon-test-"));
	await mkdir(join(dir, ".legio"), { recursive: true });
	return dir;
}

/** Write sessions to the SessionStore (sessions.db) at the given root. */
function writeSessionsToStore(root: string, sessions: AgentSession[]): void {
	const dbPath = join(root, ".legio", "sessions.db");
	const store = createSessionStore(dbPath);
	for (const session of sessions) {
		store.upsert(session);
	}
	store.close();
}

/** Read sessions from the SessionStore (sessions.db) at the given root. */
function readSessionsFromStore(root: string): AgentSession[] {
	const dbPath = join(root, ".legio", "sessions.db");
	const store = createSessionStore(dbPath);
	const sessions = store.getAll();
	store.close();
	return sessions;
}

/** Build a test AgentSession with sensible defaults. */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-test",
		agentName: "test-agent",
		capability: "builder",
		worktreePath: "/tmp/test",
		branchName: "legio/test-agent/test-task",
		beadId: "test-task",
		tmuxSession: "legio-test-agent",
		state: "working",
		pid: process.pid, // Use our own PID so isProcessRunning returns true
		parentAgent: null,
		depth: 0,
		runId: null,
		escalationLevel: 0,
		stalledSince: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...overrides,
	};
}

/** Create a fake _tmux dependency where all sessions are alive. */
function tmuxAllAlive(): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
} {
	return {
		isSessionAlive: async () => true,
		killSession: async () => {},
	};
}

/** Create a fake _tmux dependency where all sessions are dead. */
function tmuxAllDead(): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
} {
	return {
		isSessionAlive: async () => false,
		killSession: async () => {},
	};
}

/**
 * Create a fake _tmux dependency with per-session liveness control.
 * Also tracks killSession calls for assertions.
 */
function tmuxWithLiveness(aliveMap: Record<string, boolean>): {
	isSessionAlive: (name: string) => Promise<boolean>;
	killSession: (name: string) => Promise<void>;
	killed: string[];
} {
	const killed: string[] = [];
	return {
		isSessionAlive: async (name: string) => aliveMap[name] ?? false,
		killSession: async (name: string) => {
			killed.push(name);
		},
		killed,
	};
}

// === Tests ===

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await createTempRoot();
});

afterEach(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

describe("daemon tick", () => {
	// --- Test 1: tick with no sessions file ---

	test("tick with no sessions is a graceful no-op", async () => {
		// No sessions in the store — daemon should not crash
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
		});

		// No health checks should have been produced (no sessions to check)
		expect(checks).toHaveLength(0);
	});

	// --- Test 2: tick with healthy sessions ---

	test("tick with healthy sessions produces no state changes", async () => {
		const session = makeSession({
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
		});

		expect(checks).toHaveLength(1);
		const check = checks[0];
		expect(check).toBeDefined();
		expect(check?.state).toBe("working");
		expect(check?.action).toBe("none");

		// Session state should be unchanged because state didn't change.
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Test 3: tick with dead tmux -> zombie transition ---

	test("tick with dead tmux transitions session to zombie and fires terminate", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "legio-dead-agent": false });
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
		});

		// Health check should detect zombie with terminate action
		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("zombie");
		expect(checks[0]?.action).toBe("terminate");

		// tmux is dead so killSession should NOT be called (only kills if tmuxAlive)
		expect(tmuxMock.killed).toHaveLength(0);

		// Session state should be persisted as zombie
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("tick with alive tmux but zombie-old activity calls killSession", async () => {
		// tmux IS alive but time-based zombie threshold is exceeded,
		// causing a terminate action — killSession SHOULD be called.
		const oldActivity = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "zombie-agent",
			tmuxSession: "legio-zombie-agent",
			state: "working",
			lastActivity: oldActivity,
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "legio-zombie-agent": true });
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("terminate");

		// tmux was alive, so killSession SHOULD have been called
		expect(tmuxMock.killed).toContain("legio-zombie-agent");

		// Session persisted as zombie
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	// --- Test 4: session persistence round-trip ---

	test("session persistence round-trip: load, modify, save, reload", async () => {
		const sessions: AgentSession[] = [
			makeSession({
				id: "session-1",
				agentName: "agent-alpha",
				tmuxSession: "legio-agent-alpha",
				state: "working",
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "session-2",
				agentName: "agent-beta",
				tmuxSession: "legio-agent-beta",
				state: "working",
				// Make beta's tmux dead so it transitions to zombie
				lastActivity: new Date().toISOString(),
			}),
			makeSession({
				id: "session-3",
				agentName: "agent-gamma",
				tmuxSession: "legio-agent-gamma",
				state: "completed",
				lastActivity: new Date().toISOString(),
			}),
		];

		writeSessionsToStore(tempRoot, sessions);

		const tmuxMock = tmuxWithLiveness({
			"legio-agent-alpha": true,
			"legio-agent-beta": false, // Dead — should become zombie
			"legio-agent-gamma": true, // Doesn't matter — completed is skipped
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
		});

		// Completed sessions are skipped — only 2 health checks
		expect(checks).toHaveLength(2);

		// Reload and verify persistence
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(3);

		const alpha = reloaded.find((s) => s.agentName === "agent-alpha");
		const beta = reloaded.find((s) => s.agentName === "agent-beta");
		const gamma = reloaded.find((s) => s.agentName === "agent-gamma");

		expect(alpha).toBeDefined();
		expect(beta).toBeDefined();
		expect(gamma).toBeDefined();

		// Alpha: tmux alive + recent activity — stays working
		expect(alpha?.state).toBe("working");

		// Beta: tmux dead — zombie (ZFC rule 1)
		expect(beta?.state).toBe("zombie");

		// Gamma: completed — unchanged (skipped by daemon)
		expect(gamma?.state).toBe("completed");
	});

	test("session persistence: state unchanged when nothing changes", async () => {
		const session = makeSession({
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxAllAlive(),
		});

		// Session state should remain unchanged since nothing triggered a transition
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Edge cases ---

	test("completed sessions are skipped entirely", async () => {
		const session = makeSession({ state: "completed" });

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllDead(), // Would be zombie if not skipped
		});

		// No health checks emitted for completed sessions
		expect(checks).toHaveLength(0);

		// State unchanged
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
	});

	test("multiple sessions with mixed states are all processed", async () => {
		const now = Date.now();
		const sessions: AgentSession[] = [
			makeSession({
				id: "s1",
				agentName: "healthy",
				tmuxSession: "legio-healthy",
				state: "working",
				lastActivity: new Date(now).toISOString(),
			}),
			makeSession({
				id: "s2",
				agentName: "dying",
				tmuxSession: "legio-dying",
				state: "working",
				lastActivity: new Date(now).toISOString(),
			}),
			makeSession({
				id: "s3",
				agentName: "stale",
				tmuxSession: "legio-stale",
				state: "working",
				lastActivity: new Date(now - 60_000).toISOString(),
			}),
			makeSession({
				id: "s4",
				agentName: "done",
				tmuxSession: "legio-done",
				state: "completed",
			}),
		];

		writeSessionsToStore(tempRoot, sessions);

		const tmuxMock = tmuxWithLiveness({
			"legio-healthy": true,
			"legio-dying": false,
			"legio-stale": true,
			"legio-done": false,
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
		});

		// 3 non-completed sessions processed
		expect(checks).toHaveLength(3);

		const reloaded = readSessionsFromStore(tempRoot);

		const healthy = reloaded.find((s) => s.agentName === "healthy");
		const dying = reloaded.find((s) => s.agentName === "dying");
		const stale = reloaded.find((s) => s.agentName === "stale");
		const done = reloaded.find((s) => s.agentName === "done");

		expect(healthy?.state).toBe("working");
		expect(dying?.state).toBe("zombie");
		// 60s old activity is below zombieMs (120s) — session stays working
		expect(stale?.state).toBe("working");
		expect(done?.state).toBe("completed");
	});

	test("empty sessions array is a no-op", async () => {
		writeSessionsToStore(tempRoot, []);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
		});

		expect(checks).toHaveLength(0);
	});

	test("booting session with recent activity transitions to working", async () => {
		const session = makeSession({
			state: "booting",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("working");

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("working");
	});

	// --- Backward compatibility ---

	test("sessions with default escalation fields are processed correctly", async () => {
		// Write a session with default (zero) escalation fields
		const session = makeSession({
			id: "session-old",
			agentName: "old-agent",
			worktreePath: "/tmp/test",
			branchName: "legio/old-agent/task",
			beadId: "task",
			tmuxSession: "legio-old-agent",
			state: "working",
			pid: process.pid,
			escalationLevel: 0,
			stalledSince: null,
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
		});

		// Should process without errors
		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("working");
	});
});

// === Event recording tests ===

describe("daemon event recording", () => {
	/** Open the events.db in the temp root and return all events. */
	function readEvents(root: string): StoredEvent[] {
		const dbPath = join(root, ".legio", "events.db");
		const store = createEventStore(dbPath);
		try {
			// Get all events (no agent filter — use a broad timeline)
			return store.getTimeline({ since: "2000-01-01T00:00:00Z" });
		} finally {
			store.close();
		}
	}

	test("run_id is included in events when current-run.txt exists", async () => {
		// Use zombie-old activity to trigger terminate + recovery attempt events
		const oldActivity = new Date(Date.now() - 200_000).toISOString();
		const session = makeSession({
			agentName: "zombie-agent",
			tmuxSession: "legio-zombie-agent",
			state: "working",
			lastActivity: oldActivity,
			parentAgent: "my-lead",
			beadId: "task-abc",
			capability: "builder",
		});

		writeSessionsToStore(tempRoot, [session]);

		// Write a current-run.txt
		const runId = "run-2026-02-13T10-00-00-000Z";
		await writeFile(join(tempRoot, ".legio", "current-run.txt"), runId, "utf-8");

		const checkpoint: SessionCheckpoint = {
			agentName: "zombie-agent",
			beadId: "task-abc",
			sessionId: "test-session",
			timestamp: new Date().toISOString(),
			progressSummary: "Test progress",
			filesModified: [],
			currentBranch: "legio/zombie-agent/task-abc",
			pendingWork: "Finish implementation",
			mulchDomains: [],
		};

		const eventsDbPath = join(tempRoot, ".legio", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxWithLiveness({ "legio-zombie-agent": true }),
				_loadCheckpoint: async () => checkpoint,
				_sling: async () => ({ exitCode: 0, stderr: "" }),
				_sendRecoveryMail: async () => {},
				_recordFailure: async () => {},
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		expect(events.length).toBeGreaterThanOrEqual(1);
		const attemptEvent = events.find((e) => {
			if (!e.data) return false;
			const d = JSON.parse(e.data) as Record<string, unknown>;
			return d.type === "recovery_attempt";
		});
		expect(attemptEvent).toBeDefined();
		expect(attemptEvent?.runId).toBe(runId);
	});

	test("daemon continues normally when _eventStore is null", async () => {
		const session = makeSession({
			agentName: "working-agent",
			tmuxSession: "legio-working-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		// Inject null EventStore — daemon should still work fine
		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxWithLiveness({ "legio-working-agent": true }),
			_eventStore: null,
		});

		// Daemon should still produce health checks even without EventStore
		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("none");
	});
});

// === Mulch failure recording tests ===

describe("daemon mulch failure recording", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await createTempRoot();
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	/** Track calls to the recordFailure mock. */
	interface FailureRecord {
		root: string;
		session: AgentSession;
		reason: string;
		tier: 0 | 1;
		triageSuggestion?: string;
	}

	function failureTracker(): {
		calls: FailureRecord[];
		recordFailure: (
			root: string,
			session: AgentSession,
			reason: string,
			tier: 0 | 1,
			triageSuggestion?: string,
		) => Promise<void>;
	} {
		const calls: FailureRecord[] = [];
		return {
			calls,
			async recordFailure(root, session, reason, tier, triageSuggestion) {
				calls.push({ root, session, reason, tier, triageSuggestion });
			},
		};
	}

	test("Tier 0: recordFailure called when action=terminate (process death)", async () => {
		const session = makeSession({
			agentName: "dying-agent",
			capability: "builder",
			beadId: "task-123",
			tmuxSession: "legio-dying-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "legio-dying-agent": false });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_recordFailure: failureMock.recordFailure,
		});

		// recordFailure should be called with Tier 0
		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.tier).toBe(0);
		expect(failureMock.calls[0]?.session.agentName).toBe("dying-agent");
		expect(failureMock.calls[0]?.session.capability).toBe("builder");
		expect(failureMock.calls[0]?.session.beadId).toBe("task-123");
		// Reason should be either the reconciliationNote or default "Process terminated"
		expect(failureMock.calls[0]?.reason).toBeDefined();
	});

	test("recordFailure includes evidenceBead when beadId is present", async () => {
		const session = makeSession({
			agentName: "beaded-agent",
			capability: "builder",
			beadId: "task-789",
			tmuxSession: "legio-beaded-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const tmuxMock = tmuxWithLiveness({ "legio-beaded-agent": false });
		const failureMock = failureTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxMock,
			_recordFailure: failureMock.recordFailure,
		});

		expect(failureMock.calls).toHaveLength(1);
		expect(failureMock.calls[0]?.session.beadId).toBe("task-789");
	});
});

// === Recovery tests ===

describe("daemon recovery", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await createTempRoot();
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	/** Open the events.db and return all events. */
	function readEvents(root: string): StoredEvent[] {
		const dbPath = join(root, ".legio", "events.db");
		const store = createEventStore(dbPath);
		try {
			return store.getTimeline({ since: "2000-01-01T00:00:00Z" });
		} finally {
			store.close();
		}
	}

	/** Build a minimal SessionCheckpoint for a session. */
	function makeCheckpoint(agentName: string, beadId: string): SessionCheckpoint {
		return {
			agentName,
			beadId,
			sessionId: "test-session",
			timestamp: new Date().toISOString(),
			progressSummary: "Test progress",
			filesModified: ["src/foo.ts"],
			currentBranch: `legio/${agentName}/${beadId}`,
			pendingWork: "Finish implementation",
			mulchDomains: ["typescript"],
		};
	}

	/** Create a fake _sling that tracks calls and returns a given exit code. */
	function slingTracker(exitCode = 0): {
		sling: (args: string[]) => Promise<{ exitCode: number; stderr: string }>;
		calls: string[][];
	} {
		const calls: string[][] = [];
		return {
			sling: async (args: string[]) => {
				calls.push(args);
				return { exitCode, stderr: exitCode !== 0 ? "sling failed" : "" };
			},
			calls,
		};
	}

	/** Create a fake _sendRecoveryMail that tracks calls. */
	function mailTracker(): {
		sendRecoveryMail: (args: string[]) => Promise<void>;
		calls: string[][];
	} {
		const calls: string[][] = [];
		return {
			sendRecoveryMail: async (args: string[]) => {
				calls.push(args);
			},
			calls,
		};
	}

	/** Read recovery count from disk. */
	async function readRecoveryCountFromDisk(root: string, agentName: string): Promise<number> {
		try {
			const text = await readFile(
				join(root, ".legio", "agents", agentName, "recovery-count"),
				"utf-8",
			);
			return parseInt(text.trim(), 10) || 0;
		} catch {
			return 0;
		}
	}

	/** Write recovery count to disk to simulate prior attempts. */
	async function writeRecoveryCountToDisk(
		root: string,
		agentName: string,
		count: number,
	): Promise<void> {
		const dir = join(root, ".legio", "agents", agentName);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "recovery-count"), String(count), "utf-8");
	}

	// --- Direct terminate path (tmux dead) ---

	test("no checkpoint → no recovery, agent marked zombie", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			parentAgent: "my-lead",
		});

		writeSessionsToStore(tempRoot, [session]);

		const slingMock = slingTracker(0);
		const mailMock = mailTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
			_loadCheckpoint: async () => null,
			_sling: slingMock.sling,
			_sendRecoveryMail: mailMock.sendRecoveryMail,
			_recordFailure: async () => {},
		});

		// No sling attempted (no checkpoint)
		expect(slingMock.calls).toHaveLength(0);
		// No mail sent
		expect(mailMock.calls).toHaveLength(0);
		// Agent is zombie (existing behavior)
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("checkpoint exists, sling succeeds → sling called, recovery events recorded", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			parentAgent: "my-lead",
			beadId: "task-abc",
			capability: "builder",
			depth: 1,
		});

		writeSessionsToStore(tempRoot, [session]);

		const checkpoint = makeCheckpoint("dead-agent", "task-abc");
		const slingMock = slingTracker(0);
		const mailMock = mailTracker();

		const eventsDbPath = join(tempRoot, ".legio", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
				_loadCheckpoint: async () => checkpoint,
				_sling: slingMock.sling,
				_sendRecoveryMail: mailMock.sendRecoveryMail,
				_recordFailure: async () => {},
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		// Sling was called
		expect(slingMock.calls).toHaveLength(1);
		// Mail sent to parent
		expect(mailMock.calls).toHaveLength(1);
		expect(mailMock.calls[0]).toContain("my-lead");

		// recovery_attempt and recovery_success events recorded
		const events = readEvents(tempRoot);
		const attemptEvent = events.find((e) => {
			if (!e.data) return false;
			const d = JSON.parse(e.data) as Record<string, unknown>;
			return d.type === "recovery_attempt";
		});
		expect(attemptEvent).toBeDefined();
		expect(attemptEvent?.level).toBe("info");
		expect(attemptEvent?.agentName).toBe("dead-agent");

		const successEvent = events.find((e) => {
			if (!e.data) return false;
			const d = JSON.parse(e.data) as Record<string, unknown>;
			return d.type === "recovery_success";
		});
		expect(successEvent).toBeDefined();
		expect(successEvent?.level).toBe("info");

		// State must be "completed" after successful recovery, not "zombie"
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).not.toBe("zombie");
		expect(reloaded[0]?.state).toBe("completed");
	});

	test("checkpoint exists, sling fails → sling called, agent stays zombie, recovery_failed event", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			parentAgent: "my-lead",
			beadId: "task-abc",
			capability: "builder",
		});

		writeSessionsToStore(tempRoot, [session]);

		const checkpoint = makeCheckpoint("dead-agent", "task-abc");
		const slingMock = slingTracker(1); // Non-zero exit code

		const eventsDbPath = join(tempRoot, ".legio", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
				_loadCheckpoint: async () => checkpoint,
				_sling: slingMock.sling,
				_sendRecoveryMail: async () => {},
				_recordFailure: async () => {},
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		// Sling was called
		expect(slingMock.calls).toHaveLength(1);
		// Agent should be zombie (sling failed)
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");

		// recovery_failed event recorded
		const events = readEvents(tempRoot);
		const failedEvent = events.find((e) => {
			if (!e.data) return false;
			const d = JSON.parse(e.data) as Record<string, unknown>;
			return d.type === "recovery_failed";
		});
		expect(failedEvent).toBeDefined();
		expect(failedEvent?.level).toBe("error");
	});

	test("sling args include capability, name, spec path, files, parent, depth", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			parentAgent: "my-lead",
			beadId: "task-abc",
			capability: "builder",
			depth: 2,
		});

		writeSessionsToStore(tempRoot, [session]);

		const checkpoint: SessionCheckpoint = {
			...makeCheckpoint("dead-agent", "task-abc"),
			filesModified: ["src/foo.ts", "src/bar.ts"],
		};
		const slingMock = slingTracker(0);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
			_loadCheckpoint: async () => checkpoint,
			_sling: slingMock.sling,
			_sendRecoveryMail: async () => {},
			_recordFailure: async () => {},
		});

		expect(slingMock.calls).toHaveLength(1);
		const args = slingMock.calls[0] ?? [];
		expect(args).toContain("task-abc");
		expect(args).toContain("--capability");
		expect(args).toContain("builder");
		expect(args).toContain("--name");
		expect(args).toContain("dead-agent");
		expect(args).toContain("--spec");
		expect(args).toContain("--files");
		expect(args).toContain("src/foo.ts,src/bar.ts");
		expect(args).toContain("--parent");
		expect(args).toContain("my-lead");
		expect(args).toContain("--depth");
		expect(args).toContain("2");
	});

	test("no files modified → --files arg omitted from sling", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			capability: "builder",
		});

		writeSessionsToStore(tempRoot, [session]);

		const checkpoint: SessionCheckpoint = {
			...makeCheckpoint("dead-agent", "task-abc"),
			filesModified: [], // No files
		};
		const slingMock = slingTracker(0);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
			_loadCheckpoint: async () => checkpoint,
			_sling: slingMock.sling,
			_sendRecoveryMail: async () => {},
			_recordFailure: async () => {},
		});

		expect(slingMock.calls).toHaveLength(1);
		const args = slingMock.calls[0] ?? [];
		expect(args).not.toContain("--files");
	});

	test("recovery count increments after successful attempt", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checkpoint = makeCheckpoint("dead-agent", "task-abc");

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
			_loadCheckpoint: async () => checkpoint,
			_sling: slingTracker(0).sling,
			_sendRecoveryMail: async () => {},
			_recordFailure: async () => {},
		});

		const count = await readRecoveryCountFromDisk(tempRoot, "dead-agent");
		expect(count).toBe(1);
	});

	test("recovery count exhausted → no sling, agent zombified, escalation mail sent to parent", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			parentAgent: "my-lead",
		});

		writeSessionsToStore(tempRoot, [session]);

		// Pre-write recovery count = 1 (default maxRecoveryAttempts=1, so exhausted)
		await writeRecoveryCountToDisk(tempRoot, "dead-agent", 1);

		const checkpoint = makeCheckpoint("dead-agent", "task-abc");
		const slingMock = slingTracker(0);
		const mailMock = mailTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
			_loadCheckpoint: async () => checkpoint,
			_sling: slingMock.sling,
			_sendRecoveryMail: mailMock.sendRecoveryMail,
			_recordFailure: async () => {},
		});

		// No sling attempted (exhausted)
		expect(slingMock.calls).toHaveLength(0);
		// Exhaustion error mail sent to parent
		expect(mailMock.calls).toHaveLength(1);
		const mailArgs = mailMock.calls[0] ?? [];
		expect(mailArgs).toContain("my-lead");
		expect(mailArgs).toContain("error");
		// Agent marked zombie
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("maxRecoveryAttempts=2: second attempt allowed when count=1", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			parentAgent: "my-lead",
		});

		writeSessionsToStore(tempRoot, [session]);

		// count=1 but max=2, so one more attempt is allowed
		await writeRecoveryCountToDisk(tempRoot, "dead-agent", 1);

		const checkpoint = makeCheckpoint("dead-agent", "task-abc");
		const slingMock = slingTracker(0);

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			maxRecoveryAttempts: 2,
			_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
			_loadCheckpoint: async () => checkpoint,
			_sling: slingMock.sling,
			_sendRecoveryMail: async () => {},
			_recordFailure: async () => {},
		});

		// Second attempt was made
		expect(slingMock.calls).toHaveLength(1);
		// Count now 2
		const count = await readRecoveryCountFromDisk(tempRoot, "dead-agent");
		expect(count).toBe(2);
	});

	test("no parent agent → no mail, recovery still attempted", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			parentAgent: null,
		});

		writeSessionsToStore(tempRoot, [session]);

		const checkpoint = makeCheckpoint("dead-agent", "task-abc");
		const slingMock = slingTracker(0);
		const mailMock = mailTracker();

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
			_loadCheckpoint: async () => checkpoint,
			_sling: slingMock.sling,
			_sendRecoveryMail: mailMock.sendRecoveryMail,
			_recordFailure: async () => {},
		});

		// Sling still attempted
		expect(slingMock.calls).toHaveLength(1);
		// No mail (no parent)
		expect(mailMock.calls).toHaveLength(0);
	});

	test("recovery_attempt event includes attempt number and maxAttempts", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		const checkpoint = makeCheckpoint("dead-agent", "task-abc");

		const eventsDbPath = join(tempRoot, ".legio", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				maxRecoveryAttempts: 3,
				_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
				_loadCheckpoint: async () => checkpoint,
				_sling: slingTracker(0).sling,
				_sendRecoveryMail: async () => {},
				_recordFailure: async () => {},
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		const events = readEvents(tempRoot);
		const attemptEvent = events.find((e) => {
			if (!e.data) return false;
			const d = JSON.parse(e.data) as Record<string, unknown>;
			return d.type === "recovery_attempt";
		});
		expect(attemptEvent).toBeDefined();
		const data = JSON.parse(attemptEvent?.data ?? "{}") as Record<string, unknown>;
		expect(data.attempt).toBe(1);
		expect(data.maxAttempts).toBe(3);
	});

	test("existing tests unchanged: dead tmux without recovery DI still zombifies", async () => {
		// Verify that omitting recovery DI (no _loadCheckpoint) uses default behavior —
		// since the real loadCheckpoint would find no file, agent should still be zombified.
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
		});

		writeSessionsToStore(tempRoot, [session]);

		// Use a _loadCheckpoint that returns null (as the real impl would for no file)
		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			_tmux: tmuxWithLiveness({ "legio-dead-agent": false }),
			_loadCheckpoint: async () => null,
			_sling: async () => ({ exitCode: 0, stderr: "" }),
			_sendRecoveryMail: async () => {},
			_recordFailure: async () => {},
		});

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});
});
