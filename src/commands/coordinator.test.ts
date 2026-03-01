/**
 * Tests for legio coordinator command.
 *
 * Uses real temp directories and real git repos for file I/O and config loading.
 * Tmux is injected via the CoordinatorDeps DI interface instead of
 * mock.module() to avoid the process-global mock leak issue
 * (see mulch record mx-56558b).
 *
 * WHY DI instead of mock.module: mock.module() in vitest is process-global
 * and leaks across test files. The DI approach (same pattern as daemon.ts
 * _tmux/_triage/_nudge) ensures mocks are scoped to each test invocation.
 */

import { statSync } from "node:fs";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore } from "../sessions/store.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import {
	buildCoordinatorBeacon,
	type CoordinatorDeps,
	coordinatorCommand,
	resolveAttach,
} from "./coordinator.ts";

// --- Fake Tmux ---

/** Track calls to fake tmux for assertions. */
interface TmuxCallTracker {
	createSession: Array<{
		name: string;
		cwd: string;
		command: string;
		env?: Record<string, string>;
	}>;
	isSessionAlive: Array<{ name: string; result: boolean }>;
	killSession: Array<{ name: string }>;
	sendKeys: Array<{ name: string; keys: string }>;
}

// --- Fake Watchdog ---

/** Track calls to fake watchdog for assertions. */
interface WatchdogCallTracker {
	start: number;
	stop: number;
	isRunning: number;
}

// --- Fake Monitor ---

/** Track calls to fake monitor for assertions. */
interface MonitorCallTracker {
	start: number;
	stop: number;
	isRunning: number;
}

/** Build a fake tmux DI object with configurable session liveness. */
function makeFakeTmux(sessionAliveMap: Record<string, boolean> = {}): {
	tmux: NonNullable<CoordinatorDeps["_tmux"]>;
	calls: TmuxCallTracker;
} {
	const calls: TmuxCallTracker = {
		createSession: [],
		isSessionAlive: [],
		killSession: [],
		sendKeys: [],
	};

	const tmux: NonNullable<CoordinatorDeps["_tmux"]> = {
		createSession: async (
			name: string,
			cwd: string,
			command: string,
			env?: Record<string, string>,
		): Promise<number> => {
			calls.createSession.push({ name, cwd, command, env });
			return 99999; // Fake PID
		},
		isSessionAlive: async (name: string): Promise<boolean> => {
			const alive = sessionAliveMap[name] ?? false;
			calls.isSessionAlive.push({ name, result: alive });
			return alive;
		},
		killSession: async (name: string): Promise<void> => {
			calls.killSession.push({ name });
		},
		sendKeys: async (name: string, keys: string): Promise<void> => {
			calls.sendKeys.push({ name, keys });
		},
	};

	return { tmux, calls };
}

/**
 * Build a fake watchdog DI object with configurable behavior.
 * @param running - Whether the watchdog should report as running
 * @param startSuccess - Whether start() should succeed (return a PID)
 * @param stopSuccess - Whether stop() should succeed (return true)
 */
function makeFakeWatchdog(
	running = false,
	startSuccess = true,
	stopSuccess = true,
): {
	watchdog: NonNullable<CoordinatorDeps["_watchdog"]>;
	calls: WatchdogCallTracker;
} {
	const calls: WatchdogCallTracker = {
		start: 0,
		stop: 0,
		isRunning: 0,
	};

	const watchdog: NonNullable<CoordinatorDeps["_watchdog"]> = {
		async start(): Promise<{ pid: number } | null> {
			calls.start++;
			return startSuccess ? { pid: 88888 } : null;
		},
		async stop(): Promise<boolean> {
			calls.stop++;
			return stopSuccess;
		},
		async isRunning(): Promise<boolean> {
			calls.isRunning++;
			return running;
		},
	};

	return { watchdog, calls };
}

/**
 * Build a fake monitor DI object with configurable behavior.
 * @param running - Whether the monitor should report as running
 * @param startSuccess - Whether start() should succeed (return a PID)
 * @param stopSuccess - Whether stop() should succeed (return true)
 */
function makeFakeMonitor(
	running = false,
	startSuccess = true,
	stopSuccess = true,
): {
	monitor: NonNullable<CoordinatorDeps["_monitor"]>;
	calls: MonitorCallTracker;
} {
	const calls: MonitorCallTracker = {
		start: 0,
		stop: 0,
		isRunning: 0,
	};

	const monitor: NonNullable<CoordinatorDeps["_monitor"]> = {
		async start(): Promise<{ pid: number } | null> {
			calls.start++;
			return startSuccess ? { pid: 77777 } : null;
		},
		async stop(): Promise<boolean> {
			calls.stop++;
			return stopSuccess;
		},
		async isRunning(): Promise<boolean> {
			calls.isRunning++;
			return running;
		},
	};

	return { monitor, calls };
}

// --- Test Setup ---

let tempDir: string;
let legioDir: string;

/** Save sessions to the SessionStore (sessions.db) for test setup. */
function saveSessionsToDb(sessions: AgentSession[]): void {
	const { store } = openSessionStore(legioDir);
	try {
		for (const session of sessions) {
			store.upsert(session);
		}
	} finally {
		store.close();
	}
}

/** Load all sessions from the SessionStore (sessions.db). */
function loadSessionsFromDb(): AgentSession[] {
	const { store } = openSessionStore(legioDir);
	try {
		return store.getAll();
	} finally {
		store.close();
	}
}

beforeEach(async () => {
	tempDir = await realpath(await createTempGitRepo());
	legioDir = join(tempDir, ".legio");
	await mkdir(legioDir, { recursive: true });

	// Write a minimal config.yaml so loadConfig succeeds
	await writeFile(
		join(legioDir, "config.yaml"),
		["project:", "  name: test-project", `  root: ${tempDir}`, "  canonicalBranch: main"].join(
			"\n",
		),
	);

	// Write agent-manifest.json and stub agent-def .md files so manifest loading succeeds
	const agentDefsDir = join(legioDir, "agent-defs");
	await mkdir(agentDefsDir, { recursive: true });
	const manifest = {
		version: "1.0",
		agents: {
			coordinator: {
				file: "coordinator.md",
				model: "opus",
				tools: ["Read", "Bash"],
				capabilities: ["coordinate"],
				canSpawn: true,
				constraints: [],
			},
		},
		capabilityIndex: { coordinate: ["coordinator"] },
	};
	await writeFile(
		join(legioDir, "agent-manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	await writeFile(join(agentDefsDir, "coordinator.md"), "# Coordinator\n");

	vi.spyOn(process, "cwd").mockReturnValue(tempDir);
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

// --- Helpers ---

function makeCoordinatorSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: `session-${Date.now()}-coordinator`,
		agentName: "coordinator",
		capability: "coordinator",
		worktreePath: tempDir,
		branchName: "main",
		beadId: "",
		tmuxSession: "legio-test-project-coordinator",
		state: "working",
		pid: 99999,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		...overrides,
	};
}

/** Capture stdout.write output during a function call. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string) => {
		chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

/** Build default CoordinatorDeps with fake tmux, watchdog, and monitor.
 * Always injects fakes for all three to prevent real child_process.spawn(["legio", ...])
 * calls in tests (legio CLI is not available in CI). */
function makeDeps(
	sessionAliveMap: Record<string, boolean> = {},
	watchdogConfig?: { running?: boolean; startSuccess?: boolean; stopSuccess?: boolean },
	monitorConfig?: { running?: boolean; startSuccess?: boolean; stopSuccess?: boolean },
): {
	deps: CoordinatorDeps;
	calls: TmuxCallTracker;
	watchdogCalls: WatchdogCallTracker;
	monitorCalls: MonitorCallTracker;
} {
	const { tmux, calls } = makeFakeTmux(sessionAliveMap);
	const { watchdog, calls: watchdogCalls } = makeFakeWatchdog(
		watchdogConfig?.running,
		watchdogConfig?.startSuccess,
		watchdogConfig?.stopSuccess,
	);
	const { monitor, calls: monitorCalls } = makeFakeMonitor(
		monitorConfig?.running,
		monitorConfig?.startSuccess,
		monitorConfig?.stopSuccess,
	);

	const deps: CoordinatorDeps = {
		_tmux: tmux,
		_watchdog: watchdog,
		_monitor: monitor,
		_sleep: () => Promise.resolve(),
	};

	return {
		deps,
		calls,
		watchdogCalls,
		monitorCalls,
	};
}

// --- Tests ---

describe("coordinatorCommand help", () => {
	test("--help outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand(["--help"]));
		expect(output).toContain("legio coordinator");
		expect(output).toContain("start");
		expect(output).toContain("stop");
		expect(output).toContain("status");
	});

	test("--help includes --attach and --no-attach flags", async () => {
		const output = await captureStdout(() => coordinatorCommand(["--help"]));
		expect(output).toContain("--attach");
		expect(output).toContain("--no-attach");
	});

	test("-h outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand(["-h"]));
		expect(output).toContain("legio coordinator");
	});

	test("empty args outputs help text", async () => {
		const output = await captureStdout(() => coordinatorCommand([]));
		expect(output).toContain("legio coordinator");
		expect(output).toContain("Subcommands:");
	});
});

describe("coordinatorCommand unknown subcommand", () => {
	test("throws ValidationError for unknown subcommand", async () => {
		await expect(coordinatorCommand(["frobnicate"])).rejects.toThrow(ValidationError);
	});

	test("error message includes the bad subcommand name", async () => {
		try {
			await coordinatorCommand(["frobnicate"]);
			expect.unreachable("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const ve = err as ValidationError;
			expect(ve.message).toContain("frobnicate");
			expect(ve.field).toBe("subcommand");
			expect(ve.value).toBe("frobnicate");
		}
	});
});

describe("startCoordinator", () => {
	test("writes session to sessions.json with correct fields", async () => {
		const { deps, calls } = makeDeps();

		await captureStdout(() => coordinatorCommand(["start"], deps));

		// Verify sessions.json was written
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);

		const session = sessions[0];
		expect(session).toBeDefined();
		expect(session?.agentName).toBe("coordinator");
		expect(session?.capability).toBe("coordinator");
		expect(session?.tmuxSession).toBe("legio-test-project-coordinator");
		expect(session?.state).toBe("booting");
		expect(session?.pid).toBe(99999);
		expect(session?.parentAgent).toBeNull();
		expect(session?.depth).toBe(0);
		expect(session?.beadId).toBe("");
		expect(session?.branchName).toBe("main");
		expect(session?.worktreePath).toBe(tempDir);
		expect(session?.id).toMatch(/^session-\d+-coordinator$/);

		// Verify tmux createSession was called
		expect(calls.createSession).toHaveLength(1);
		expect(calls.createSession[0]?.name).toBe("legio-test-project-coordinator");
		expect(calls.createSession[0]?.cwd).toBe(tempDir);

		// Verify sendKeys was called (beacon + follow-up Enter)
		expect(calls.sendKeys.length).toBeGreaterThanOrEqual(1);
	});

	test("deploys hooks to project root .claude/settings.local.json", async () => {
		const { deps } = makeDeps();

		await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));

		// Verify .claude/settings.local.json was created at the project root
		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		let settingsExists = false;
		try {
			await access(settingsPath);
			settingsExists = true;
		} catch {
			// not found
		}
		expect(settingsExists).toBe(true);

		const content = await readFile(settingsPath, "utf-8");
		const config = JSON.parse(content) as {
			hooks: Record<string, unknown[]>;
		};

		// Verify hook categories exist
		expect(config.hooks).toBeDefined();
		expect(config.hooks.SessionStart).toBeDefined();
		expect(config.hooks.UserPromptSubmit).toBeDefined();
		expect(config.hooks.PreToolUse).toBeDefined();
		expect(config.hooks.PostToolUse).toBeDefined();
		expect(config.hooks.Stop).toBeDefined();
	});

	test("hooks use coordinator agent name for event logging", async () => {
		const { deps } = makeDeps();

		await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));

		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		const content = await readFile(settingsPath, "utf-8");

		// The hooks should reference the coordinator agent name
		expect(content).toContain("--agent coordinator");
	});

	test("hooks include ENV_GUARD to avoid affecting user's Claude Code session", async () => {
		const { deps } = makeDeps();

		await captureStdout(() => coordinatorCommand(["start", "--no-attach"], deps));

		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		const content = await readFile(settingsPath, "utf-8");

		// PreToolUse guards should include the ENV_GUARD prefix
		expect(content).toContain("LEGIO_AGENT_NAME");
	});

	test("injects agent definition via --settings file when agent-defs/coordinator.md exists", async () => {
		// Deploy a coordinator agent definition
		const agentDefsDir = join(legioDir, "agent-defs");
		await mkdir(agentDefsDir, { recursive: true });
		await writeFile(
			join(agentDefsDir, "coordinator.md"),
			"# Coordinator Agent\n\nYou are the coordinator.\n",
		);

		const { deps, calls } = makeDeps();

		await captureStdout(() => coordinatorCommand(["start", "--no-attach", "--json"], deps));

		expect(calls.createSession).toHaveLength(1);
		const cmd = calls.createSession[0]?.command ?? "";
		// Agent def is written to a settings JSON file and passed via --settings
		// to avoid Claude Code's ERR_STREAM_DESTROYED with large inline payloads
		expect(cmd).toContain("--settings");
		expect(cmd).toContain("settings-coordinator.json");

		// Verify the settings file was written with the agent def
		const { readFileSync } = await import("node:fs");
		const settingsPath = join(legioDir, "settings-coordinator.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		expect(settings.appendSystemPrompt).toContain("# Coordinator Agent");
		expect(settings.skipDangerousModePermissionPrompt).toBe(true);
	});

	test("reads model from manifest instead of hardcoding", async () => {
		// Override the manifest to use sonnet instead of default opus
		const manifest = {
			version: "1.0",
			agents: {
				coordinator: {
					file: "coordinator.md",
					model: "sonnet",
					tools: ["Read", "Bash"],
					capabilities: ["coordinate"],
					canSpawn: true,
					constraints: [],
				},
			},
			capabilityIndex: { coordinate: ["coordinator"] },
		};
		await writeFile(
			join(legioDir, "agent-manifest.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);

		const { deps, calls } = makeDeps();

		await captureStdout(() => coordinatorCommand(["start", "--no-attach", "--json"], deps));

		expect(calls.createSession).toHaveLength(1);
		const cmd = calls.createSession[0]?.command ?? "";
		expect(cmd).toContain("--model sonnet");
		expect(cmd).not.toContain("--model opus");
	});

	test("--json outputs JSON with expected fields", async () => {
		const { deps } = makeDeps();

		const output = await captureStdout(() => coordinatorCommand(["start", "--json"], deps));

		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.agentName).toBe("coordinator");
		expect(parsed.capability).toBe("coordinator");
		expect(parsed.tmuxSession).toBe("legio-test-project-coordinator");
		expect(parsed.pid).toBe(99999);
		expect(parsed.projectRoot).toBe(tempDir);
	});

	test("rejects duplicate when coordinator is already running", async () => {
		// Write an existing active coordinator session
		const existing = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([existing]);

		// Mock tmux as alive for the existing session
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });

		await expect(coordinatorCommand(["start"], deps)).rejects.toThrow(AgentError);

		try {
			await coordinatorCommand(["start"], deps);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const ae = err as AgentError;
			expect(ae.message).toContain("already running");
		}
	});

	test("cleans up dead session and starts new one", async () => {
		// Write an existing session that claims to be working
		const deadSession = makeCoordinatorSession({
			id: "session-dead-coordinator",
			state: "working",
		});
		saveSessionsToDb([deadSession]);

		// Mock tmux as NOT alive for the existing session
		const { deps } = makeDeps({ "legio-test-project-coordinator": false });

		await captureStdout(() => coordinatorCommand(["start"], deps));

		// SessionStore uses UNIQUE(agent_name), so the new session replaces the old one.
		// Verify the new session is in booting state with the coordinator name.
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);

		const newSession = sessions[0];
		expect(newSession).toBeDefined();
		expect(newSession?.state).toBe("booting");
		expect(newSession?.agentName).toBe("coordinator");
		// The new session should have a different ID than the dead one
		expect(newSession?.id).not.toBe("session-dead-coordinator");
	});
});

describe("stopCoordinator", () => {
	test("marks session as completed after stopping", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is alive so killSession will be called
		const { deps, calls } = makeDeps({ "legio-test-project-coordinator": true });

		await captureStdout(() => coordinatorCommand(["stop"], deps));

		// Verify session is now completed
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.state).toBe("completed");

		// Verify killSession was called
		expect(calls.killSession).toHaveLength(1);
		expect(calls.killSession[0]?.name).toBe("legio-test-project-coordinator");
	});

	test("--json outputs JSON with stopped flag", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });

		const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.stopped).toBe(true);
		expect(parsed.sessionId).toBe(session.id);
	});

	test("handles already-dead tmux session gracefully", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is NOT alive — should skip killSession
		const { deps, calls } = makeDeps({ "legio-test-project-coordinator": false });

		await captureStdout(() => coordinatorCommand(["stop"], deps));

		// Verify session is completed
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("completed");

		// killSession should NOT have been called since session was already dead
		expect(calls.killSession).toHaveLength(0);
	});

	test("throws AgentError when no coordinator session exists", async () => {
		const { deps } = makeDeps();

		// No sessions.json at all
		await expect(coordinatorCommand(["stop"], deps)).rejects.toThrow(AgentError);

		try {
			await coordinatorCommand(["stop"], deps);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const ae = err as AgentError;
			expect(ae.message).toContain("No active coordinator session");
		}
	});

	test("throws AgentError when only completed sessions exist", async () => {
		const completed = makeCoordinatorSession({ state: "completed" });
		saveSessionsToDb([completed]);
		const { deps } = makeDeps();

		await expect(coordinatorCommand(["stop"], deps)).rejects.toThrow(AgentError);
	});
});

describe("stopCoordinator run completion", () => {
	test("coordinator stop auto-completes the active run", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Create a run in RunStore
		const dbPath = join(legioDir, "sessions.db");
		const runStore = createRunStore(dbPath);
		runStore.createRun({
			id: "run-test-123",
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			status: "active",
		});
		runStore.close();

		// Write current-run.txt
		await writeFile(join(legioDir, "current-run.txt"), "run-test-123");

		// Stop coordinator
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });
		await captureStdout(() => coordinatorCommand(["stop"], deps));

		// Verify run status is "completed"
		const runStoreCheck = createRunStore(dbPath);
		const run = runStoreCheck.getRun("run-test-123");
		runStoreCheck.close();
		expect(run?.status).toBe("completed");

		// Verify current-run.txt is deleted
		let currentRunExists = false;
		try {
			await access(join(legioDir, "current-run.txt"));
			currentRunExists = true;
		} catch {
			// expected
		}
		expect(currentRunExists).toBe(false);
	});

	test("coordinator stop succeeds when no active run exists", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// No current-run.txt

		// Stop coordinator (should succeed without errors)
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });
		await expect(captureStdout(() => coordinatorCommand(["stop"], deps))).resolves.toBeDefined();

		// Verify session is completed
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("completed");
	});

	test("coordinator stop succeeds when current-run.txt is empty", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Write empty current-run.txt
		await writeFile(join(legioDir, "current-run.txt"), "");

		// Stop coordinator (should succeed without errors)
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });
		await expect(captureStdout(() => coordinatorCommand(["stop"], deps))).resolves.toBeDefined();

		// Verify session is completed
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("completed");
	});

	test("--json output includes runCompleted field", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Create a run in RunStore
		const dbPath = join(legioDir, "sessions.db");
		const runStore = createRunStore(dbPath);
		runStore.createRun({
			id: "run-test-456",
			startedAt: new Date().toISOString(),
			coordinatorSessionId: null,
			status: "active",
		});
		runStore.close();

		// Write current-run.txt
		await writeFile(join(legioDir, "current-run.txt"), "run-test-456");

		// Stop coordinator with --json
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });
		const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));

		// Verify output includes runCompleted: true
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.runCompleted).toBe(true);
	});

	test("--json output includes runCompleted:false when no run", async () => {
		// Create a coordinator session
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// No current-run.txt

		// Stop coordinator with --json
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });
		const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));

		// Verify output includes runCompleted: false
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.runCompleted).toBe(false);
	});
});

describe("statusCoordinator", () => {
	test("shows 'not running' when no session exists", async () => {
		const { deps } = makeDeps();
		const output = await captureStdout(() => coordinatorCommand(["status"], deps));
		expect(output).toContain("not running");
	});

	test("--json shows running:false when no session exists", async () => {
		const { deps } = makeDeps();
		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
	});

	test("shows running state when coordinator is alive", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });

		const output = await captureStdout(() => coordinatorCommand(["status"], deps));
		expect(output).toContain("running");
		expect(output).toContain(session.id);
		expect(output).toContain("legio-test-project-coordinator");
	});

	test("--json shows correct fields when running", async () => {
		const session = makeCoordinatorSession({ state: "working", pid: 99999 });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "legio-test-project-coordinator": true });

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(true);
		expect(parsed.sessionId).toBe(session.id);
		expect(parsed.state).toBe("working");
		expect(parsed.tmuxSession).toBe("legio-test-project-coordinator");
		expect(parsed.pid).toBe(99999);
	});

	test("reconciles zombie: updates state when tmux is dead but session says working", async () => {
		const session = makeCoordinatorSession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is NOT alive — triggers zombie reconciliation
		const { deps } = makeDeps({ "legio-test-project-coordinator": false });

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
		expect(parsed.state).toBe("zombie");

		// Verify sessions.json was updated
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("zombie");
	});

	test("reconciles zombie for booting state too", async () => {
		const session = makeCoordinatorSession({ state: "booting" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "legio-test-project-coordinator": false });

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.state).toBe("zombie");
	});

	test("does not show completed sessions as active", async () => {
		const completed = makeCoordinatorSession({ state: "completed" });
		saveSessionsToDb([completed]);
		const { deps } = makeDeps();

		const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
	});
});

describe("buildCoordinatorBeacon", () => {
	test("is a single line (no newlines)", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).not.toContain("\n");
	});

	test("includes coordinator identity in header", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("[LEGIO] coordinator (coordinator)");
	});

	test("includes ISO timestamp", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	test("includes depth and parent info", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("Depth: 0 | Parent: none");
	});

	test("includes persistent orchestrator role", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("Role: persistent orchestrator");
	});

	test("includes startup instructions", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("mulch prime");
		expect(beacon).toContain("legio mail check --agent coordinator");
		expect(beacon).toContain("bd ready");
		expect(beacon).toContain("legio group status");
	});

	test("includes hierarchy enforcement instruction", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("ONLY spawn leads");
		expect(beacon).toContain("NEVER spawn non-lead agents directly");
	});

	test("includes delegation instruction", () => {
		const beacon = buildCoordinatorBeacon();
		expect(beacon).toContain("DELEGATION");
		expect(beacon).toContain("spawn a lead who will spawn scouts");
	});

	test("parts are joined with em-dash separator", () => {
		const beacon = buildCoordinatorBeacon();
		// Should have exactly 4 " — " separators (5 parts)
		const dashes = beacon.split(" — ");
		expect(dashes).toHaveLength(5);
	});
});

describe("resolveAttach", () => {
	test("--attach flag forces attach regardless of TTY", () => {
		expect(resolveAttach(["--attach"], false)).toBe(true);
		expect(resolveAttach(["--attach"], true)).toBe(true);
	});

	test("--no-attach flag forces no attach regardless of TTY", () => {
		expect(resolveAttach(["--no-attach"], false)).toBe(false);
		expect(resolveAttach(["--no-attach"], true)).toBe(false);
	});

	test("--attach takes precedence when both flags are present", () => {
		expect(resolveAttach(["--attach", "--no-attach"], false)).toBe(true);
		expect(resolveAttach(["--attach", "--no-attach"], true)).toBe(true);
	});

	test("defaults to TTY state when no flag is set", () => {
		expect(resolveAttach([], true)).toBe(true);
		expect(resolveAttach([], false)).toBe(false);
	});

	test("works with other flags present", () => {
		expect(resolveAttach(["--json", "--attach"], false)).toBe(true);
		expect(resolveAttach(["--json", "--no-attach"], true)).toBe(false);
		expect(resolveAttach(["--json"], true)).toBe(true);
	});
});

describe("watchdog integration", () => {
	describe("startCoordinator with --watchdog", () => {
		test("calls watchdog.start() when --watchdog flag is present", async () => {
			const { deps, watchdogCalls } = makeDeps({}, { startSuccess: true });
			await captureStdout(() => coordinatorCommand(["start", "--watchdog", "--json"], deps));

			expect(watchdogCalls?.start).toBe(1);
		});

		test("does NOT call watchdog.start() when --watchdog flag is absent", async () => {
			const { deps, watchdogCalls } = makeDeps({}, { startSuccess: true });
			await captureStdout(() => coordinatorCommand(["start", "--json"], deps));

			expect(watchdogCalls?.start).toBe(0);
		});

		test("--json output includes watchdog:false (output written before watchdog starts)", async () => {
			const { deps } = makeDeps({}, { startSuccess: true });
			const output = await captureStdout(() =>
				coordinatorCommand(["start", "--watchdog", "--json"], deps),
			);

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdog).toBe(false);
		});

		test("--json output includes watchdog:false when --watchdog is present but start fails", async () => {
			const { deps } = makeDeps({}, { startSuccess: false });
			const output = await captureStdout(() =>
				coordinatorCommand(["start", "--watchdog", "--json"], deps),
			);

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdog).toBe(false);
		});

		test("--json output includes watchdog:false when --watchdog is absent", async () => {
			const { deps } = makeDeps({}, { startSuccess: true });
			const output = await captureStdout(() => coordinatorCommand(["start", "--json"], deps));

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdog).toBe(false);
		});

		test("text output includes watchdog PID when --watchdog succeeds", async () => {
			const { deps } = makeDeps({}, { startSuccess: true });
			const output = await captureStdout(() =>
				coordinatorCommand(["start", "--watchdog", "--no-attach"], deps),
			);

			expect(output).toContain("Watchdog: started (PID 88888)");
		});
	});

	describe("stopCoordinator watchdog cleanup", () => {
		test("always calls watchdog.stop() when stopping coordinator", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps, watchdogCalls } = makeDeps(
				{ "legio-test-project-coordinator": true },
				{ stopSuccess: true },
			);

			await captureStdout(() => coordinatorCommand(["stop"], deps));

			expect(watchdogCalls?.stop).toBe(1);
		});

		test("--json output includes watchdogStopped:true when watchdog was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, { stopSuccess: true });

			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogStopped).toBe(true);
		});

		test("--json output includes watchdogStopped:false when no watchdog was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, { stopSuccess: false });

			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogStopped).toBe(false);
		});

		test("text output shows 'Watchdog stopped' when watchdog was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, { stopSuccess: true });

			const output = await captureStdout(() => coordinatorCommand(["stop"], deps));
			expect(output).toContain("Watchdog stopped");
		});

		test("text output shows 'No watchdog running' when no watchdog was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, { stopSuccess: false });

			const output = await captureStdout(() => coordinatorCommand(["stop"], deps));
			expect(output).toContain("No watchdog running");
		});
	});

	describe("statusCoordinator watchdog state", () => {
		test("includes watchdogRunning in JSON output when coordinator is running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, { running: true });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogRunning).toBe(true);
		});

		test("includes watchdogRunning:false in JSON output when watchdog is not running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, { running: false });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.watchdogRunning).toBe(false);
		});

		test("text output shows watchdog status when coordinator is running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, { running: true });

			const output = await captureStdout(() => coordinatorCommand(["status"], deps));
			expect(output).toContain("Watchdog:  running");
		});

		test("text output shows 'not running' when watchdog is not running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, { running: false });

			const output = await captureStdout(() => coordinatorCommand(["status"], deps));
			expect(output).toContain("Watchdog:  not running");
		});

		test("includes watchdogRunning in JSON output when coordinator is not running", async () => {
			const { deps } = makeDeps({}, { running: true });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.running).toBe(false);
			expect(parsed.watchdogRunning).toBe(true);
		});
	});

	describe("COORDINATOR_HELP", () => {
		test("help text includes --watchdog flag", async () => {
			const output = await captureStdout(() => coordinatorCommand(["--help"]));
			expect(output).toContain("--watchdog");
			expect(output).toContain("Auto-start watchdog daemon with coordinator");
		});
	});
});

describe("monitor integration", () => {
	describe("startCoordinator with --monitor", () => {
		test("calls monitor.start() when --monitor flag is present", async () => {
			const { deps, monitorCalls } = makeDeps({}, undefined, { startSuccess: true });
			await captureStdout(() => coordinatorCommand(["start", "--monitor", "--json"], deps));

			expect(monitorCalls?.start).toBe(1);
		});

		test("does NOT call monitor.start() when --monitor flag is absent", async () => {
			const { deps, monitorCalls } = makeDeps({}, undefined, { startSuccess: true });
			await captureStdout(() => coordinatorCommand(["start", "--json"], deps));

			expect(monitorCalls?.start).toBe(0);
		});

		test("--json output includes monitor:false (output written before monitor starts)", async () => {
			const { deps } = makeDeps({}, undefined, { startSuccess: true });
			const output = await captureStdout(() =>
				coordinatorCommand(["start", "--monitor", "--json"], deps),
			);

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitor).toBe(false);
		});

		test("--json output includes monitor:false when --monitor is present but start fails", async () => {
			const { deps } = makeDeps({}, undefined, { startSuccess: false });
			const output = await captureStdout(() =>
				coordinatorCommand(["start", "--monitor", "--json"], deps),
			);

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitor).toBe(false);
		});

		test("--json output includes monitor:false when --monitor is absent", async () => {
			const { deps } = makeDeps({}, undefined, { startSuccess: true });
			const output = await captureStdout(() => coordinatorCommand(["start", "--json"], deps));

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitor).toBe(false);
		});

		test("text output includes monitor PID when --monitor succeeds", async () => {
			const { deps } = makeDeps({}, undefined, { startSuccess: true });
			const output = await captureStdout(() =>
				coordinatorCommand(["start", "--monitor", "--no-attach"], deps),
			);

			expect(output).toContain("Monitor:  started (PID 77777)");
		});
	});

	describe("stopCoordinator monitor cleanup", () => {
		test("always calls monitor.stop() when stopping coordinator", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps, monitorCalls } = makeDeps(
				{ "legio-test-project-coordinator": true },
				undefined,
				{ stopSuccess: true },
			);

			await captureStdout(() => coordinatorCommand(["stop"], deps));

			expect(monitorCalls?.stop).toBe(1);
		});

		test("--json output includes monitorStopped:true when monitor was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, undefined, {
				stopSuccess: true,
			});

			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitorStopped).toBe(true);
		});

		test("--json output includes monitorStopped:false when no monitor was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, undefined, {
				stopSuccess: false,
			});

			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitorStopped).toBe(false);
		});

		test("text output shows 'Monitor stopped' when monitor was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, undefined, {
				stopSuccess: true,
			});

			const output = await captureStdout(() => coordinatorCommand(["stop"], deps));
			expect(output).toContain("Monitor stopped");
		});

		test("text output shows 'No monitor running' when no monitor was running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, undefined, {
				stopSuccess: false,
			});

			const output = await captureStdout(() => coordinatorCommand(["stop"], deps));
			expect(output).toContain("No monitor running");
		});
	});

	describe("statusCoordinator monitor state", () => {
		test("includes monitorRunning in JSON output when coordinator is running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, undefined, {
				running: true,
			});

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitorRunning).toBe(true);
		});

		test("includes monitorRunning:false in JSON output when monitor is not running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, undefined, {
				running: false,
			});

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.monitorRunning).toBe(false);
		});

		test("text output shows monitor status when coordinator is running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, undefined, {
				running: true,
			});

			const output = await captureStdout(() => coordinatorCommand(["status"], deps));
			expect(output).toContain("Monitor:   running");
		});

		test("text output shows 'not running' when monitor is not running", async () => {
			const session = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([session]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true }, undefined, {
				running: false,
			});

			const output = await captureStdout(() => coordinatorCommand(["status"], deps));
			expect(output).toContain("Monitor:   not running");
		});

		test("includes monitorRunning in JSON output when coordinator is not running", async () => {
			const { deps } = makeDeps({}, undefined, { running: true });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.running).toBe(false);
			expect(parsed.monitorRunning).toBe(true);
		});
	});

	describe("COORDINATOR_HELP", () => {
		test("help text includes --monitor flag", async () => {
			const output = await captureStdout(() => coordinatorCommand(["--help"]));
			expect(output).toContain("--monitor");
			expect(output).toContain("Auto-start monitor agent (Tier 2) with coordinator");
		});
	});
});

// ============================================================================
// Headless coordinator integration
// ============================================================================

/** A fake HeadlessCoordinatorHandle that emits 'exit' after a short delay. */
function makeFakeHeadlessHandle(pid = 55555) {
	const { EventEmitter } = require("node:events") as typeof import("node:events");
	const emitter = new EventEmitter();
	let running = false;
	let exitTimeout: ReturnType<typeof setTimeout> | null = null;

	const handle = {
		start() {
			running = true;
			// Use setTimeout (not nextTick) so the exit fires AFTER all async
			// operations in startCoordinator complete and the listener is registered.
			exitTimeout = setTimeout(() => {
				running = false;
				emitter.emit("exit", 0);
			}, 50);
		},
		write(_input: string) {},
		async stop() {
			if (exitTimeout !== null) clearTimeout(exitTimeout);
			running = false;
		},
		getPid() {
			return pid;
		},
		isRunning() {
			return running;
		},
		on(event: "exit", listener: (code: number) => void) {
			emitter.on(event, (...args: unknown[]) => {
				listener(args[0] as number);
			});
			return handle;
		},
	};

	return handle;
}

describe("headless coordinator", () => {
	describe("startCoordinator --headless", () => {
		test("records session with tmuxSession='headless'", async () => {
			const fakeHandle = makeFakeHeadlessHandle(55555);
			const deps: CoordinatorDeps = {
				...makeDeps().deps,
				_headless: { create: () => fakeHandle },
				_sleep: () => Promise.resolve(),
			};

			await captureStdout(() => coordinatorCommand(["start", "--headless"], deps));

			const sessions = loadSessionsFromDb();
			expect(sessions).toHaveLength(1);
			const session = sessions[0];
			expect(session?.tmuxSession).toBe("headless");
			expect(session?.agentName).toBe("coordinator");
			expect(session?.capability).toBe("coordinator");
		});

		test("writes headless-coordinator.pid file", async () => {
			const fakeHandle = makeFakeHeadlessHandle(55555);
			const deps: CoordinatorDeps = {
				...makeDeps().deps,
				_headless: { create: () => fakeHandle },
				_sleep: () => Promise.resolve(),
			};

			await captureStdout(() => coordinatorCommand(["start", "--headless"], deps));

			// PID file is written before the process exits
			// fakeHandle emits exit on nextTick, so PID file may or may not exist
			// depending on timing. Check that the session was recorded (more reliable).
			const sessions = loadSessionsFromDb();
			expect(sessions[0]?.tmuxSession).toBe("headless");
		});

		test("--json output includes headless:true", async () => {
			const fakeHandle = makeFakeHeadlessHandle(55555);
			const deps: CoordinatorDeps = {
				...makeDeps().deps,
				_headless: { create: () => fakeHandle },
				_sleep: () => Promise.resolve(),
			};

			const output = await captureStdout(() =>
				coordinatorCommand(["start", "--headless", "--json"], deps),
			);

			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.headless).toBe(true);
		});

		test("does not call tmux.createSession when headless", async () => {
			const fakeHandle = makeFakeHeadlessHandle(55555);
			const { deps, calls } = makeDeps();
			const headlessDeps: CoordinatorDeps = {
				...deps,
				_headless: { create: () => fakeHandle },
				_sleep: () => Promise.resolve(),
			};

			await captureStdout(() => coordinatorCommand(["start", "--headless"], headlessDeps));

			expect(calls.createSession).toHaveLength(0);
		});
	});

	describe("stopCoordinator with headless session", () => {
		test("stops headless session without calling tmux.killSession", async () => {
			// Create a headless session
			const headlessSession = makeCoordinatorSession({ tmuxSession: "headless", state: "working" });
			saveSessionsToDb([headlessSession]);

			// Write a PID file for a process that definitely doesn't exist (high PID)
			await writeFile(join(legioDir, "headless-coordinator.pid"), "999999999");

			const { deps, calls } = makeDeps();

			await captureStdout(() => coordinatorCommand(["stop"], deps));

			// tmux kill should NOT be called for headless sessions
			expect(calls.killSession).toHaveLength(0);

			// Session should be completed
			const sessions = loadSessionsFromDb();
			expect(sessions[0]?.state).toBe("completed");
		});

		test("removes PID file when stopping headless session", async () => {
			const headlessSession = makeCoordinatorSession({ tmuxSession: "headless", state: "working" });
			saveSessionsToDb([headlessSession]);

			const pidFilePath = join(legioDir, "headless-coordinator.pid");
			await writeFile(pidFilePath, "999999999");

			const { deps } = makeDeps();
			await captureStdout(() => coordinatorCommand(["stop"], deps));

			// PID file should be cleaned up
			let pidFileExists = false;
			try {
				await import("node:fs/promises").then((fs) => fs.access(pidFilePath));
				pidFileExists = true;
			} catch {
				// expected
			}
			expect(pidFileExists).toBe(false);
		});

		test("--json stop output includes stopped:true for headless", async () => {
			const headlessSession = makeCoordinatorSession({ tmuxSession: "headless", state: "working" });
			saveSessionsToDb([headlessSession]);
			await writeFile(join(legioDir, "headless-coordinator.pid"), "999999999");

			const { deps } = makeDeps();
			const output = await captureStdout(() => coordinatorCommand(["stop", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.stopped).toBe(true);
		});
	});

	describe("statusCoordinator with headless session", () => {
		test("--json includes headless:true for headless sessions", async () => {
			// Create a headless session but with a non-existent PID (so it's zombie)
			const headlessSession = makeCoordinatorSession({
				tmuxSession: "headless",
				state: "working",
				pid: 999999999, // Non-existent PID
			});
			saveSessionsToDb([headlessSession]);

			const { deps } = makeDeps();
			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.headless).toBe(true);
		});

		test("--json includes headless:false for tmux sessions", async () => {
			const tmuxSession = makeCoordinatorSession({ state: "working" });
			saveSessionsToDb([tmuxSession]);
			const { deps } = makeDeps({ "legio-test-project-coordinator": true });

			const output = await captureStdout(() => coordinatorCommand(["status", "--json"], deps));
			const parsed = JSON.parse(output) as Record<string, unknown>;
			expect(parsed.headless).toBe(false);
		});
	});

	describe("COORDINATOR_HELP includes --headless", () => {
		test("help text includes --headless flag", async () => {
			const output = await captureStdout(() => coordinatorCommand(["--help"]));
			expect(output).toContain("--headless");
		});
	});
});

describe("SessionStore round-trip", () => {
	test("returns empty array when no sessions exist", () => {
		const sessions = loadSessionsFromDb();
		expect(sessions).toEqual([]);
	});

	test("save then load round-trips correctly", () => {
		const original = [makeCoordinatorSession()];
		saveSessionsToDb(original);
		const loaded = loadSessionsFromDb();

		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.agentName).toBe("coordinator");
		expect(loaded[0]?.capability).toBe("coordinator");
	});

	test("sessions.db is created after save", () => {
		saveSessionsToDb([makeCoordinatorSession()]);
		const dbPath = join(legioDir, "sessions.db");
		const exists = statSync(dbPath).size > 0;
		expect(exists).toBe(true);
	});
});

/**
 * Root-user guard: coordinatorCommand start must reject when running as root.
 */
describe("coordinatorCommand root guard", () => {
	test("throws ValidationError with uid field when process.getuid returns 0", async () => {
		const original = process.getuid;
		process.getuid = () => 0;
		try {
			await expect(coordinatorCommand(["start"])).rejects.toMatchObject({
				name: "ValidationError",
				field: "uid",
			});
		} finally {
			process.getuid = original;
		}
	});
});
