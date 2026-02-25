/**
 * Tests for the session compat shim.
 *
 * Uses real filesystem and better-sqlite3. No mocks.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openSessionStore } from "./compat.ts";

let tempDir: string;
let legioDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "legio-compat-test-"));
	legioDir = join(tempDir, ".legio");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(legioDir, { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("openSessionStore", () => {
	test("creates empty DB when sessions.db does not exist", () => {
		const { store, migrated } = openSessionStore(legioDir);

		expect(migrated).toBe(false);
		expect(store.getAll()).toEqual([]);
		store.close();
	});

	test("returns migrated:false always", () => {
		const { migrated } = openSessionStore(legioDir);
		expect(migrated).toBe(false);
	});

	test("returned store supports all SessionStore operations", () => {
		const { store } = openSessionStore(legioDir);

		const now = new Date().toISOString();
		store.upsert({
			id: "s-001",
			agentName: "test-agent",
			capability: "builder",
			worktreePath: "/tmp/worktrees/test-agent",
			branchName: "legio/test-agent/task-1",
			beadId: "task-1",
			tmuxSession: "legio-test-agent",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});

		const all = store.getAll();
		expect(all).toHaveLength(1);
		expect(all[0]?.agentName).toBe("test-agent");

		const active = store.getActive();
		expect(active).toHaveLength(1);

		store.updateState("test-agent", "completed");
		expect(store.getByName("test-agent")?.state).toBe("completed");

		store.remove("test-agent");
		expect(store.getByName("test-agent")).toBeNull();

		store.close();
	});

	test("second call opens existing DB", () => {
		const { store: store1 } = openSessionStore(legioDir);
		const now = new Date().toISOString();
		store1.upsert({
			id: "s-persist",
			agentName: "persistent-agent",
			capability: "scout",
			worktreePath: "/tmp/worktrees/persistent-agent",
			branchName: "legio/persistent-agent/task-2",
			beadId: "task-2",
			tmuxSession: "legio-persistent-agent",
			state: "working",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		store1.close();

		const { store: store2, migrated } = openSessionStore(legioDir);
		expect(migrated).toBe(false);
		expect(store2.getAll()).toHaveLength(1);
		expect(store2.getByName("persistent-agent")?.id).toBe("s-persist");
		store2.close();
	});
});
