/**
 * Tests for legio gateway command.
 *
 * Uses real temp directories and real git repos for file I/O and config loading.
 * Tmux is injected via the GatewayDeps DI interface instead of
 * mock.module() to avoid the process-global mock leak issue
 * (see mulch record mx-56558b).
 *
 * WHY DI instead of mock.module: mock.module() in vitest is process-global
 * and leaks across test files. The DI approach (same pattern as coordinator.ts
 * _tmux/_sleep) ensures mocks are scoped to each test invocation.
 */

import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { buildGatewayBeacon, type GatewayDeps, gatewayCommand, resolveAttach } from "./gateway.ts";

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

/** Build a fake tmux DI object with configurable session liveness. */
function makeFakeTmux(sessionAliveMap: Record<string, boolean> = {}): {
	tmux: NonNullable<GatewayDeps["_tmux"]>;
	calls: TmuxCallTracker;
} {
	const calls: TmuxCallTracker = {
		createSession: [],
		isSessionAlive: [],
		killSession: [],
		sendKeys: [],
	};

	const tmux: NonNullable<GatewayDeps["_tmux"]> = {
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
		waitForTuiReady: async (): Promise<void> => {},
		capturePaneContent: async (): Promise<string> => "",
	};

	return { tmux, calls };
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
			gateway: {
				file: "gateway.md",
				model: "sonnet",
				tools: ["Read", "Bash"],
				capabilities: ["plan"],
				canSpawn: false,
				constraints: [],
			},
		},
		capabilityIndex: { plan: ["gateway"] },
	};
	await writeFile(
		join(legioDir, "agent-manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	await writeFile(join(agentDefsDir, "gateway.md"), "# Gateway\n");

	vi.spyOn(process, "cwd").mockReturnValue(tempDir);
}, 30000); // 30s timeout: createTempGitRepo can be slow on first run

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

// --- Helpers ---

function makeGatewaySession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: `session-${Date.now()}-gateway`,
		agentName: "gateway",
		capability: "gateway",
		worktreePath: tempDir,
		branchName: "main",
		beadId: "",
		tmuxSession: "legio-test-project-gateway",
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

/** Build default GatewayDeps with fake tmux and sleep.
 * Always injects fakes for tmux to prevent real tmux calls in tests. */
function makeDeps(sessionAliveMap: Record<string, boolean> = {}): {
	deps: GatewayDeps;
	calls: TmuxCallTracker;
} {
	const { tmux, calls } = makeFakeTmux(sessionAliveMap);

	const deps: GatewayDeps = {
		_tmux: tmux,
		_sleep: () => Promise.resolve(),
	};

	return { deps, calls };
}

// --- Tests ---

describe("gatewayCommand help", () => {
	test("--help outputs help text", async () => {
		const output = await captureStdout(() => gatewayCommand(["--help"]));
		expect(output).toContain("legio gateway");
		expect(output).toContain("start");
		expect(output).toContain("stop");
		expect(output).toContain("status");
	});

	test("--help includes --attach and --no-attach flags", async () => {
		const output = await captureStdout(() => gatewayCommand(["--help"]));
		expect(output).toContain("--attach");
		expect(output).toContain("--no-attach");
	});

	test("-h outputs help text", async () => {
		const output = await captureStdout(() => gatewayCommand(["-h"]));
		expect(output).toContain("legio gateway");
	});

	test("empty args outputs help text", async () => {
		const output = await captureStdout(() => gatewayCommand([]));
		expect(output).toContain("legio gateway");
		expect(output).toContain("Subcommands:");
	});
});

describe("gatewayCommand unknown subcommand", () => {
	test("throws ValidationError for unknown subcommand", async () => {
		await expect(gatewayCommand(["frobnicate"])).rejects.toThrow(ValidationError);
	});

	test("error message includes the bad subcommand name", async () => {
		try {
			await gatewayCommand(["frobnicate"]);
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

describe("startGateway", () => {
	test("writes session to sessions.db with correct fields", async () => {
		const { deps, calls } = makeDeps();

		await captureStdout(() => gatewayCommand(["start"], deps));

		// Verify sessions.db was written
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);

		const session = sessions[0];
		expect(session).toBeDefined();
		expect(session?.agentName).toBe("gateway");
		expect(session?.capability).toBe("gateway");
		expect(session?.tmuxSession).toBe("legio-test-project-gateway");
		expect(session?.state).toBe("booting");
		expect(session?.pid).toBe(99999);
		expect(session?.parentAgent).toBeNull();
		expect(session?.depth).toBe(0);
		expect(session?.beadId).toBe("");
		expect(session?.branchName).toBe("main");
		expect(session?.worktreePath).toBe(tempDir);
		expect(session?.id).toMatch(/^session-\d+-gateway$/);

		// Verify tmux createSession was called
		expect(calls.createSession).toHaveLength(1);
		expect(calls.createSession[0]?.name).toBe("legio-test-project-gateway");
		expect(calls.createSession[0]?.cwd).toBe(tempDir);

		// Verify sendKeys was called (beacon + follow-up Enter)
		expect(calls.sendKeys.length).toBeGreaterThanOrEqual(1);
	});

	test("deploys hooks to project root .claude/settings.local.json", async () => {
		const { deps } = makeDeps();

		await captureStdout(() => gatewayCommand(["start", "--no-attach"], deps));

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

	test("hooks use gateway agent name for event logging", async () => {
		const { deps } = makeDeps();

		await captureStdout(() => gatewayCommand(["start", "--no-attach"], deps));

		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		const content = await readFile(settingsPath, "utf-8");

		// The hooks should reference the gateway agent name
		expect(content).toContain("--agent gateway");
	});

	test("hooks include ENV_GUARD to avoid affecting user's Claude Code session", async () => {
		const { deps } = makeDeps();

		await captureStdout(() => gatewayCommand(["start", "--no-attach"], deps));

		const settingsPath = join(tempDir, ".claude", "settings.local.json");
		const content = await readFile(settingsPath, "utf-8");

		// PreToolUse guards should include the ENV_GUARD prefix
		expect(content).toContain("LEGIO_AGENT_NAME");
	});

	test("injects agent definition via --settings file when agent-defs/gateway.md exists", async () => {
		// Deploy a gateway agent definition
		const agentDefsDir = join(legioDir, "agent-defs");
		await mkdir(agentDefsDir, { recursive: true });
		await writeFile(join(agentDefsDir, "gateway.md"), "# Gateway Agent\n\nYou are the gateway.\n");

		const { deps, calls } = makeDeps();

		await captureStdout(() => gatewayCommand(["start", "--no-attach", "--json"], deps));

		expect(calls.createSession).toHaveLength(1);
		const cmd = calls.createSession[0]?.command ?? "";
		// Agent def is written to a settings JSON file and passed via --settings
		expect(cmd).toContain("--settings");
		expect(cmd).toContain("settings-gateway.json");

		// Verify the settings file was written with the agent def
		const { readFileSync } = await import("node:fs");
		const settingsPath = join(legioDir, "settings-gateway.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		expect(settings.appendSystemPrompt).toContain("# Gateway Agent");
		expect(settings.skipDangerousModePermissionPrompt).toBe(true);
	});

	test("reads model from manifest instead of hardcoding", async () => {
		// Override the manifest to use opus instead of default sonnet
		const manifest = {
			version: "1.0",
			agents: {
				gateway: {
					file: "gateway.md",
					model: "opus",
					tools: ["Read", "Bash"],
					capabilities: ["plan"],
					canSpawn: false,
					constraints: [],
				},
			},
			capabilityIndex: { plan: ["gateway"] },
		};
		await writeFile(
			join(legioDir, "agent-manifest.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);

		const { deps, calls } = makeDeps();

		await captureStdout(() => gatewayCommand(["start", "--no-attach", "--json"], deps));

		expect(calls.createSession).toHaveLength(1);
		const cmd = calls.createSession[0]?.command ?? "";
		expect(cmd).toContain("--model opus");
		expect(cmd).not.toContain("--model sonnet");
	});

	test("defaults to opus model when not in manifest", async () => {
		// Write manifest without gateway entry so resolveModel falls back to default
		const manifest = {
			version: "1.0",
			agents: {},
			capabilityIndex: {},
		};
		await writeFile(
			join(legioDir, "agent-manifest.json"),
			`${JSON.stringify(manifest, null, "\t")}\n`,
		);

		const { deps, calls } = makeDeps();

		await captureStdout(() => gatewayCommand(["start", "--no-attach", "--json"], deps));

		expect(calls.createSession).toHaveLength(1);
		const cmd = calls.createSession[0]?.command ?? "";
		expect(cmd).toContain("--model opus");
	});

	test("--json outputs JSON with expected fields", async () => {
		const { deps } = makeDeps();

		const output = await captureStdout(() => gatewayCommand(["start", "--json"], deps));

		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.agentName).toBe("gateway");
		expect(parsed.capability).toBe("gateway");
		expect(parsed.tmuxSession).toBe("legio-test-project-gateway");
		expect(parsed.pid).toBe(99999);
		expect(parsed.projectRoot).toBe(tempDir);
	});

	test("rejects duplicate when gateway is already running", async () => {
		// Write an existing active gateway session
		const existing = makeGatewaySession({ state: "working" });
		saveSessionsToDb([existing]);

		// Mock tmux as alive for the existing session
		const { deps } = makeDeps({ "legio-test-project-gateway": true });

		await expect(gatewayCommand(["start"], deps)).rejects.toThrow(AgentError);

		try {
			await gatewayCommand(["start"], deps);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const ae = err as AgentError;
			expect(ae.message).toContain("already running");
		}
	});

	test("sends FIRST_RUN beacon on first run (no existing identity)", async () => {
		const { deps, calls } = makeDeps();

		await captureStdout(() => gatewayCommand(["start", "--no-attach"], deps));

		// First sendKeys call should be the beacon
		const beaconCall = calls.sendKeys.find((c) => c.keys.includes("[LEGIO]"));
		expect(beaconCall).toBeDefined();
		expect(beaconCall?.keys).toContain("FIRST_RUN: true");
	});

	test("does not send FIRST_RUN beacon on subsequent runs (identity exists)", async () => {
		// Create identity first so it exists before starting
		const identityDir = join(legioDir, "agents", "gateway");
		await mkdir(identityDir, { recursive: true });
		await writeFile(
			join(identityDir, "identity.yaml"),
			[
				"name: gateway",
				"capability: gateway",
				`created: ${new Date().toISOString()}`,
				"sessionsCompleted: 1",
				"expertiseDomains: []",
				"recentTasks: []",
			].join("\n"),
		);

		const { deps, calls } = makeDeps();

		await captureStdout(() => gatewayCommand(["start", "--no-attach"], deps));

		const beaconCall = calls.sendKeys.find((c) => c.keys.includes("[LEGIO]"));
		expect(beaconCall).toBeDefined();
		expect(beaconCall?.keys).not.toContain("FIRST_RUN");
	});

	test("cleans up dead session and starts new one", async () => {
		// Write an existing session that claims to be working
		const deadSession = makeGatewaySession({
			id: "session-dead-gateway",
			state: "working",
		});
		saveSessionsToDb([deadSession]);

		// Mock tmux as NOT alive for the existing session
		const { deps } = makeDeps({ "legio-test-project-gateway": false });

		await captureStdout(() => gatewayCommand(["start"], deps));

		// SessionStore uses UNIQUE(agent_name), so the new session replaces the old one.
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);

		const newSession = sessions[0];
		expect(newSession).toBeDefined();
		expect(newSession?.state).toBe("booting");
		expect(newSession?.agentName).toBe("gateway");
		// The new session should have a different ID than the dead one
		expect(newSession?.id).not.toBe("session-dead-gateway");
	});

	test("sends greeting mail to human after beacon delivery", async () => {
		const { deps } = makeDeps();
		await captureStdout(() => gatewayCommand(["start", "--no-attach"], deps));
		// Verify mail.db has the greeting
		const { createMailStore } = await import("../mail/store.ts");
		const mailDb = createMailStore(join(legioDir, "mail.db"));
		try {
			const msgs = mailDb.getAll({ from: "gateway", to: "human" });
			expect(msgs).toHaveLength(1);
			expect(msgs[0]?.subject).toBe("Gateway online");
			expect(msgs[0]?.body).toContain("online and ready");
			expect(msgs[0]?.type).toBe("status");
			expect(msgs[0]?.audience).toBe("human");
		} finally {
			mailDb.close();
		}
	});
});

describe("stopGateway", () => {
	test("marks session as completed after stopping", async () => {
		const session = makeGatewaySession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is alive so killSession will be called
		const { deps, calls } = makeDeps({ "legio-test-project-gateway": true });

		await captureStdout(() => gatewayCommand(["stop"], deps));

		// Verify session is now completed
		const sessions = loadSessionsFromDb();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.state).toBe("completed");

		// Verify killSession was called
		expect(calls.killSession).toHaveLength(1);
		expect(calls.killSession[0]?.name).toBe("legio-test-project-gateway");
	});

	test("--json outputs JSON with stopped flag", async () => {
		const session = makeGatewaySession({ state: "working" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "legio-test-project-gateway": true });

		const output = await captureStdout(() => gatewayCommand(["stop", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.stopped).toBe(true);
		expect(parsed.sessionId).toBe(session.id);
	});

	test("handles already-dead tmux session gracefully", async () => {
		const session = makeGatewaySession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is NOT alive — should skip killSession
		const { deps, calls } = makeDeps({ "legio-test-project-gateway": false });

		await captureStdout(() => gatewayCommand(["stop"], deps));

		// Verify session is completed
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("completed");

		// killSession should NOT have been called since session was already dead
		expect(calls.killSession).toHaveLength(0);
	});

	test("throws AgentError when no gateway session exists", async () => {
		const { deps } = makeDeps();

		await expect(gatewayCommand(["stop"], deps)).rejects.toThrow(AgentError);

		try {
			await gatewayCommand(["stop"], deps);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentError);
			const ae = err as AgentError;
			expect(ae.message).toContain("No active gateway session");
		}
	});

	test("throws AgentError when only completed sessions exist", async () => {
		const completed = makeGatewaySession({ state: "completed" });
		saveSessionsToDb([completed]);
		const { deps } = makeDeps();

		await expect(gatewayCommand(["stop"], deps)).rejects.toThrow(AgentError);
	});
});

describe("statusGateway", () => {
	test("shows 'not running' when no session exists", async () => {
		const { deps } = makeDeps();
		const output = await captureStdout(() => gatewayCommand(["status"], deps));
		expect(output).toContain("not running");
	});

	test("--json shows running:false when no session exists", async () => {
		const { deps } = makeDeps();
		const output = await captureStdout(() => gatewayCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
	});

	test("shows running state when gateway is alive", async () => {
		const session = makeGatewaySession({ state: "working" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "legio-test-project-gateway": true });

		const output = await captureStdout(() => gatewayCommand(["status"], deps));
		expect(output).toContain("running");
		expect(output).toContain(session.id);
		expect(output).toContain("legio-test-project-gateway");
	});

	test("--json shows correct fields when running", async () => {
		const session = makeGatewaySession({ state: "working", pid: 99999 });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "legio-test-project-gateway": true });

		const output = await captureStdout(() => gatewayCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(true);
		expect(parsed.sessionId).toBe(session.id);
		expect(parsed.state).toBe("working");
		expect(parsed.tmuxSession).toBe("legio-test-project-gateway");
		expect(parsed.pid).toBe(99999);
	});

	test("reconciles zombie: updates state when tmux is dead but session says working", async () => {
		const session = makeGatewaySession({ state: "working" });
		saveSessionsToDb([session]);

		// Tmux is NOT alive — triggers zombie reconciliation
		const { deps } = makeDeps({ "legio-test-project-gateway": false });

		const output = await captureStdout(() => gatewayCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
		expect(parsed.state).toBe("zombie");

		// Verify sessions.db was updated
		const sessions = loadSessionsFromDb();
		expect(sessions[0]?.state).toBe("zombie");
	});

	test("reconciles zombie for booting state too", async () => {
		const session = makeGatewaySession({ state: "booting" });
		saveSessionsToDb([session]);
		const { deps } = makeDeps({ "legio-test-project-gateway": false });

		const output = await captureStdout(() => gatewayCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.state).toBe("zombie");
	});

	test("does not show completed sessions as active", async () => {
		const completed = makeGatewaySession({ state: "completed" });
		saveSessionsToDb([completed]);
		const { deps } = makeDeps();

		const output = await captureStdout(() => gatewayCommand(["status", "--json"], deps));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.running).toBe(false);
	});
});

describe("buildGatewayBeacon", () => {
	test("is a single line (no newlines)", () => {
		const beacon = buildGatewayBeacon();
		expect(beacon).not.toContain("\n");
	});

	test("includes gateway identity in header", () => {
		const beacon = buildGatewayBeacon();
		expect(beacon).toContain("[LEGIO] gateway (gateway)");
	});

	test("includes ISO timestamp", () => {
		const beacon = buildGatewayBeacon();
		expect(beacon).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	test("includes depth and role info", () => {
		const beacon = buildGatewayBeacon();
		expect(beacon).toContain("Depth: 0 | Role: planning companion");
	});

	test("includes READONLY notice", () => {
		const beacon = buildGatewayBeacon();
		expect(beacon).toContain("READONLY: No Write/Edit");
	});

	test("includes ISSUES notice", () => {
		const beacon = buildGatewayBeacon();
		expect(beacon).toContain("ISSUES: Use bd create");
	});

	test("includes startup instructions", () => {
		const beacon = buildGatewayBeacon();
		expect(beacon).toContain("mulch prime");
		expect(beacon).toContain("legio mail check --agent gateway");
		expect(beacon).toContain("respond to user via BOTH terminal AND mail");
	});

	test("parts are joined with em-dash separator", () => {
		const beacon = buildGatewayBeacon();
		// Should have exactly 4 " — " separators (5 parts)
		const dashes = beacon.split(" — ");
		expect(dashes).toHaveLength(5);
	});

	test("default (no args) does not include FIRST_RUN", () => {
		const beacon = buildGatewayBeacon();
		expect(beacon).not.toContain("FIRST_RUN");
	});

	test("isFirstRun=false does not include FIRST_RUN", () => {
		const beacon = buildGatewayBeacon(false);
		expect(beacon).not.toContain("FIRST_RUN");
	});

	test("isFirstRun=true includes FIRST_RUN flag", () => {
		const beacon = buildGatewayBeacon(true);
		expect(beacon).toContain("FIRST_RUN: true");
		expect(beacon).toContain("Follow the First Run workflow");
	});

	test("isFirstRun=true beacon is longer than default", () => {
		const normal = buildGatewayBeacon(false);
		const firstRun = buildGatewayBeacon(true);
		expect(firstRun.length).toBeGreaterThan(normal.length);
		// The FIRST_RUN part is appended as an additional em-dash separated segment
		expect(firstRun).toContain("FIRST_RUN: true");
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
