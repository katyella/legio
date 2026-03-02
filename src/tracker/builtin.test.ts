/**
 * Tests for the builtin SQLite tracker adapter.
 *
 * Uses real SQLite databases in temp directories — no mocks.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuiltinTrackerClient } from "./builtin.ts";
import { createBuiltinTrackerClient } from "./builtin.ts";

describe("createBuiltinTrackerClient", () => {
	let tmpDir: string;
	let client: BuiltinTrackerClient;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "legio-builtin-test-"));
		client = createBuiltinTrackerClient(join(tmpDir, "tasks.db"));
	});

	afterEach(async () => {
		client.dispose();
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("create", () => {
		it("creates a task and returns an ID starting with 'task-'", async () => {
			const id = await client.create("Test task");
			expect(id).toMatch(/^task-[a-f0-9]{8}$/);
		});

		it("creates a task with optional fields", async () => {
			const id = await client.create("Bug fix", {
				priority: 1,
				type: "bug",
				description: "Fix the broken thing",
			});
			const issue = await client.show(id);
			expect(issue.title).toBe("Bug fix");
			expect(issue.priority).toBe(1);
			expect(issue.type).toBe("bug");
			expect(issue.description).toBe("Fix the broken thing");
			expect(issue.status).toBe("open");
		});

		it("defaults priority to 2 and type to 'task'", async () => {
			const id = await client.create("Default task");
			const issue = await client.show(id);
			expect(issue.priority).toBe(2);
			expect(issue.type).toBe("task");
		});
	});

	describe("show", () => {
		it("returns a task by ID", async () => {
			const id = await client.create("Show me");
			const issue = await client.show(id);
			expect(issue.id).toBe(id);
			expect(issue.title).toBe("Show me");
			expect(issue.status).toBe("open");
			expect(issue.createdAt).toBeDefined();
		});

		it("throws for non-existent task", async () => {
			await expect(client.show("task-nonexist")).rejects.toThrow("Task not found");
		});
	});

	describe("claim", () => {
		it("sets status to in_progress", async () => {
			const id = await client.create("Claim me");
			await client.claim(id);
			const issue = await client.show(id);
			expect(issue.status).toBe("in_progress");
		});

		it("throws for non-existent task", async () => {
			await expect(client.claim("task-nonexist")).rejects.toThrow("Task not found");
		});
	});

	describe("close", () => {
		it("sets status to closed with reason", async () => {
			const id = await client.create("Close me");
			await client.close(id, "Done implementing");
			const issue = await client.show(id);
			expect(issue.status).toBe("closed");
			expect(issue.closeReason).toBe("Done implementing");
			expect(issue.closedAt).toBeDefined();
		});

		it("closes without a reason", async () => {
			const id = await client.create("Close no reason");
			await client.close(id);
			const issue = await client.show(id);
			expect(issue.status).toBe("closed");
			expect(issue.closeReason).toBeUndefined();
		});

		it("throws for non-existent task", async () => {
			await expect(client.close("task-nonexist")).rejects.toThrow("Task not found");
		});
	});

	describe("ready", () => {
		it("returns open, unblocked tasks", async () => {
			const id1 = await client.create("Ready task");
			await client.create("In progress task");
			const id2 = await client.create("Another ready");

			// Claim the second one
			const issues = await client.list();
			const inProgressId = issues[1]?.id;
			if (inProgressId) {
				await client.claim(inProgressId);
			}

			const ready = await client.ready();
			const readyIds = ready.map((i) => i.id);
			expect(readyIds).toContain(id1);
			expect(readyIds).toContain(id2);
			expect(readyIds).not.toContain(inProgressId);
		});

		it("returns empty array when no tasks are ready", async () => {
			const id = await client.create("Only task");
			await client.claim(id);
			const ready = await client.ready();
			expect(ready).toEqual([]);
		});
	});

	describe("list", () => {
		it("lists all non-closed tasks by default", async () => {
			await client.create("Open task");
			const id2 = await client.create("To close");
			await client.close(id2, "done");
			await client.create("Another open");

			const list = await client.list();
			expect(list).toHaveLength(2);
		});

		it("filters by status", async () => {
			const id1 = await client.create("Open");
			const id2 = await client.create("To claim");
			await client.claim(id2);

			const open = await client.list({ status: "open" });
			expect(open).toHaveLength(1);
			expect(open[0]?.id).toBe(id1);

			const inProgress = await client.list({ status: "in_progress" });
			expect(inProgress).toHaveLength(1);
			expect(inProgress[0]?.id).toBe(id2);
		});

		it("shows all tasks including closed with --all", async () => {
			await client.create("Open");
			const id2 = await client.create("To close");
			await client.close(id2, "done");

			const all = await client.list({ all: true });
			expect(all).toHaveLength(2);
		});

		it("respects limit", async () => {
			await client.create("Task 1");
			await client.create("Task 2");
			await client.create("Task 3");

			const limited = await client.list({ limit: 2 });
			expect(limited).toHaveLength(2);
		});
	});

	describe("sync", () => {
		it("is a no-op that resolves without error", async () => {
			await expect(client.sync()).resolves.toBeUndefined();
		});
	});

	describe("dispose", () => {
		it("can close the database connection", () => {
			// Should not throw
			client.dispose();
			// Create a new client so afterEach doesn't double-dispose
			client = createBuiltinTrackerClient(join(tmpDir, "tasks2.db"));
		});
	});
});
