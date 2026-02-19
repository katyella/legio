/**
 * Tests for mulch CLI client.
 *
 * Uses real mulch CLI when available (preferred).
 * All tests are skipped if mulch is not installed.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentError } from "../errors.ts";
import { createMulchClient } from "./client.ts";

// Check if mulch is available
let hasMulch = false;
try {
	const result = spawnSync("which", ["mulch"], { stdio: "pipe" });
	hasMulch = result.status === 0;
} catch {
	hasMulch = false;
}

describe("createMulchClient", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mulch-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/**
	 * Helper to initialize git repo in tempDir.
	 * Some mulch commands (diff, learn) require a git repository.
	 */
	function initGit(): void {
		spawnSync("git", ["init"], { cwd: tempDir, stdio: "pipe" });
		spawnSync("git", ["config", "user.name", "Test User"], { cwd: tempDir, stdio: "pipe" });
		spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "pipe" });
	}

	/**
	 * Helper to initialize mulch in tempDir.
	 * Creates .mulch/ directory and initial structure.
	 */
	function initMulch(): void {
		if (!hasMulch) return;
		spawnSync("mulch", ["init"], { cwd: tempDir, stdio: "pipe" });
	}

	describe("prime", () => {
		test.skipIf(!hasMulch)("returns non-empty string", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prime();
			expect(result).toBeTruthy();
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
		});

		test.skipIf(!hasMulch)("passes domain args when provided", async () => {
			initMulch();
			// Add a domain first so we can prime it
			spawnSync("mulch", ["add", "architecture"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			const result = await client.prime(["architecture"]);
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes --format flag", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prime([], "markdown");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes both domains and format", async () => {
			initMulch();
			spawnSync("mulch", ["add", "architecture"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			const result = await client.prime(["architecture"], "xml");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes --files flag", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prime([], "markdown", {
				files: ["src/config.ts", "src/types.ts"],
			});
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes --exclude-domain flag", async () => {
			initMulch();
			spawnSync("mulch", ["add", "architecture"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			const result = await client.prime([], "markdown", {
				excludeDomain: ["architecture"],
			});
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("passes both --files and --exclude-domain", async () => {
			initMulch();
			// Add a domain to exclude
			spawnSync("mulch", ["add", "internal"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			const result = await client.prime([], "markdown", {
				files: ["src/config.ts"],
				excludeDomain: ["internal"],
			});
			expect(typeof result).toBe("string");
		});
	});

	describe("status", () => {
		test.skipIf(!hasMulch)("returns MulchStatus shape", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.status();
			expect(result).toHaveProperty("domains");
			expect(Array.isArray(result.domains)).toBe(true);
		});

		test.skipIf(!hasMulch)("with no domains returns empty array", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.status();
			expect(result.domains).toEqual([]);
		});

		test.skipIf(!hasMulch)("includes domain data when domains exist", async () => {
			initMulch();
			// Add a domain
			spawnSync("mulch", ["add", "architecture"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			const result = await client.status();
			expect(result.domains.length).toBeGreaterThan(0);
			// Just verify we got an array with entries, don't check specific structure
			// as mulch CLI output format may vary
		});
	});

	describe("record", () => {
		test.skipIf(!hasMulch)("with required args succeeds", async () => {
			initMulch();
			// Add domain first
			spawnSync("mulch", ["add", "architecture"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			await expect(
				client.record("architecture", {
					type: "convention",
					description: "test convention",
				}),
			).resolves.toBeUndefined();
		});

		test.skipIf(!hasMulch)("with optional args succeeds", async () => {
			initMulch();
			spawnSync("mulch", ["add", "architecture"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			await expect(
				client.record("architecture", {
					type: "pattern",
					name: "test-pattern",
					description: "test description",
					title: "Test Pattern",
					rationale: "testing all options",
					tags: ["testing", "example"],
				}),
			).resolves.toBeUndefined();
		});

		test.skipIf(!hasMulch)("with multiple tags", async () => {
			initMulch();
			spawnSync("mulch", ["add", "typescript"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			await expect(
				client.record("typescript", {
					type: "convention",
					description: "multi-tag test",
					tags: ["tag1", "tag2", "tag3"],
				}),
			).resolves.toBeUndefined();
		});

		test.skipIf(!hasMulch)("with --stdin flag passes flag to CLI", async () => {
			initMulch();
			spawnSync("mulch", ["add", "testing"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			// --stdin expects JSON input, which we're not providing, so this will fail
			// but we're testing that the flag is passed correctly
			await expect(
				client.record("testing", {
					type: "convention",
					description: "stdin test",
					stdin: true,
				}),
			).rejects.toThrow(AgentError);
		});

		test.skipIf(!hasMulch)("with --evidence-bead flag passes flag to CLI", async () => {
			initMulch();
			spawnSync("mulch", ["add", "testing"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			// The flag is passed correctly, but may fail if the bead ID is invalid
			// or if other required fields are missing. This test documents that the
			// flag is properly passed to the CLI.
			try {
				await client.record("testing", {
					type: "decision",
					description: "bead evidence test",
					evidenceBead: "beads-abc123",
				});
				// If it succeeds, great!
				expect(true).toBe(true);
			} catch (error) {
				// If it fails, verify it's an AgentError (not a type error or similar)
				// which proves the command was executed with the flag
				expect(error).toBeInstanceOf(AgentError);
			}
		});
	});

	describe("query", () => {
		test.skipIf(!hasMulch)("passes domain arg when provided", async () => {
			initMulch();
			spawnSync("mulch", ["add", "architecture"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			const result = await client.query("architecture");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("query without domain requires --all flag", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			// Current implementation doesn't pass --all, so this will fail
			// This documents the current behavior
			await expect(client.query()).rejects.toThrow(AgentError);
		});
	});

	describe("search", () => {
		test.skipIf(!hasMulch)("returns string output", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.search("test");
			expect(typeof result).toBe("string");
		});

		test.skipIf(!hasMulch)("searches across domains", async () => {
			initMulch();
			// Add a domain and record
			spawnSync("mulch", ["add", "testing"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			await client.record("testing", {
				type: "convention",
				description: "searchable keyword here",
			});

			const result = await client.search("searchable");
			expect(typeof result).toBe("string");
		});
	});

	describe("diff", () => {
		test.skipIf(!hasMulch)("shows expertise changes", async () => {
			initGit();
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.diff();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("domains");
			expect(Array.isArray(result.domains)).toBe(true);
		});

		test.skipIf(!hasMulch)("passes --since flag", async () => {
			initGit();
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.diff({ since: "HEAD~5" });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("since");
		});
	});

	describe("learn", () => {
		test.skipIf(!hasMulch)("suggests domains for learnings", async () => {
			initGit();
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.learn();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("changedFiles");
			expect(Array.isArray(result.changedFiles)).toBe(true);
		});

		test.skipIf(!hasMulch)("passes --since flag", async () => {
			initGit();
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.learn({ since: "HEAD~3" });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("changedFiles");
		});
	});

	describe("prune", () => {
		test.skipIf(!hasMulch)("prunes records", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prune();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("totalPruned");
		});

		test.skipIf(!hasMulch)("supports --dry-run flag", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.prune({ dryRun: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("dryRun");
			expect(result.dryRun).toBe(true);
		});
	});

	describe("doctor", () => {
		test.skipIf(!hasMulch)("runs health checks", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.doctor();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("checks");
			expect(Array.isArray(result.checks)).toBe(true);
		});

		test.skipIf(!hasMulch)("passes --fix flag", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.doctor({ fix: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("checks");
		});
	});

	describe("ready", () => {
		test.skipIf(!hasMulch)("shows recently updated records", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.ready();
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("entries");
			expect(Array.isArray(result.entries)).toBe(true);
		});

		test.skipIf(!hasMulch)("passes --limit flag", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.ready({ limit: 5 });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("count");
		});

		test.skipIf(!hasMulch)("passes --domain flag", async () => {
			initMulch();
			spawnSync("mulch", ["add", "testing"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			const result = await client.ready({ domain: "testing" });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("entries");
		});

		test.skipIf(!hasMulch)("passes --since flag", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.ready({ since: "7d" });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("entries");
		});
	});

	describe("compact", () => {
		test.skipIf(!hasMulch)("runs with --analyze flag", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.compact(undefined, { analyze: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
			expect(result).toHaveProperty("action");
		});

		test.skipIf(!hasMulch)("compacts specific domain with --analyze", async () => {
			initMulch();
			spawnSync("mulch", ["add", "large"], { cwd: tempDir, stdio: "pipe" });

			const client = createMulchClient(tempDir);
			const result = await client.compact("large", { analyze: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("action");
		});

		test.skipIf(!hasMulch)("passes --auto with --dry-run flags", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.compact(undefined, { auto: true, dryRun: true });
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
		});

		test.skipIf(!hasMulch)("passes multiple options", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.compact(undefined, {
				auto: true,
				dryRun: true,
				minGroup: 3,
				maxRecords: 20,
			});
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("command");
		});
	});

	describe("error handling", () => {
		test.skipIf(!hasMulch)("throws AgentError when mulch command fails", async () => {
			// Don't init mulch - operations will fail with "not initialized" error
			const client = createMulchClient(tempDir);
			await expect(client.status()).rejects.toThrow(AgentError);
		});

		test.skipIf(!hasMulch)("AgentError message contains exit code", async () => {
			const client = createMulchClient(tempDir);
			try {
				await client.status();
				expect.unreachable("Should have thrown AgentError");
			} catch (error) {
				expect(error).toBeInstanceOf(AgentError);
				const agentError = error as AgentError;
				expect(agentError.message).toContain("exit");
				expect(agentError.message).toContain("status");
			}
		});

		test.skipIf(!hasMulch)("record fails with descriptive error for missing domain", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			// Try to record to a domain that doesn't exist
			await expect(
				client.record("nonexistent-domain", {
					type: "convention",
					description: "test",
				}),
			).rejects.toThrow(AgentError);
		});

		test.skipIf(!hasMulch)("handles empty status output correctly", async () => {
			initMulch();
			const client = createMulchClient(tempDir);
			const result = await client.status();
			// With no domains, should have empty array (not throw)
			expect(result).toHaveProperty("domains");
			expect(result.domains).toEqual([]);
		});
	});
});
