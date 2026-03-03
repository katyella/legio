/**
 * Integration tests for the unified watchman daemon (health + mail + beacon).
 *
 * Uses real filesystem (temp directories via mkdtemp) and real SessionStore
 * (better-sqlite3) for session persistence, plus real health evaluation logic.
 * Uses real SQLite for MailStore in mail tick tests.
 *
 * Only tmux operations (isSessionAlive, killSession, capturePaneContent, sendKeys)
 * are mocked via dependency injection (_tmux params) because real tmux interferes
 * with developer sessions and is fragile in CI.
 *
 * Does NOT use mock.module() — it leaks across test files. See mulch record
 * mx-56558b for background.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createEventStore } from "../events/store.ts";
import { createMailStore, type MailStore } from "../mail/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession, HealthCheck, SessionCheckpoint, StoredEvent } from "../types.ts";
import { type AgentMailState, runDaemonTick, runMailTick, type WatchmanOptions } from "./daemon.ts";

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

// === Health tick tests ===

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await createTempRoot();
});

afterEach(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

describe("daemon health tick", () => {
	test("tick with no sessions is a graceful no-op", async () => {
		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllAlive(),
		});

		expect(checks).toHaveLength(0);
	});

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

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("working");
	});

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

		expect(checks).toHaveLength(1);
		expect(checks[0]?.state).toBe("zombie");
		expect(checks[0]?.action).toBe("terminate");

		expect(tmuxMock.killed).toHaveLength(0);

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("tick with alive tmux but zombie-old activity calls killSession", async () => {
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

		expect(tmuxMock.killed).toContain("legio-zombie-agent");

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

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
			"legio-agent-beta": false,
			"legio-agent-gamma": true,
		});

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxMock,
		});

		expect(checks).toHaveLength(2);

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded).toHaveLength(3);

		const alpha = reloaded.find((s) => s.agentName === "agent-alpha");
		const beta = reloaded.find((s) => s.agentName === "agent-beta");
		const gamma = reloaded.find((s) => s.agentName === "agent-gamma");

		expect(alpha?.state).toBe("working");
		expect(beta?.state).toBe("zombie");
		expect(gamma?.state).toBe("completed");
	});

	test("completed sessions are skipped entirely", async () => {
		const session = makeSession({ state: "completed" });

		writeSessionsToStore(tempRoot, [session]);

		const checks: HealthCheck[] = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxAllDead(),
		});

		expect(checks).toHaveLength(0);

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
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
});

// === Event recording tests ===

describe("daemon event recording", () => {
	function readEvents(root: string): StoredEvent[] {
		const dbPath = join(root, ".legio", "events.db");
		const store = createEventStore(dbPath);
		try {
			return store.getTimeline({ since: "2000-01-01T00:00:00Z" });
		} finally {
			store.close();
		}
	}

	test("run_id is included in events when current-run.txt exists", async () => {
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
			memoryDomains: [],
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

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			onHealthCheck: (c) => checks.push(c),
			_tmux: tmuxWithLiveness({ "legio-working-agent": true }),
			_eventStore: null,
		});

		expect(checks).toHaveLength(1);
		expect(checks[0]?.action).toBe("none");
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

	function readEvents(root: string): StoredEvent[] {
		const dbPath = join(root, ".legio", "events.db");
		const store = createEventStore(dbPath);
		try {
			return store.getTimeline({ since: "2000-01-01T00:00:00Z" });
		} finally {
			store.close();
		}
	}

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
			memoryDomains: ["typescript"],
		};
	}

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

	async function writeRecoveryCountToDisk(
		root: string,
		agentName: string,
		count: number,
	): Promise<void> {
		const dir = join(root, ".legio", "agents", agentName);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "recovery-count"), String(count), "utf-8");
	}

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

		expect(slingMock.calls).toHaveLength(0);
		expect(mailMock.calls).toHaveLength(0);
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
	});

	test("checkpoint exists, sling succeeds → recovery events recorded", async () => {
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

		expect(slingMock.calls).toHaveLength(1);
		expect(mailMock.calls).toHaveLength(1);
		expect(mailMock.calls[0]).toContain("my-lead");

		const events = readEvents(tempRoot);
		const attemptEvent = events.find((e) => {
			if (!e.data) return false;
			const d = JSON.parse(e.data) as Record<string, unknown>;
			return d.type === "recovery_attempt";
		});
		expect(attemptEvent).toBeDefined();

		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("completed");
	});

	test("recovery count exhausted → no sling, agent zombified", async () => {
		const session = makeSession({
			agentName: "dead-agent",
			tmuxSession: "legio-dead-agent",
			state: "working",
			lastActivity: new Date().toISOString(),
			parentAgent: "my-lead",
		});

		writeSessionsToStore(tempRoot, [session]);
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

		expect(slingMock.calls).toHaveLength(0);
		expect(mailMock.calls).toHaveLength(1);
		const reloaded = readSessionsFromStore(tempRoot);
		expect(reloaded[0]?.state).toBe("zombie");
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
});

// === Beacon safety net tests ===

describe("beacon safety net", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await createTempRoot();
	});

	afterEach(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	function readEvents(root: string): StoredEvent[] {
		const dbPath = join(root, ".legio", "events.db");
		const store = createEventStore(dbPath);
		try {
			return store.getTimeline({ since: "2000-01-01T00:00:00Z" });
		} finally {
			store.close();
		}
	}

	test("sends follow-up Enter when booting agent has no activity markers", async () => {
		// Agent has been booting for 25s (past beaconNudgeMs=20s but before bootTimeoutMs=90s)
		const startedAt = new Date(Date.now() - 25_000).toISOString();
		const session = makeSession({
			agentName: "stuck-agent",
			tmuxSession: "legio-stuck-agent",
			state: "booting",
			startedAt,
			lastActivity: startedAt,
		});

		writeSessionsToStore(tempRoot, [session]);

		const sendKeysCalls: Array<{ session: string; keys: string }> = [];
		const eventsDbPath = join(tempRoot, ".legio", "events.db");
		const eventStore = createEventStore(eventsDbPath);

		try {
			await runDaemonTick({
				root: tempRoot,
				...THRESHOLDS,
				beaconNudgeMs: 20_000,
				_tmux: tmuxWithLiveness({ "legio-stuck-agent": true }),
				_capturePaneContent: async () => "Some prompt text sitting in buffer",
				_sendKeys: async (sessionName, keys) => {
					sendKeysCalls.push({ session: sessionName, keys });
				},
				_eventStore: eventStore,
			});
		} finally {
			eventStore.close();
		}

		// Follow-up Enter should have been sent
		expect(sendKeysCalls).toHaveLength(1);
		expect(sendKeysCalls[0]?.session).toBe("legio-stuck-agent");
		expect(sendKeysCalls[0]?.keys).toBe("");

		// beacon_nudge event should be recorded
		const events = readEvents(tempRoot);
		const beaconEvent = events.find((e) => {
			if (!e.data) return false;
			const d = JSON.parse(e.data) as Record<string, unknown>;
			return d.type === "beacon_nudge";
		});
		expect(beaconEvent).toBeDefined();
	});

	test("does NOT send Enter when activity markers are present", async () => {
		const startedAt = new Date(Date.now() - 25_000).toISOString();
		const session = makeSession({
			agentName: "active-agent",
			tmuxSession: "legio-active-agent",
			state: "booting",
			startedAt,
			lastActivity: startedAt,
		});

		writeSessionsToStore(tempRoot, [session]);

		const sendKeysCalls: Array<{ session: string; keys: string }> = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			beaconNudgeMs: 20_000,
			_tmux: tmuxWithLiveness({ "legio-active-agent": true }),
			_capturePaneContent: async () => "⏺ Claude is thinking...",
			_sendKeys: async (sessionName, keys) => {
				sendKeysCalls.push({ session: sessionName, keys });
			},
		});

		// No follow-up Enter — agent shows activity
		expect(sendKeysCalls).toHaveLength(0);
	});

	test("does NOT send Enter when pane content is empty", async () => {
		const startedAt = new Date(Date.now() - 25_000).toISOString();
		const session = makeSession({
			agentName: "empty-agent",
			tmuxSession: "legio-empty-agent",
			state: "booting",
			startedAt,
			lastActivity: startedAt,
		});

		writeSessionsToStore(tempRoot, [session]);

		const sendKeysCalls: Array<{ session: string; keys: string }> = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			beaconNudgeMs: 20_000,
			_tmux: tmuxWithLiveness({ "legio-empty-agent": true }),
			_capturePaneContent: async () => "   ",
			_sendKeys: async (sessionName, keys) => {
				sendKeysCalls.push({ session: sessionName, keys });
			},
		});

		// No follow-up Enter — pane is empty (agent hasn't started yet)
		expect(sendKeysCalls).toHaveLength(0);
	});

	test("does NOT send Enter before beaconNudgeMs", async () => {
		// Agent has been booting for only 5s (well before beaconNudgeMs=20s)
		const startedAt = new Date(Date.now() - 5_000).toISOString();
		const session = makeSession({
			agentName: "new-agent",
			tmuxSession: "legio-new-agent",
			state: "booting",
			startedAt,
			lastActivity: startedAt,
		});

		writeSessionsToStore(tempRoot, [session]);

		const sendKeysCalls: Array<{ session: string; keys: string }> = [];

		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			beaconNudgeMs: 20_000,
			_tmux: tmuxWithLiveness({ "legio-new-agent": true }),
			_capturePaneContent: async () => "Some text",
			_sendKeys: async (sessionName, keys) => {
				sendKeysCalls.push({ session: sessionName, keys });
			},
		});

		// No follow-up Enter — too early
		expect(sendKeysCalls).toHaveLength(0);
	});

	test("capturePaneContent failure is non-fatal", async () => {
		const startedAt = new Date(Date.now() - 25_000).toISOString();
		const session = makeSession({
			agentName: "error-agent",
			tmuxSession: "legio-error-agent",
			state: "booting",
			startedAt,
			lastActivity: startedAt,
		});

		writeSessionsToStore(tempRoot, [session]);

		// Should not throw
		await runDaemonTick({
			root: tempRoot,
			...THRESHOLDS,
			beaconNudgeMs: 20_000,
			_tmux: tmuxWithLiveness({ "legio-error-agent": true }),
			_capturePaneContent: async () => {
				throw new Error("tmux capture failed");
			},
			_sendKeys: async () => {},
		});

		// Daemon should continue without crashing
	});
});

// === Mail tick tests ===

describe("mail tick", () => {
	let tempDir: string;
	let store: MailStore;
	let nudgeCalls: Array<{ agentName: string; message: string }>;
	let pendingNudgeCalls: Array<{ agentName: string }>;

	function makeMailOptions(overrides?: Partial<WatchmanOptions>): WatchmanOptions {
		return {
			root: tempDir,
			zombieThresholdMs: 120_000,
			_mailStore: store,
			_nudge: async (_root, agentName, message) => {
				nudgeCalls.push({ agentName, message });
				return { delivered: true };
			},
			_isAgentIdle: async () => true,
			_writePendingNudge: async (_cwd, agentName) => {
				pendingNudgeCalls.push({ agentName });
			},
			...overrides,
		};
	}

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "legio-watchman-test-"));
		store = createMailStore(join(tempDir, "mail.db"));
		nudgeCalls = [];
		pendingNudgeCalls = [];
	});

	afterEach(async () => {
		store.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("no-op when no unread messages", async () => {
		const state = new Map<string, AgentMailState>();
		await runMailTick(makeMailOptions(), state);

		expect(nudgeCalls).toHaveLength(0);
		expect(pendingNudgeCalls).toHaveLength(0);
		expect(state.size).toBe(0);
	});

	test("nudges agent with unread mail on first tick", async () => {
		store.insert({
			id: "",
			from: "agent-a",
			to: "builder-1",
			subject: "Build this",
			body: "Please build feature X",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const state = new Map<string, AgentMailState>();
		await runMailTick(makeMailOptions(), state);

		expect(nudgeCalls).toHaveLength(1);
		expect(nudgeCalls[0]?.agentName).toBe("builder-1");
		expect(pendingNudgeCalls).toHaveLength(1);
		expect(pendingNudgeCalls[0]?.agentName).toBe("builder-1");
		expect(state.size).toBe(1);
		expect(state.get("builder-1")?.nudgeCount).toBe(1);
	});

	test("does not re-nudge before reNudgeIntervalMs", async () => {
		store.insert({
			id: "",
			from: "agent-a",
			to: "builder-1",
			subject: "Build this",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const state = new Map<string, AgentMailState>();
		const opts = makeMailOptions({ reNudgeIntervalMs: 60_000 });

		await runMailTick(opts, state);
		expect(nudgeCalls).toHaveLength(1);

		await runMailTick(opts, state);
		expect(nudgeCalls).toHaveLength(1);
	});

	test("re-nudges after reNudgeIntervalMs", async () => {
		store.insert({
			id: "",
			from: "agent-a",
			to: "builder-1",
			subject: "Build this",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const state = new Map<string, AgentMailState>();
		const opts = makeMailOptions({ reNudgeIntervalMs: 100 });

		await runMailTick(opts, state);
		expect(nudgeCalls).toHaveLength(1);

		await new Promise<void>((resolve) => setTimeout(resolve, 150));

		await runMailTick(opts, state);
		expect(nudgeCalls).toHaveLength(2);
		expect(state.get("builder-1")?.nudgeCount).toBe(2);
	});

	test("clears state when agent reads mail", async () => {
		const msg = store.insert({
			id: "",
			from: "agent-a",
			to: "builder-1",
			subject: "Build this",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const state = new Map<string, AgentMailState>();
		await runMailTick(makeMailOptions(), state);
		expect(state.size).toBe(1);

		store.markRead(msg.id);

		await runMailTick(makeMailOptions(), state);
		expect(state.size).toBe(0);
	});

	test("nudge failure is non-fatal", async () => {
		store.insert({
			id: "",
			from: "agent-a",
			to: "builder-1",
			subject: "Build this",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const state = new Map<string, AgentMailState>();
		const opts = makeMailOptions({
			_nudge: async () => {
				throw new Error("tmux dead");
			},
		});

		await runMailTick(opts, state);
		expect(state.size).toBe(1);
		expect(state.get("builder-1")?.nudgeCount).toBe(1);
	});

	test("skips tmux nudge when agent is busy", async () => {
		store.insert({
			id: "",
			from: "agent-a",
			to: "builder-1",
			subject: "Build this",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const state = new Map<string, AgentMailState>();
		const opts = makeMailOptions({
			_isAgentIdle: async () => false,
		});

		await runMailTick(opts, state);

		expect(pendingNudgeCalls).toHaveLength(1);
		expect(nudgeCalls).toHaveLength(0);
	});

	test("calls onWarn after warnAfterMs", async () => {
		store.insert({
			id: "",
			from: "agent-a",
			to: "builder-1",
			subject: "Build this",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const warnings: Array<{ agentName: string; durationMs: number }> = [];
		const state = new Map<string, AgentMailState>();
		const opts = makeMailOptions({
			warnAfterMs: 50,
			reNudgeIntervalMs: 10,
			onWarn: (agentName, durationMs) => {
				warnings.push({ agentName, durationMs });
			},
		});

		await runMailTick(opts, state);
		expect(warnings).toHaveLength(0);

		await new Promise<void>((resolve) => setTimeout(resolve, 100));

		await runMailTick(opts, state);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.agentName).toBe("builder-1");
	});

	test("handles multiple agents with unread mail", async () => {
		store.insert({
			id: "",
			from: "orchestrator",
			to: "builder-1",
			subject: "task 1",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		store.insert({
			id: "",
			from: "orchestrator",
			to: "builder-2",
			subject: "task 2",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const state = new Map<string, AgentMailState>();
		await runMailTick(makeMailOptions(), state);

		expect(nudgeCalls).toHaveLength(2);
		const nudgedAgents = nudgeCalls.map((c) => c.agentName).sort();
		expect(nudgedAgents).toEqual(["builder-1", "builder-2"]);
		expect(state.size).toBe(2);
	});

	test("calls onNudge callback", async () => {
		store.insert({
			id: "",
			from: "agent-a",
			to: "builder-1",
			subject: "Build this",
			body: "body",
			type: "status",
			priority: "normal",
			threadId: null,
		});

		const nudgeEvents: Array<{ agentName: string; count: number }> = [];
		const state = new Map<string, AgentMailState>();
		const opts = makeMailOptions({
			onNudge: (agentName, count) => {
				nudgeEvents.push({ agentName, count });
			},
		});

		await runMailTick(opts, state);

		expect(nudgeEvents).toHaveLength(1);
		expect(nudgeEvents[0]?.agentName).toBe("builder-1");
		expect(nudgeEvents[0]?.count).toBe(1);
	});
});
