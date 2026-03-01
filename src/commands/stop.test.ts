/**
 * Tests for legio stop command.
 *
 * Uses real temp directories, real git repos, and real SQLite session stores.
 * Tmux operations are injected via StopDeps._tmux DI to avoid real tmux calls
 * in CI (real tmux would interfere with developer sessions).
 *
 * WHY DI instead of mock.module: mock.module() in vitest is process-global
 * and leaks across test files. DI keeps mocks scoped to each test invocation.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSessionStore } from "../sessions/compat.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { AgentSession } from "../types.ts";
import { type StopDeps, stopCommand } from "./stop.ts";

// ---------------------------------------------------------------------------
// Fake tmux helper
// ---------------------------------------------------------------------------

interface TmuxCallTracker {
	isSessionAlive: Array<{ name: string; result: boolean }>;
	killSession: Array<{ name: string }>;
}

/** Build a fake tmux DI that tracks calls and reports sessions as alive/dead. */
function makeFakeTmux(aliveMap: Record<string, boolean> = {}): {
	tmux: NonNullable<StopDeps["_tmux"]>;
	calls: TmuxCallTracker;
} {
	const calls: TmuxCallTracker = { isSessionAlive: [], killSession: [] };
	const tmux: NonNullable<StopDeps["_tmux"]> = {
		isSessionAlive: async (name: string): Promise<boolean> => {
			const alive = aliveMap[name] ?? false;
			calls.isSessionAlive.push({ name, result: alive });
			return alive;
		},
		killSession: async (name: string): Promise<void> => {
			calls.killSession.push({ name });
		},
	};
	return { tmux, calls };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let legioDir: string;

/** Make a minimal AgentSession for inserting into the store. */
function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: `session-${Date.now()}-${Math.random()}`,
		agentName: "test-builder",
		capability: "builder",
		worktreePath: join(tempDir, ".legio", "worktrees", "test-builder"),
		branchName: "legio/test-builder/legio-abc1",
		beadId: "legio-abc1",
		tmuxSession: "legio-test-project-test-builder",
		state: "working",
		pid: null,
		parentAgent: null,
		depth: 2,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		...overrides,
	};
}

/** Capture stdout output during an async call. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const orig = process.stdout.write;
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = orig;
	}
	return chunks.join("");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	legioDir = join(tempDir, ".legio");
	await mkdir(legioDir, { recursive: true });

	// Minimal config.yaml so loadConfig succeeds
	await writeFile(
		join(legioDir, "config.yaml"),
		["project:", "  name: test-project", `  root: ${tempDir}`, "  canonicalBranch: main"].join(
			"\n",
		),
	);

	vi.spyOn(process, "cwd").mockReturnValue(tempDir);
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("stopCommand — help", () => {
	it("prints help for --help", async () => {
		const { tmux } = makeFakeTmux();
		const out = await captureStdout(async () => {
			await stopCommand(["--help"], { _tmux: tmux, _projectRoot: tempDir });
		});
		expect(out).toContain("legio stop");
		expect(out).toContain("--agent");
		expect(out).toContain("--json");
	});

	it("prints help for -h", async () => {
		const { tmux } = makeFakeTmux();
		const out = await captureStdout(async () => {
			await stopCommand(["-h"], { _tmux: tmux, _projectRoot: tempDir });
		});
		expect(out).toContain("legio stop");
	});
});

describe("stopCommand — nothing to stop", () => {
	it("prints Nothing to stop when no active sessions", async () => {
		const { tmux, calls } = makeFakeTmux();
		const out = await captureStdout(async () => {
			await stopCommand([], { _tmux: tmux, _projectRoot: tempDir });
		});
		expect(out).toContain("Nothing to stop");
		expect(calls.killSession).toHaveLength(0);
	});

	it("outputs JSON with nothingToStop=true and empty stopped array", async () => {
		const { tmux } = makeFakeTmux();
		const out = await captureStdout(async () => {
			await stopCommand(["--json"], { _tmux: tmux, _projectRoot: tempDir });
		});
		const parsed = JSON.parse(out.trim()) as { stopped: string[]; nothingToStop: boolean };
		expect(parsed.nothingToStop).toBe(true);
		expect(parsed.stopped).toHaveLength(0);
	});
});

describe("stopCommand — single session", () => {
	it("kills a live tmux session and marks it completed", async () => {
		// Insert a session into the real store
		const { store } = openSessionStore(legioDir);
		const session = makeSession({
			agentName: "my-builder",
			tmuxSession: "legio-test-project-my-builder",
		});
		store.upsert(session);
		store.close();

		const { tmux, calls } = makeFakeTmux({ "legio-test-project-my-builder": true });

		const out = await captureStdout(async () => {
			await stopCommand([], { _tmux: tmux, _projectRoot: tempDir });
		});

		expect(calls.killSession).toHaveLength(1);
		expect(calls.killSession[0]?.name).toBe("legio-test-project-my-builder");
		expect(out).toContain("my-builder");
		expect(out).toContain("Stopped 1 agent");

		// Verify session is marked completed
		const { store: store2 } = openSessionStore(legioDir);
		const updated = store2.getByName("my-builder");
		store2.close();
		expect(updated?.state).toBe("completed");
	});

	it("skips killSession when tmux session is already dead", async () => {
		const { store } = openSessionStore(legioDir);
		store.upsert(makeSession({ agentName: "dead-builder", tmuxSession: "legio-dead" }));
		store.close();

		const { tmux, calls } = makeFakeTmux({ "legio-dead": false }); // dead

		await captureStdout(async () => {
			await stopCommand([], { _tmux: tmux, _projectRoot: tempDir });
		});

		expect(calls.isSessionAlive).toHaveLength(1);
		expect(calls.killSession).toHaveLength(0); // skip kill for dead sessions
	});

	it("outputs JSON with stopped agent name", async () => {
		const { store } = openSessionStore(legioDir);
		store.upsert(makeSession({ agentName: "json-builder", tmuxSession: "legio-json" }));
		store.close();

		const { tmux } = makeFakeTmux({ "legio-json": true });
		const out = await captureStdout(async () => {
			await stopCommand(["--json"], { _tmux: tmux, _projectRoot: tempDir });
		});

		const parsed = JSON.parse(out.trim()) as { stopped: string[]; nothingToStop: boolean };
		expect(parsed.nothingToStop).toBe(false);
		expect(parsed.stopped).toContain("json-builder");
	});
});

describe("stopCommand — deepest-first ordering", () => {
	it("kills deeper sessions before shallower ones", async () => {
		const { store } = openSessionStore(legioDir);
		// Insert a lead (depth=1) and a builder (depth=2) — builder should die first
		store.upsert(
			makeSession({
				agentName: "my-lead",
				depth: 1,
				tmuxSession: "legio-lead",
			}),
		);
		store.upsert(
			makeSession({
				agentName: "my-builder",
				depth: 2,
				tmuxSession: "legio-builder",
			}),
		);
		store.close();

		const killOrder: string[] = [];
		const tmux: NonNullable<StopDeps["_tmux"]> = {
			isSessionAlive: async () => true,
			killSession: async (name: string) => {
				killOrder.push(name);
			},
		};

		await captureStdout(async () => {
			await stopCommand([], { _tmux: tmux, _projectRoot: tempDir });
		});

		// Builder (depth 2) should die before lead (depth 1)
		expect(killOrder[0]).toBe("legio-builder");
		expect(killOrder[1]).toBe("legio-lead");
	});

	it("handles sessions at equal depth in any order", async () => {
		const { store } = openSessionStore(legioDir);
		store.upsert(makeSession({ agentName: "builder-a", depth: 2, tmuxSession: "legio-a" }));
		store.upsert(makeSession({ agentName: "builder-b", depth: 2, tmuxSession: "legio-b" }));
		store.close();

		const killOrder: string[] = [];
		const tmux: NonNullable<StopDeps["_tmux"]> = {
			isSessionAlive: async () => true,
			killSession: async (name: string) => {
				killOrder.push(name);
			},
		};

		await captureStdout(async () => {
			await stopCommand([], { _tmux: tmux, _projectRoot: tempDir });
		});

		// Both should be killed, order within same depth is unspecified
		expect(killOrder).toHaveLength(2);
		expect(killOrder).toContain("legio-a");
		expect(killOrder).toContain("legio-b");
	});

	it("correctly orders 3 levels deep", async () => {
		const { store } = openSessionStore(legioDir);
		store.upsert(makeSession({ agentName: "coord", depth: 0, tmuxSession: "legio-coord" }));
		store.upsert(makeSession({ agentName: "lead", depth: 1, tmuxSession: "legio-lead" }));
		store.upsert(makeSession({ agentName: "builder", depth: 2, tmuxSession: "legio-builder" }));
		store.close();

		const killOrder: string[] = [];
		const tmux: NonNullable<StopDeps["_tmux"]> = {
			isSessionAlive: async () => true,
			killSession: async (name: string) => {
				killOrder.push(name);
			},
		};

		await captureStdout(async () => {
			await stopCommand([], { _tmux: tmux, _projectRoot: tempDir });
		});

		expect(killOrder[0]).toBe("legio-builder");
		expect(killOrder[1]).toBe("legio-lead");
		expect(killOrder[2]).toBe("legio-coord");
	});
});

describe("stopCommand — --agent filter", () => {
	it("stops only the specified agent when --agent is given", async () => {
		const { store } = openSessionStore(legioDir);
		store.upsert(makeSession({ agentName: "target-agent", tmuxSession: "legio-target" }));
		store.upsert(makeSession({ agentName: "other-agent", tmuxSession: "legio-other" }));
		store.close();

		const { tmux, calls } = makeFakeTmux({
			"legio-target": true,
			"legio-other": true,
		});

		const out = await captureStdout(async () => {
			await stopCommand(["--agent", "target-agent"], { _tmux: tmux, _projectRoot: tempDir });
		});

		// Only target should be killed
		expect(calls.killSession).toHaveLength(1);
		expect(calls.killSession[0]?.name).toBe("legio-target");
		expect(out).toContain("target-agent");
	});

	it("throws AgentError when --agent specifies a non-existent agent", async () => {
		const { tmux } = makeFakeTmux();
		await expect(
			stopCommand(["--agent", "nonexistent"], { _tmux: tmux, _projectRoot: tempDir }),
		).rejects.toThrow("No session found for agent 'nonexistent'");
	});
});

describe("stopCommand — completed sessions not stopped again", () => {
	it("does not stop sessions already in completed state", async () => {
		const { store } = openSessionStore(legioDir);
		// Insert a completed session — should not appear in getActive()
		store.upsert(makeSession({ agentName: "done-agent", state: "completed" }));
		store.close();

		const { tmux, calls } = makeFakeTmux();
		const out = await captureStdout(async () => {
			await stopCommand([], { _tmux: tmux, _projectRoot: tempDir });
		});

		expect(calls.killSession).toHaveLength(0);
		expect(out).toContain("Nothing to stop");
	});
});
