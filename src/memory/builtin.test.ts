/**
 * Tests for the builtin SQLite memory backend.
 *
 * Uses real SQLite databases in temp directories — no mocks.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuiltinMemoryClient } from "./builtin.ts";
import { createBuiltinMemoryClient } from "./builtin.ts";

describe("createBuiltinMemoryClient", () => {
	let tmpDir: string;
	let client: BuiltinMemoryClient;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "legio-memory-test-"));
		client = createBuiltinMemoryClient(join(tmpDir, "memory.db"));
	});

	afterEach(async () => {
		client.dispose();
		await rm(tmpDir, { recursive: true, force: true });
	});

	describe("record", () => {
		it("creates a record and returns an ID starting with 'mem-'", async () => {
			const id = await client.record("cli", {
				type: "convention",
				description: "Always use tabs for indentation",
			});
			expect(id).toMatch(/^mem-[a-f0-9]{8}$/);
		});

		it("creates a record with all optional fields", async () => {
			const id = await client.record("architecture", {
				type: "decision",
				description: "Use SQLite for all local storage",
				tags: ["sqlite", "storage"],
				classification: "observational",
				evidenceCommit: "abc123",
				evidenceBead: "bead-001",
			});
			const record = await client.show(id);
			expect(record.domain).toBe("architecture");
			expect(record.type).toBe("decision");
			expect(record.content).toBe("Use SQLite for all local storage");
			expect(record.tags).toEqual(["sqlite", "storage"]);
			expect(record.classification).toBe("observational");
			expect(record.evidenceCommit).toBe("abc123");
			expect(record.evidenceBead).toBe("bead-001");
			expect(record.recordedAt).toBeDefined();
		});

		it("defaults classification to 'tactical'", async () => {
			const id = await client.record("cli", {
				type: "convention",
				description: "Test default",
			});
			const record = await client.show(id);
			expect(record.classification).toBe("tactical");
		});
	});

	describe("show", () => {
		it("returns a record by ID", async () => {
			const id = await client.record("testing", {
				type: "pattern",
				description: "Use real SQLite in tests",
			});
			const record = await client.show(id);
			expect(record.id).toBe(id);
			expect(record.domain).toBe("testing");
			expect(record.content).toBe("Use real SQLite in tests");
		});

		it("throws for non-existent record", async () => {
			await expect(client.show("mem-nonexist")).rejects.toThrow("Record not found");
		});
	});

	describe("delete", () => {
		it("deletes an existing record", async () => {
			const id = await client.record("cli", {
				type: "convention",
				description: "To be deleted",
			});
			await client.delete(id);
			await expect(client.show(id)).rejects.toThrow("Record not found");
		});

		it("throws for non-existent record", async () => {
			await expect(client.delete("mem-nonexist")).rejects.toThrow("Record not found");
		});
	});

	describe("list", () => {
		it("lists all records when no filters", async () => {
			await client.record("cli", { type: "convention", description: "Conv 1" });
			await client.record("arch", { type: "decision", description: "Dec 1" });

			const records = await client.list();
			expect(records).toHaveLength(2);
		});

		it("filters by domain", async () => {
			await client.record("cli", { type: "convention", description: "CLI conv" });
			await client.record("arch", { type: "decision", description: "Arch dec" });

			const records = await client.list({ domain: "cli" });
			expect(records).toHaveLength(1);
			expect(records[0]?.domain).toBe("cli");
		});

		it("filters by type", async () => {
			await client.record("cli", { type: "convention", description: "Conv" });
			await client.record("cli", { type: "failure", description: "Fail" });

			const records = await client.list({ type: "convention" });
			expect(records).toHaveLength(1);
			expect(records[0]?.type).toBe("convention");
		});

		it("respects limit", async () => {
			await client.record("cli", { type: "convention", description: "One" });
			await client.record("cli", { type: "convention", description: "Two" });
			await client.record("cli", { type: "convention", description: "Three" });

			const records = await client.list({ limit: 2 });
			expect(records).toHaveLength(2);
		});
	});

	describe("status", () => {
		it("returns domain statistics", async () => {
			await client.record("cli", { type: "convention", description: "CLI 1" });
			await client.record("cli", { type: "pattern", description: "CLI 2" });
			await client.record("arch", { type: "decision", description: "Arch 1" });

			const stats = await client.status();
			expect(stats).toHaveLength(2);

			const cliStats = stats.find((s) => s.name === "cli");
			expect(cliStats?.recordCount).toBe(2);
			expect(cliStats?.lastUpdated).toBeDefined();

			const archStats = stats.find((s) => s.name === "arch");
			expect(archStats?.recordCount).toBe(1);
		});

		it("returns empty array when no records", async () => {
			const stats = await client.status();
			expect(stats).toEqual([]);
		});
	});

	describe("prime", () => {
		it("returns 'no records' message when empty", async () => {
			const output = await client.prime();
			expect(output).toContain("No expertise records found");
		});

		it("returns formatted markdown with domain sections", async () => {
			await client.record("cli", { type: "convention", description: "Use tabs" });
			await client.record("arch", { type: "decision", description: "SQLite for storage" });

			const output = await client.prime();
			expect(output).toContain("# Project Expertise");
			expect(output).toContain("## arch");
			expect(output).toContain("## cli");
			expect(output).toContain("[convention] Use tabs");
			expect(output).toContain("[decision] SQLite for storage");
		});

		it("filters by domains", async () => {
			await client.record("cli", { type: "convention", description: "CLI record" });
			await client.record("arch", { type: "decision", description: "Arch record" });

			const output = await client.prime({ domains: ["cli"] });
			expect(output).toContain("CLI record");
			expect(output).not.toContain("Arch record");
		});

		it("respects budget limit", async () => {
			await client.record("cli", { type: "convention", description: "One" });
			await client.record("cli", { type: "convention", description: "Two" });
			await client.record("cli", { type: "convention", description: "Three" });

			const output = await client.prime({ budget: 1 });
			// Should only have 1 record
			const matches = output.match(/\[convention\]/g);
			expect(matches).toHaveLength(1);
		});
	});

	describe("search", () => {
		it("finds records via full-text search", async () => {
			await client.record("cli", {
				type: "convention",
				description: "Always use tabs for indentation",
			});
			await client.record("arch", {
				type: "decision",
				description: "SQLite for local storage",
			});

			const result = await client.search("tabs indentation");
			expect(result).toContain("tabs");
			expect(result).toContain("1 match");
		});

		it("returns no-match message for empty results", async () => {
			const result = await client.search("nonexistent query");
			expect(result).toContain("No records matching");
		});
	});

	describe("query", () => {
		it("queries all records when no domain", async () => {
			await client.record("cli", { type: "convention", description: "CLI" });
			await client.record("arch", { type: "decision", description: "Arch" });

			const result = await client.query();
			expect(result).toContain("CLI");
			expect(result).toContain("Arch");
		});

		it("queries records by domain", async () => {
			await client.record("cli", { type: "convention", description: "CLI only" });
			await client.record("arch", { type: "decision", description: "Arch only" });

			const result = await client.query("cli");
			expect(result).toContain("CLI only");
			expect(result).not.toContain("Arch only");
		});

		it("returns no-records message for empty domain", async () => {
			const result = await client.query("nonexistent");
			expect(result).toContain('No records in domain "nonexistent"');
		});
	});

	describe("prune", () => {
		it("counts records in dry-run mode", async () => {
			await client.record("cli", { type: "convention", description: "Old record" });
			await client.record("cli", { type: "convention", description: "Another old" });

			const result = await client.prune({ dryRun: true });
			expect(result.pruned).toBe(2);
			expect(result.dryRun).toBe(true);

			// Records should still exist
			const records = await client.list();
			expect(records).toHaveLength(2);
		});

		it("deletes all records when no filters", async () => {
			await client.record("cli", { type: "convention", description: "To prune" });

			const result = await client.prune();
			expect(result.pruned).toBe(1);
			expect(result.dryRun).toBe(false);

			const records = await client.list();
			expect(records).toHaveLength(0);
		});

		it("prunes by domain", async () => {
			await client.record("cli", { type: "convention", description: "CLI record" });
			await client.record("arch", { type: "decision", description: "Arch record" });

			const result = await client.prune({ domain: "cli" });
			expect(result.pruned).toBe(1);

			const records = await client.list();
			expect(records).toHaveLength(1);
			expect(records[0]?.domain).toBe("arch");
		});
	});

	describe("suggestDomains", () => {
		it("suggests domains from file paths", () => {
			const domains = client.suggestDomains(["src/commands/init.ts"]);
			expect(domains).toContain("cli");
		});

		it("returns empty array for unknown paths", () => {
			const domains = client.suggestDomains(["random/unknown/file.xyz"]);
			expect(domains).toEqual([]);
		});
	});

	describe("dispose", () => {
		it("can close the database connection", () => {
			client.dispose();
			// Create a new client so afterEach doesn't double-dispose
			client = createBuiltinMemoryClient(join(tmpDir, "memory2.db"));
		});
	});
});
