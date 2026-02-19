import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../errors.ts";
import type { AgentIdentity } from "../types.ts";
import { createIdentity, loadIdentity, updateIdentity } from "./identity.ts";

describe("identity", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "legio-identity-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("createIdentity", () => {
		test("creates identity file with minimal data", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: [],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity);

			const filePath = join(tempDir, "test-agent", "identity.yaml");
			const file = Bun.file(filePath);
			expect(await file.exists()).toBe(true);

			const content = await file.text();
			expect(content).toContain("name: test-agent");
			expect(content).toContain("capability: builder");
			expect(content).toContain('created: "2024-01-01T00:00:00Z"');
			expect(content).toContain("sessionsCompleted: 0");
			expect(content).toContain("expertiseDomains: []");
			expect(content).toContain("recentTasks: []");
		});

		test("creates identity with expertise domains", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 5,
				expertiseDomains: ["typescript", "testing", "architecture"],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity);

			const filePath = join(tempDir, "test-agent", "identity.yaml");
			const content = await Bun.file(filePath).text();
			expect(content).toContain("expertiseDomains:");
			expect(content).toContain("\t- typescript");
			expect(content).toContain("\t- testing");
			expect(content).toContain("\t- architecture");
		});

		test("creates identity with recent tasks", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 3,
				expertiseDomains: [],
				recentTasks: [
					{
						beadId: "beads-001",
						summary: "Fixed authentication bug",
						completedAt: "2024-01-15T12:00:00Z",
					},
					{
						beadId: "beads-002",
						summary: "Added user profile page",
						completedAt: "2024-01-16T14:30:00Z",
					},
				],
			};

			await createIdentity(tempDir, identity);

			const filePath = join(tempDir, "test-agent", "identity.yaml");
			const content = await Bun.file(filePath).text();
			expect(content).toContain("recentTasks:");
			expect(content).toContain("\t- beadId: beads-001");
			expect(content).toContain("\t\tsummary: Fixed authentication bug");
			expect(content).toContain('\t\tcompletedAt: "2024-01-15T12:00:00Z"');
			expect(content).toContain("\t- beadId: beads-002");
			expect(content).toContain("\t\tsummary: Added user profile page");
			expect(content).toContain('\t\tcompletedAt: "2024-01-16T14:30:00Z"');
		});

		test("quotes strings with special characters", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: ["domain: with colon", "domain#with hash", " leading space"],
				recentTasks: [
					{
						beadId: "beads-001",
						summary: 'Fixed bug: "memory leak"',
						completedAt: "2024-01-15T12:00:00Z",
					},
				],
			};

			await createIdentity(tempDir, identity);

			const filePath = join(tempDir, "test-agent", "identity.yaml");
			const content = await Bun.file(filePath).text();
			expect(content).toContain('"domain: with colon"');
			expect(content).toContain('"domain#with hash"');
			expect(content).toContain('" leading space"');
			expect(content).toContain('Fixed bug: \\"memory leak\\"');
		});

		test("creates directory if it does not exist", async () => {
			const identity: AgentIdentity = {
				name: "new-agent",
				capability: "scout",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: [],
				recentTasks: [],
			};

			const agentDir = join(tempDir, "new-agent");
			expect(await Bun.file(agentDir).exists()).toBe(false);

			await createIdentity(tempDir, identity);

			const filePath = join(agentDir, "identity.yaml");
			expect(await Bun.file(filePath).exists()).toBe(true);
		});

		test("overwrites existing identity file", async () => {
			const identity1: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 5,
				expertiseDomains: ["old-domain"],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity1);

			const identity2: AgentIdentity = {
				...identity1,
				sessionsCompleted: 10,
				expertiseDomains: ["new-domain"],
			};

			await createIdentity(tempDir, identity2);

			const loaded = await loadIdentity(tempDir, "test-agent");
			expect(loaded?.sessionsCompleted).toBe(10);
			expect(loaded?.expertiseDomains).toEqual(["new-domain"]);
		});

		test("throws AgentError for invalid directory", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: [],
				recentTasks: [],
			};

			// Create a file where the directory should be
			const blockedPath = join(tempDir, "test-agent");
			await Bun.write(blockedPath, "blocking file");

			await expect(createIdentity(tempDir, identity)).rejects.toThrow(AgentError);
			await expect(createIdentity(tempDir, identity)).rejects.toThrow(
				"Failed to create identity directory",
			);
		});
	});

	describe("loadIdentity", () => {
		test("loads existing identity correctly", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 7,
				expertiseDomains: ["typescript", "testing"],
				recentTasks: [
					{
						beadId: "beads-001",
						summary: "Fixed bug",
						completedAt: "2024-01-15T12:00:00Z",
					},
				],
			};

			await createIdentity(tempDir, identity);

			const loaded = await loadIdentity(tempDir, "test-agent");

			expect(loaded).toBeDefined();
			expect(loaded?.name).toBe("test-agent");
			expect(loaded?.capability).toBe("builder");
			expect(loaded?.created).toBe("2024-01-01T00:00:00Z");
			expect(loaded?.sessionsCompleted).toBe(7);
			expect(loaded?.expertiseDomains).toEqual(["typescript", "testing"]);
			expect(loaded?.recentTasks).toHaveLength(1);
			expect(loaded?.recentTasks[0]?.beadId).toBe("beads-001");
			expect(loaded?.recentTasks[0]?.summary).toBe("Fixed bug");
			expect(loaded?.recentTasks[0]?.completedAt).toBe("2024-01-15T12:00:00Z");
		});

		test("returns null for non-existent identity", async () => {
			const loaded = await loadIdentity(tempDir, "nonexistent");
			expect(loaded).toBeNull();
		});

		test("loads identity with empty arrays", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: [],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity);
			const loaded = await loadIdentity(tempDir, "test-agent");

			expect(loaded?.expertiseDomains).toEqual([]);
			expect(loaded?.recentTasks).toEqual([]);
		});

		test("loads identity with multiple recent tasks", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 3,
				expertiseDomains: [],
				recentTasks: [
					{
						beadId: "beads-001",
						summary: "Task 1",
						completedAt: "2024-01-15T12:00:00Z",
					},
					{
						beadId: "beads-002",
						summary: "Task 2",
						completedAt: "2024-01-16T12:00:00Z",
					},
					{
						beadId: "beads-003",
						summary: "Task 3",
						completedAt: "2024-01-17T12:00:00Z",
					},
				],
			};

			await createIdentity(tempDir, identity);
			const loaded = await loadIdentity(tempDir, "test-agent");

			expect(loaded?.recentTasks).toHaveLength(3);
			expect(loaded?.recentTasks[0]?.beadId).toBe("beads-001");
			expect(loaded?.recentTasks[1]?.beadId).toBe("beads-002");
			expect(loaded?.recentTasks[2]?.beadId).toBe("beads-003");
		});

		test("handles quoted strings with special characters", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: ["domain: with colon", "domain#with hash"],
				recentTasks: [
					{
						beadId: "beads-001",
						summary: 'Fixed bug: "memory leak"',
						completedAt: "2024-01-15T12:00:00Z",
					},
				],
			};

			await createIdentity(tempDir, identity);
			const loaded = await loadIdentity(tempDir, "test-agent");

			expect(loaded?.expertiseDomains).toContain("domain: with colon");
			expect(loaded?.expertiseDomains).toContain("domain#with hash");
			expect(loaded?.recentTasks[0]?.summary).toBe('Fixed bug: "memory leak"');
		});

		test("handles escaped characters in strings", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: [],
				recentTasks: [
					{
						beadId: "beads-001",
						summary: "Path: C:\\Users\\test\\file.txt",
						completedAt: "2024-01-15T12:00:00Z",
					},
				],
			};

			await createIdentity(tempDir, identity);
			const loaded = await loadIdentity(tempDir, "test-agent");

			expect(loaded?.recentTasks[0]?.summary).toBe("Path: C:\\Users\\test\\file.txt");
		});

		test("handles malformed YAML gracefully", async () => {
			const agentDir = join(tempDir, "test-agent");
			await mkdir(agentDir, { recursive: true });
			const filePath = join(agentDir, "identity.yaml");

			// Write invalid YAML (unbalanced quotes)
			await Bun.write(
				filePath,
				'name: "test-agent\ncapability: builder\ncreated: 2024-01-01T00:00:00Z\n',
			);

			const loaded = await loadIdentity(tempDir, "test-agent");

			// Parser handles unbalanced quotes by treating the rest as quoted content
			expect(loaded?.name).toBe('"test-agent');
			expect(loaded?.capability).toBe("builder");
		});

		test("handles YAML with comments", async () => {
			const agentDir = join(tempDir, "test-agent");
			await mkdir(agentDir, { recursive: true });
			const filePath = join(agentDir, "identity.yaml");

			await Bun.write(
				filePath,
				`# Agent identity file
name: test-agent
capability: builder
created: 2024-01-01T00:00:00Z
sessionsCompleted: 5
# Expertise domains
expertiseDomains:
	- typescript
	- testing
recentTasks: []
`,
			);

			const loaded = await loadIdentity(tempDir, "test-agent");

			expect(loaded?.name).toBe("test-agent");
			expect(loaded?.capability).toBe("builder");
			expect(loaded?.sessionsCompleted).toBe(5);
			expect(loaded?.expertiseDomains).toEqual(["typescript", "testing"]);
		});
	});

	describe("updateIdentity", () => {
		test("increments sessionsCompleted", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 5,
				expertiseDomains: [],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity);
			const updated = await updateIdentity(tempDir, "test-agent", {
				sessionsCompleted: 3,
			});

			expect(updated.sessionsCompleted).toBe(8);

			// Verify persistence
			const loaded = await loadIdentity(tempDir, "test-agent");
			expect(loaded?.sessionsCompleted).toBe(8);
		});

		test("merges expertise domains with deduplication", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: ["typescript", "testing"],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity);
			const updated = await updateIdentity(tempDir, "test-agent", {
				expertiseDomains: ["testing", "architecture", "git"],
			});

			expect(updated.expertiseDomains).toHaveLength(4);
			expect(updated.expertiseDomains).toContain("typescript");
			expect(updated.expertiseDomains).toContain("testing");
			expect(updated.expertiseDomains).toContain("architecture");
			expect(updated.expertiseDomains).toContain("git");

			// Count "testing" only once
			const testingCount = updated.expertiseDomains.filter((d) => d === "testing").length;
			expect(testingCount).toBe(1);
		});

		test("appends completed task with current timestamp", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: [],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity);

			const beforeUpdate = Date.now();
			const updated = await updateIdentity(tempDir, "test-agent", {
				completedTask: {
					beadId: "beads-001",
					summary: "Fixed authentication bug",
				},
			});
			const afterUpdate = Date.now();

			expect(updated.recentTasks).toHaveLength(1);
			expect(updated.recentTasks[0]?.beadId).toBe("beads-001");
			expect(updated.recentTasks[0]?.summary).toBe("Fixed authentication bug");

			// Verify timestamp is within the update window
			const timestamp = new Date(updated.recentTasks[0]?.completedAt ?? "").getTime();
			expect(timestamp).toBeGreaterThanOrEqual(beforeUpdate);
			expect(timestamp).toBeLessThanOrEqual(afterUpdate);
		});

		test("caps recentTasks at 20 entries, dropping oldest", async () => {
			// Create identity with 19 tasks
			const existingTasks = Array.from({ length: 19 }, (_, i) => ({
				beadId: `beads-${i.toString().padStart(3, "0")}`,
				summary: `Task ${i}`,
				completedAt: `2024-01-${(i + 1).toString().padStart(2, "0")}T12:00:00Z`,
			}));

			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: [],
				recentTasks: existingTasks,
			};

			await createIdentity(tempDir, identity);

			// Add two more tasks (total would be 21)
			let updated = await updateIdentity(tempDir, "test-agent", {
				completedTask: { beadId: "beads-019", summary: "Task 19" },
			});

			expect(updated.recentTasks).toHaveLength(20);
			expect(updated.recentTasks[0]?.beadId).toBe("beads-000");

			updated = await updateIdentity(tempDir, "test-agent", {
				completedTask: { beadId: "beads-020", summary: "Task 20" },
			});

			expect(updated.recentTasks).toHaveLength(20);
			// Oldest task (beads-000) should be dropped
			expect(updated.recentTasks[0]?.beadId).toBe("beads-001");
			expect(updated.recentTasks[19]?.beadId).toBe("beads-020");
		});

		test("applies multiple updates simultaneously", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 5,
				expertiseDomains: ["typescript"],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity);
			const updated = await updateIdentity(tempDir, "test-agent", {
				sessionsCompleted: 2,
				expertiseDomains: ["testing", "architecture"],
				completedTask: {
					beadId: "beads-001",
					summary: "Completed task",
				},
			});

			expect(updated.sessionsCompleted).toBe(7);
			expect(updated.expertiseDomains).toHaveLength(3);
			expect(updated.expertiseDomains).toContain("typescript");
			expect(updated.expertiseDomains).toContain("testing");
			expect(updated.expertiseDomains).toContain("architecture");
			expect(updated.recentTasks).toHaveLength(1);
		});

		test("throws AgentError for non-existent identity", async () => {
			await expect(
				updateIdentity(tempDir, "nonexistent", { sessionsCompleted: 1 }),
			).rejects.toThrow(AgentError);
			await expect(
				updateIdentity(tempDir, "nonexistent", { sessionsCompleted: 1 }),
			).rejects.toThrow("not found");
		});

		test("handles empty update object", async () => {
			const identity: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 5,
				expertiseDomains: ["typescript"],
				recentTasks: [],
			};

			await createIdentity(tempDir, identity);
			const updated = await updateIdentity(tempDir, "test-agent", {});

			expect(updated.sessionsCompleted).toBe(5);
			expect(updated.expertiseDomains).toEqual(["typescript"]);
			expect(updated.recentTasks).toEqual([]);
		});
	});

	describe("round-trip serialization", () => {
		test("preserves data through create and load cycle", async () => {
			const original: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 42,
				expertiseDomains: ["typescript", "testing", "architecture"],
				recentTasks: [
					{
						beadId: "beads-001",
						summary: "Implemented feature X",
						completedAt: "2024-01-15T12:00:00Z",
					},
					{
						beadId: "beads-002",
						summary: "Fixed bug in module Y",
						completedAt: "2024-01-16T14:30:00Z",
					},
				],
			};

			await createIdentity(tempDir, original);
			const loaded = await loadIdentity(tempDir, "test-agent");

			expect(loaded).toEqual(original);
		});

		test("preserves special characters through round-trip", async () => {
			const original: AgentIdentity = {
				name: "test-agent",
				capability: "builder",
				created: "2024-01-01T00:00:00Z",
				sessionsCompleted: 0,
				expertiseDomains: [
					"domain: with colon",
					"domain#with hash",
					"domain with spaces",
					"true",
					"123",
				],
				recentTasks: [
					{
						beadId: "beads-001",
						summary: 'Summary with "quotes" and: colons',
						completedAt: "2024-01-15T12:00:00Z",
					},
				],
			};

			await createIdentity(tempDir, original);
			const loaded = await loadIdentity(tempDir, "test-agent");

			expect(loaded).toEqual(original);
		});
	});
});
