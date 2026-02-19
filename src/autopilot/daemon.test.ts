/**
 * Tests for the autopilot daemon.
 *
 * Uses real SQLite in-memory mail store and injectable DI for merge/worktree
 * operations. Does NOT start real subprocesses.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailStore } from "../mail/store.ts";
import type { AutopilotDeps, AutopilotMailDeps } from "./daemon.ts";
import { createAutopilot, runAutopilotTick } from "./daemon.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "autopilot-test-"));
	await mkdir(join(tempDir, ".legio"), { recursive: true });
	await writeFile(join(tempDir, ".legio", "config.yaml"), "project:\n  root: .\n", "utf-8");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Create an in-memory mail dep backed by a real SQLite store. */
function createInMemoryMailDeps(dbPath: string): AutopilotMailDeps {
	const store = createMailStore(dbPath);
	return {
		getUnread(agent: string) {
			return store.getUnread(agent);
		},
		markRead(id: string) {
			store.markRead(id);
		},
	};
}

/** Build a minimal AutopilotDeps with no-op merge/worktree. */
function makeDeps(overrides?: Partial<AutopilotDeps>): AutopilotDeps {
	return {
		_merge: {
			async mergeBranch(_root, branch) {
				return { success: true, output: `merged ${branch}` };
			},
		},
		_worktree: {
			async cleanCompleted(_root) {
				// no-op
			},
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// createAutopilot lifecycle
// ---------------------------------------------------------------------------

describe("createAutopilot", () => {
	it("creates a stopped instance with default config", () => {
		const autopilot = createAutopilot(tempDir);
		const state = autopilot.getState();

		expect(state.running).toBe(false);
		expect(state.startedAt).toBeNull();
		expect(state.stoppedAt).toBeNull();
		expect(state.lastTick).toBeNull();
		expect(state.tickCount).toBe(0);
		expect(state.actions).toEqual([]);
		expect(state.config.intervalMs).toBe(10_000);
		expect(state.config.autoMerge).toBe(true);
		expect(state.config.autoCleanWorktrees).toBe(false);
		expect(state.config.maxActionsLog).toBe(100);
	});

	it("accepts partial config overrides", () => {
		const autopilot = createAutopilot(tempDir, { intervalMs: 5_000, autoMerge: false });
		const state = autopilot.getState();

		expect(state.config.intervalMs).toBe(5_000);
		expect(state.config.autoMerge).toBe(false);
		expect(state.config.maxActionsLog).toBe(100); // default preserved
	});
});

describe("start / stop lifecycle", () => {
	it("start() sets running=true and records startedAt", () => {
		const autopilot = createAutopilot(tempDir, { intervalMs: 100_000 }, makeDeps());
		autopilot.start();
		const state = autopilot.getState();

		expect(state.running).toBe(true);
		expect(state.startedAt).not.toBeNull();
		expect(state.stoppedAt).toBeNull();

		autopilot.stop();
	});

	it("stop() sets running=false and records stoppedAt", () => {
		const autopilot = createAutopilot(tempDir, { intervalMs: 100_000 }, makeDeps());
		autopilot.start();
		autopilot.stop();
		const state = autopilot.getState();

		expect(state.running).toBe(false);
		expect(state.stoppedAt).not.toBeNull();
	});

	it("start() is idempotent — second call does nothing", () => {
		const autopilot = createAutopilot(tempDir, { intervalMs: 100_000 }, makeDeps());
		autopilot.start();
		const startedAt = autopilot.getState().startedAt;
		autopilot.start(); // should be no-op
		expect(autopilot.getState().startedAt).toBe(startedAt);

		autopilot.stop();
	});

	it("stop() on a stopped autopilot does not throw", () => {
		const autopilot = createAutopilot(tempDir, { intervalMs: 100_000 }, makeDeps());
		expect(() => autopilot.stop()).not.toThrow();
	});
});

describe("getState", () => {
	it("returns a snapshot — mutations to returned state do not affect internal state", () => {
		const autopilot = createAutopilot(tempDir);
		const state = autopilot.getState();
		state.running = true; // mutate returned snapshot
		state.tickCount = 999;

		const state2 = autopilot.getState();
		expect(state2.running).toBe(false); // unchanged
		expect(state2.tickCount).toBe(0); // unchanged
	});
});

// ---------------------------------------------------------------------------
// runAutopilotTick
// ---------------------------------------------------------------------------

describe("runAutopilotTick", () => {
	it("returns empty array when there is no mail", async () => {
		const mailDeps = createInMemoryMailDeps(":memory:");
		const state = createAutopilot(tempDir).getState();
		const actions = await runAutopilotTick(tempDir, state, {
			...makeDeps(),
			_mail: mailDeps,
		});

		expect(actions).toEqual([]);
	});

	it("processes merge_ready mail and triggers merge when autoMerge=true", async () => {
		const dbPath = join(tempDir, "mail.db");
		const mailDeps = createInMemoryMailDeps(dbPath);
		const rawStore = createMailStore(dbPath);

		// Insert a merge_ready message for coordinator
		rawStore.insert({
			id: "msg-001",
			from: "supervisor-1",
			to: "coordinator",
			subject: "Branch ready: legio/builder-1/task-1",
			body: "Ready to merge",
			type: "merge_ready",
			priority: "normal",
			threadId: null,
			payload: JSON.stringify({
				branch: "legio/builder-1/task-1",
				beadId: "task-1",
				agentName: "builder-1",
				filesModified: ["src/foo.ts"],
			}),
		});
		rawStore.close();

		const mergedBranches: string[] = [];
		const deps = makeDeps({
			_mail: mailDeps,
			_merge: {
				async mergeBranch(_root, branch) {
					mergedBranches.push(branch);
					return { success: true, output: "ok" };
				},
			},
		});

		const state = createAutopilot(tempDir, { autoMerge: true }).getState();
		const actions = await runAutopilotTick(tempDir, state, deps);

		expect(mergedBranches).toEqual(["legio/builder-1/task-1"]);
		expect(actions).toHaveLength(1);
		expect(actions[0]?.type).toBe("merge");
		expect(actions[0]?.details).toContain("legio/builder-1/task-1");
	});

	it("does not merge when autoMerge=false", async () => {
		const dbPath = join(tempDir, "mail.db");
		const mailDeps = createInMemoryMailDeps(dbPath);
		const rawStore = createMailStore(dbPath);

		rawStore.insert({
			id: "msg-002",
			from: "supervisor-1",
			to: "coordinator",
			subject: "Branch ready: legio/builder-1/task-2",
			body: "Ready to merge",
			type: "merge_ready",
			priority: "normal",
			threadId: null,
			payload: JSON.stringify({
				branch: "legio/builder-1/task-2",
				beadId: "task-2",
				agentName: "builder-1",
				filesModified: [],
			}),
		});
		rawStore.close();

		let mergeCalled = false;
		const deps = makeDeps({
			_mail: mailDeps,
			_merge: {
				async mergeBranch() {
					mergeCalled = true;
					return { success: true, output: "" };
				},
			},
		});

		const state = createAutopilot(tempDir, { autoMerge: false }).getState();
		await runAutopilotTick(tempDir, state, deps);

		expect(mergeCalled).toBe(false);
	});

	it("marks merge_ready messages as read after processing", async () => {
		const dbPath = join(tempDir, "mail.db");
		const mailDeps = createInMemoryMailDeps(dbPath);
		const rawStore = createMailStore(dbPath);

		rawStore.insert({
			id: "msg-003",
			from: "supervisor-1",
			to: "coordinator",
			subject: "Branch ready: legio/agent-1/task-3",
			body: "Ready to merge",
			type: "merge_ready",
			priority: "normal",
			threadId: null,
			payload: JSON.stringify({
				branch: "legio/agent-1/task-3",
				beadId: "task-3",
				agentName: "agent-1",
				filesModified: [],
			}),
		});
		rawStore.close();

		const state = createAutopilot(tempDir, { autoMerge: true }).getState();
		await runAutopilotTick(tempDir, state, { ...makeDeps(), _mail: mailDeps });

		// After processing, getUnread should return empty
		const checkStore = createMailStore(dbPath);
		const unread = checkStore.getUnread("coordinator");
		checkStore.close();
		expect(unread).toHaveLength(0);
	});

	it("logs error and escalation mail as mail_processed", async () => {
		const dbPath = join(tempDir, "mail.db");
		const mailDeps = createInMemoryMailDeps(dbPath);
		const rawStore = createMailStore(dbPath);

		rawStore.insert({
			id: "msg-004",
			from: "builder-1",
			to: "coordinator",
			subject: "Build failed",
			body: "Something went wrong",
			type: "error",
			priority: "high",
			threadId: null,
		});
		rawStore.insert({
			id: "msg-005",
			from: "builder-2",
			to: "orchestrator",
			subject: "Need help",
			body: "Escalating issue",
			type: "escalation",
			priority: "urgent",
			threadId: null,
		});
		rawStore.close();

		const state = createAutopilot(tempDir).getState();
		const actions = await runAutopilotTick(tempDir, state, { ...makeDeps(), _mail: mailDeps });

		expect(actions).toHaveLength(2);
		expect(actions.every((a) => a.type === "mail_processed")).toBe(true);
		expect(actions.some((a) => a.details.includes("error"))).toBe(true);
		expect(actions.some((a) => a.details.includes("escalation"))).toBe(true);
	});

	it("marks non-merge_ready messages as read without recording action", async () => {
		const dbPath = join(tempDir, "mail.db");
		const mailDeps = createInMemoryMailDeps(dbPath);
		const rawStore = createMailStore(dbPath);

		rawStore.insert({
			id: "msg-006",
			from: "builder-1",
			to: "coordinator",
			subject: "Status update",
			body: "Working on it",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		rawStore.close();

		const state = createAutopilot(tempDir).getState();
		const actions = await runAutopilotTick(tempDir, state, { ...makeDeps(), _mail: mailDeps });

		// status messages: marked read but no action recorded
		expect(actions).toHaveLength(0);

		const checkStore = createMailStore(dbPath);
		const unread = checkStore.getUnread("coordinator");
		checkStore.close();
		expect(unread).toHaveLength(0);
	});

	it("triggers worktree clean when autoCleanWorktrees=true", async () => {
		let cleanCalled = false;
		const mailDeps = createInMemoryMailDeps(":memory:");

		const deps = makeDeps({
			_mail: mailDeps,
			_worktree: {
				async cleanCompleted() {
					cleanCalled = true;
				},
			},
		});

		const state = createAutopilot(tempDir, { autoCleanWorktrees: true }).getState();
		const actions = await runAutopilotTick(tempDir, state, deps);

		expect(cleanCalled).toBe(true);
		expect(actions.some((a) => a.type === "worktree_cleaned")).toBe(true);
	});

	it("does not clean worktrees when autoCleanWorktrees=false", async () => {
		let cleanCalled = false;
		const mailDeps = createInMemoryMailDeps(":memory:");

		const deps = makeDeps({
			_mail: mailDeps,
			_worktree: {
				async cleanCompleted() {
					cleanCalled = true;
				},
			},
		});

		const state = createAutopilot(tempDir, { autoCleanWorktrees: false }).getState();
		await runAutopilotTick(tempDir, state, deps);

		expect(cleanCalled).toBe(false);
	});

	it("checks both coordinator and orchestrator inboxes", async () => {
		const dbPath = join(tempDir, "mail.db");
		const mailDeps = createInMemoryMailDeps(dbPath);
		const rawStore = createMailStore(dbPath);

		rawStore.insert({
			id: "msg-007",
			from: "builder-1",
			to: "orchestrator", // sent to orchestrator, not coordinator
			subject: "Status",
			body: "Working",
			type: "status",
			priority: "normal",
			threadId: null,
		});
		rawStore.close();

		const state = createAutopilot(tempDir).getState();
		await runAutopilotTick(tempDir, state, { ...makeDeps(), _mail: mailDeps });

		// Should be marked as read even though sent to orchestrator
		const checkStore = createMailStore(dbPath);
		const unread = checkStore.getUnread("orchestrator");
		checkStore.close();
		expect(unread).toHaveLength(0);
	});

	it("handles merge errors gracefully and records error action", async () => {
		const dbPath = join(tempDir, "mail.db");
		const mailDeps = createInMemoryMailDeps(dbPath);
		const rawStore = createMailStore(dbPath);

		rawStore.insert({
			id: "msg-008",
			from: "supervisor-1",
			to: "coordinator",
			subject: "Branch ready",
			body: "Ready",
			type: "merge_ready",
			priority: "normal",
			threadId: null,
			payload: JSON.stringify({
				branch: "legio/agent/task-x",
				beadId: "task-x",
				agentName: "agent",
				filesModified: [],
			}),
		});
		rawStore.close();

		const deps = makeDeps({
			_mail: mailDeps,
			_merge: {
				async mergeBranch() {
					throw new Error("merge failed hard");
				},
			},
		});

		const state = createAutopilot(tempDir, { autoMerge: true }).getState();
		const actions = await runAutopilotTick(tempDir, state, deps);

		expect(actions.some((a) => a.type === "error")).toBe(true);
		expect(actions.some((a) => a.details.includes("merge failed hard"))).toBe(true);
	});
});
