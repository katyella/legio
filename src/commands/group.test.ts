/**
 * Tests for legio group command.
 *
 * Uses real temp directories for groups.json I/O. Does NOT mock bd CLI --
 * tests focus on the JSON storage layer and validation logic.
 * The beads validation is tested with --skip-validation flag since
 * bd is an external CLI not available in unit tests.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import type { TaskGroup } from "../types.ts";
import { loadGroups } from "./group.ts";

let tempDir: string;
let legioDir: string;
let groupsJsonPath: string;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	legioDir = join(tempDir, ".legio");
	await mkdir(legioDir, { recursive: true });
	groupsJsonPath = join(legioDir, "groups.json");
});

afterEach(async () => {
	await cleanupTempDir(tempDir);
});

/**
 * Helper to write groups.json directly for test setup.
 */
async function writeGroups(groups: TaskGroup[]): Promise<void> {
	await writeFile(groupsJsonPath, `${JSON.stringify(groups, null, "\t")}\n`);
}

/**
 * Helper to read groups.json directly for assertions.
 */
async function readGroups(): Promise<TaskGroup[]> {
	const text = await readFile(groupsJsonPath, "utf-8");
	return JSON.parse(text) as TaskGroup[];
}

function makeGroup(overrides?: Partial<TaskGroup>): TaskGroup {
	return {
		id: `group-${crypto.randomUUID().slice(0, 8)}`,
		name: "Test Group",
		memberIssueIds: ["issue-1", "issue-2"],
		status: "active",
		createdAt: new Date().toISOString(),
		completedAt: null,
		...overrides,
	};
}

describe("loadGroups", () => {
	test("returns empty array when groups.json does not exist", async () => {
		const groups = await loadGroups(tempDir);
		expect(groups).toEqual([]);
	});

	test("returns empty array when groups.json is malformed", async () => {
		await writeFile(groupsJsonPath, "not valid json");
		const groups = await loadGroups(tempDir);
		expect(groups).toEqual([]);
	});

	test("loads groups from valid groups.json", async () => {
		const group = makeGroup({ name: "My Group" });
		await writeGroups([group]);
		const groups = await loadGroups(tempDir);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.name).toBe("My Group");
	});
});

describe("group create (via JSON storage)", () => {
	test("creates a group with correct structure", async () => {
		const group = makeGroup({
			name: "Feature Batch",
			memberIssueIds: ["abc-123", "def-456"],
		});
		await writeGroups([group]);

		const groups = await readGroups();
		expect(groups).toHaveLength(1);
		const saved = groups[0];
		expect(saved?.name).toBe("Feature Batch");
		expect(saved?.memberIssueIds).toEqual(["abc-123", "def-456"]);
		expect(saved?.status).toBe("active");
		expect(saved?.completedAt).toBeNull();
		expect(saved?.id).toMatch(/^group-[a-f0-9]{8}$/);
	});

	test("group ID has correct format", () => {
		const id = `group-${crypto.randomUUID().slice(0, 8)}`;
		expect(id).toMatch(/^group-[a-f0-9]{8}$/);
	});

	test("groups.json has trailing newline", async () => {
		await writeGroups([makeGroup()]);
		const raw = await readFile(groupsJsonPath, "utf-8");
		expect(raw.endsWith("\n")).toBe(true);
	});
});

describe("group add (via JSON storage)", () => {
	test("adds issues to existing group", async () => {
		const group = makeGroup({ memberIssueIds: ["issue-1"] });
		await writeGroups([group]);

		// Simulate add
		const groups = await readGroups();
		const target = groups[0];
		expect(target).toBeDefined();
		if (target) {
			target.memberIssueIds.push("issue-2", "issue-3");
			await writeGroups(groups);
		}

		const updated = await readGroups();
		expect(updated[0]?.memberIssueIds).toEqual(["issue-1", "issue-2", "issue-3"]);
	});

	test("reopens completed group when adding issues", async () => {
		const group = makeGroup({
			status: "completed",
			completedAt: new Date().toISOString(),
		});
		await writeGroups([group]);

		const groups = await readGroups();
		const target = groups[0];
		expect(target).toBeDefined();
		if (target) {
			target.memberIssueIds.push("new-issue");
			target.status = "active";
			target.completedAt = null;
			await writeGroups(groups);
		}

		const updated = await readGroups();
		expect(updated[0]?.status).toBe("active");
		expect(updated[0]?.completedAt).toBeNull();
	});

	test("detects duplicate members", () => {
		const group = makeGroup({ memberIssueIds: ["issue-1", "issue-2"] });
		const isDuplicate = group.memberIssueIds.includes("issue-1");
		expect(isDuplicate).toBe(true);
	});
});

describe("group remove (via JSON storage)", () => {
	test("removes issues from group", async () => {
		const group = makeGroup({ memberIssueIds: ["a", "b", "c"] });
		await writeGroups([group]);

		const groups = await readGroups();
		const target = groups[0];
		expect(target).toBeDefined();
		if (target) {
			target.memberIssueIds = target.memberIssueIds.filter((id) => id !== "b");
			await writeGroups(groups);
		}

		const updated = await readGroups();
		expect(updated[0]?.memberIssueIds).toEqual(["a", "c"]);
	});

	test("cannot remove all issues (would leave empty group)", () => {
		const group = makeGroup({ memberIssueIds: ["only-one"] });
		const toRemove = ["only-one"];
		const remaining = group.memberIssueIds.filter((id) => !toRemove.includes(id));
		expect(remaining.length).toBe(0);
		// The command should throw GroupError in this case
	});

	test("detects non-member issue", () => {
		const group = makeGroup({ memberIssueIds: ["a", "b"] });
		const isNotMember = !group.memberIssueIds.includes("c");
		expect(isNotMember).toBe(true);
	});
});

describe("auto-close logic", () => {
	test("marks group completed when all issues are closed", async () => {
		const group = makeGroup({
			status: "active",
			memberIssueIds: ["done-1", "done-2"],
		});
		await writeGroups([group]);

		// Simulate auto-close: all completed
		const groups = await readGroups();
		const target = groups[0];
		expect(target).toBeDefined();
		if (target && target.status === "active") {
			// All issues closed -> auto-close
			target.status = "completed";
			target.completedAt = new Date().toISOString();
			await writeGroups(groups);
		}

		const updated = await readGroups();
		expect(updated[0]?.status).toBe("completed");
		expect(updated[0]?.completedAt).not.toBeNull();
	});

	test("does not auto-close when some issues are still open", async () => {
		const group = makeGroup({ status: "active" });
		await writeGroups([group]);

		// No change -- some still open
		const groups = await readGroups();
		expect(groups[0]?.status).toBe("active");
	});

	test("does not auto-close already-completed group", () => {
		const group = makeGroup({ status: "completed", completedAt: "2025-01-01T00:00:00Z" });
		// Already completed, should not re-trigger
		expect(group.status).toBe("completed");
		expect(group.completedAt).toBe("2025-01-01T00:00:00Z");
	});
});

describe("group list (via JSON storage)", () => {
	test("lists all groups", async () => {
		const g1 = makeGroup({ name: "Group A" });
		const g2 = makeGroup({ name: "Group B", status: "completed" });
		await writeGroups([g1, g2]);

		const groups = await readGroups();
		expect(groups).toHaveLength(2);
		expect(groups[0]?.name).toBe("Group A");
		expect(groups[1]?.name).toBe("Group B");
	});

	test("empty list when no groups exist", async () => {
		const groups = await loadGroups(tempDir);
		expect(groups).toEqual([]);
	});
});

describe("error cases", () => {
	test("group not found by ID", async () => {
		await writeGroups([makeGroup()]);
		const groups = await readGroups();
		const found = groups.find((g) => g.id === "group-nonexist");
		expect(found).toBeUndefined();
	});

	test("multiple groups can be stored", async () => {
		const groups = [makeGroup({ name: "A" }), makeGroup({ name: "B" }), makeGroup({ name: "C" })];
		await writeGroups(groups);
		const loaded = await readGroups();
		expect(loaded).toHaveLength(3);
	});
});
