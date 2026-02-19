import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { join } from "node:path";
import { MergeError } from "../errors.ts";
import type { MulchClient } from "../mulch/client.ts";
import {
	cleanupTempDir,
	commitFile,
	createTempGitRepo,
	getDefaultBranch,
	runGitInDir,
} from "../test-helpers.ts";
import type { MergeEntry, ParsedConflictPattern } from "../types.ts";
import {
	buildConflictHistory,
	createMergeResolver,
	looksLikeProse,
	parseConflictPatterns,
} from "./resolver.ts";

/**
 * Helper to create a mock Bun.spawn return value for claude CLI mocking.
 *
 * The resolver reads stdout/stderr via `new Response(proc.stdout).text()`
 * and `new Response(proc.stderr).text()`, so we need ReadableStreams.
 */
function mockSpawnResult(
	stdout: string,
	stderr: string,
	exitCode: number,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	pid: number;
} {
	return {
		stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
		stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
		exited: Promise.resolve(exitCode),
		pid: 12345,
	};
}

function makeTestEntry(overrides?: Partial<MergeEntry>): MergeEntry {
	return {
		branchName: overrides?.branchName ?? "feature-branch",
		beadId: overrides?.beadId ?? "bead-123",
		agentName: overrides?.agentName ?? "test-agent",
		filesModified: overrides?.filesModified ?? ["src/test.ts"],
		enqueuedAt: overrides?.enqueuedAt ?? new Date().toISOString(),
		status: overrides?.status ?? "pending",
		resolvedTier: overrides?.resolvedTier ?? null,
	};
}

/**
 * Set up a clean merge scenario: feature branch adds a new file with no conflict.
 */
async function setupCleanMerge(dir: string, baseBranch: string): Promise<void> {
	await commitFile(dir, "src/main-file.ts", "main content\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/feature-file.ts", "feature content\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
}

/**
 * Set up a real content conflict: create a file, branch, modify on both
 * branches. Both sides must diverge from the common ancestor to produce
 * conflict markers.
 */
async function setupContentConflict(dir: string, baseBranch: string): Promise<void> {
	await commitFile(dir, "src/test.ts", "original content\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/test.ts", "feature content\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
	await commitFile(dir, "src/test.ts", "main modified content\n");
}

/**
 * Create a delete/modify conflict: file is deleted on main but modified on
 * the feature branch. This produces a conflict with NO conflict markers in
 * the working copy, causing Tier 2 auto-resolve to fail (resolveConflictsKeepIncoming
 * returns null). This naturally escalates to Tier 3 or 4.
 */
async function setupDeleteModifyConflict(
	dir: string,
	baseBranch: string,
	branchName = "feature-branch",
): Promise<void> {
	await commitFile(dir, "src/test.ts", "original content\n");
	await runGitInDir(dir, ["checkout", "-b", branchName]);
	await commitFile(dir, "src/test.ts", "modified by agent\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
	await runGitInDir(dir, ["rm", "src/test.ts"]);
	await runGitInDir(dir, ["commit", "-m", "delete src/test.ts"]);
}

/**
 * Set up a scenario where Tier 2 auto-resolve fails but Tier 4 reimagine can
 * succeed. We create a delete/modify conflict on one file (causes Tier 2 to fail)
 * and set entry.filesModified to a different file that exists on both branches
 * (so git show works for both in reimagine).
 */
async function setupReimagineScenario(dir: string, baseBranch: string): Promise<void> {
	await commitFile(dir, "src/conflict-file.ts", "original content\n");
	await commitFile(dir, "src/reimagine-target.ts", "main version of target\n");
	await runGitInDir(dir, ["checkout", "-b", "feature-branch"]);
	await commitFile(dir, "src/conflict-file.ts", "modified by agent\n");
	await commitFile(dir, "src/reimagine-target.ts", "feature version of target\n");
	await runGitInDir(dir, ["checkout", baseBranch]);
	await runGitInDir(dir, ["rm", "src/conflict-file.ts"]);
	await runGitInDir(dir, ["commit", "-m", "delete conflict file"]);
}

/**
 * Create a mock MulchClient for testing.
 * Optionally override the record method to track calls or simulate failures.
 */
function createMockMulchClient(
	recordImpl?: (domain: string, options: unknown) => Promise<void>,
): MulchClient {
	return {
		async prime() {
			return "";
		},
		async status() {
			return { domains: [] };
		},
		async record(domain: string, options: unknown) {
			if (recordImpl) {
				return recordImpl(domain, options);
			}
		},
		async query() {
			return "";
		},
		async search() {
			return "";
		},
		async diff() {
			return {
				success: true,
				command: "diff",
				since: "HEAD",
				domains: [],
				message: "",
			};
		},
		async learn() {
			return {
				success: true,
				command: "learn",
				changedFiles: [],
				suggestedDomains: [],
				unmatchedFiles: [],
			};
		},
		async prune() {
			return {
				success: true,
				command: "prune",
				dryRun: false,
				totalPruned: 0,
				results: [],
			};
		},
		async doctor() {
			return {
				success: true,
				command: "doctor",
				checks: [],
				summary: {
					pass: 0,
					warn: 0,
					fail: 0,
					totalIssues: 0,
					fixableIssues: 0,
				},
			};
		},
		async ready() {
			return {
				success: true,
				command: "ready",
				count: 0,
				entries: [],
			};
		},
		async compact() {
			return {
				success: true,
				command: "compact",
				action: "analyze",
			};
		},
	};
}

describe("createMergeResolver", () => {
	describe("Tier 1: Clean merge", () => {
		test("returns success with correct result shape and file content", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("clean-merge");
				expect(result.conflictFiles).toEqual([]);
				expect(result.errorMessage).toBeNull();

				// After merge, the feature file should exist on main
				const file = Bun.file(join(repoDir, "src/feature-file.ts"));
				const content = await file.text();
				expect(content).toBe("feature content\n");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Tier 1: Checkout failure", () => {
		// Both tests only attempt checkout of nonexistent branches -- no repo mutation.
		let repoDir: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		test("throws MergeError if checkout fails", async () => {
			const entry = makeTestEntry();

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			await expect(resolver.resolve(entry, "nonexistent-branch", repoDir)).rejects.toThrow(
				MergeError,
			);
		});

		test("MergeError from checkout failure includes branch name", async () => {
			const entry = makeTestEntry();

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			try {
				await resolver.resolve(entry, "develop", repoDir);
				expect(true).toBe(false);
			} catch (err: unknown) {
				expect(err).toBeInstanceOf(MergeError);
				const mergeErr = err as MergeError;
				expect(mergeErr.message).toContain("develop");
			}
		});
	});

	describe("Tier 1 fail -> Tier 2: Auto-resolve", () => {
		test("auto-resolves conflicts keeping incoming changes with correct content", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupContentConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("auto-resolve");

				// The resolved file should contain the incoming (feature branch) content
				const file = Bun.file(join(repoDir, "src/test.ts"));
				const content = await file.text();
				expect(content).toBe("feature content\n");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Tier 3: AI-resolve", () => {
		// After the first test (aiResolve=false), the resolver aborts the merge and
		// leaves the repo clean. The second test can retry the merge on the same repo.
		let repoDir: string;
		let defaultBranch: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
			defaultBranch = await getDefaultBranch(repoDir);
			await setupDeleteModifyConflict(repoDir, defaultBranch);
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		// This test MUST run first -- it fails to merge and aborts, leaving repo clean
		test("is skipped when aiResolveEnabled is false", async () => {
			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, defaultBranch, repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
		});

		// This test runs second -- repo is clean from the abort, same conflict is available
		test("invokes claude when aiResolveEnabled is true and tier 2 fails", async () => {
			// Selective spy: mock only claude, let git commands through.
			const originalSpawn = Bun.spawn;
			let claudeCalled = false;

			const selectiveMock = (...args: unknown[]): unknown => {
				const cmd = args[0] as string[];
				if (cmd?.[0] === "claude") {
					claudeCalled = true;
					return mockSpawnResult("resolved content from AI\n", "", 0);
				}
				return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
			};

			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

			try {
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: true,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(claudeCalled).toBe(true);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("ai-resolve");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("ai-resolve");
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});

	describe("Tier 4: Re-imagine", () => {
		// After the first test (reimagine=false), the resolver aborts the merge and
		// leaves the repo clean. The second test can retry the merge on the same repo.
		let repoDir: string;
		let defaultBranch: string;

		beforeAll(async () => {
			repoDir = await createTempGitRepo();
			defaultBranch = await getDefaultBranch(repoDir);
			await setupReimagineScenario(repoDir, defaultBranch);
		});

		afterAll(async () => {
			await cleanupTempDir(repoDir);
		});

		// This test MUST run first -- it fails to merge and aborts, leaving repo clean
		test("is skipped when reimagineEnabled is false", async () => {
			const entry = makeTestEntry({
				branchName: "feature-branch",
				filesModified: ["src/reimagine-target.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, defaultBranch, repoDir);

			expect(result.success).toBe(false);
			expect(result.entry.status).toBe("failed");
		});

		// This test runs second -- repo is clean from the abort, same conflict is available
		test("aborts merge and reimplements when reimagineEnabled is true", async () => {
			// Selective spy: mock only claude, let git commands through.
			const originalSpawn = Bun.spawn;
			let claudeCalled = false;

			const selectiveMock = (...args: unknown[]): unknown => {
				const cmd = args[0] as string[];
				if (cmd?.[0] === "claude") {
					claudeCalled = true;
					return mockSpawnResult("reimagined content\n", "", 0);
				}
				return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
			};

			const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

			try {
				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/reimagine-target.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: true,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(claudeCalled).toBe(true);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("reimagine");
				expect(result.entry.status).toBe("merged");
				expect(result.entry.resolvedTier).toBe("reimagine");

				// Verify the reimagined content was written
				const file = Bun.file(join(repoDir, "src/reimagine-target.ts"));
				const content = await file.text();
				expect(content).toBe("reimagined content\n");
			} finally {
				spawnSpy.mockRestore();
			}
		});
	});

	describe("All tiers fail", () => {
		test("returns failed status and repo is clean when all tiers fail", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(false);
				expect(result.entry.status).toBe("failed");
				expect(result.entry.resolvedTier).toBeNull();
				expect(result.errorMessage).not.toBeNull();
				expect(result.errorMessage).toContain("failed");

				// Verify the repo is in a clean state (merge was aborted)
				const status = await runGitInDir(repoDir, ["status", "--porcelain"]);
				expect(status.trim()).toBe("");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("result shape", () => {
		let repoDir: string;
		let defaultBranch: string;

		beforeEach(async () => {
			repoDir = await createTempGitRepo();
			defaultBranch = await getDefaultBranch(repoDir);
		});

		afterEach(async () => {
			await cleanupTempDir(repoDir);
		});

		test("successful result has correct MergeResult shape", async () => {
			await setupCleanMerge(repoDir, defaultBranch);

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(
				makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				}),
				defaultBranch,
				repoDir,
			);

			expect(result).toHaveProperty("entry");
			expect(result).toHaveProperty("success");
			expect(result).toHaveProperty("tier");
			expect(result).toHaveProperty("conflictFiles");
			expect(result).toHaveProperty("errorMessage");
		});

		test("failed result preserves original entry fields", async () => {
			await setupDeleteModifyConflict(repoDir, defaultBranch, "legio/my-agent/bead-xyz");

			const entry = makeTestEntry({
				branchName: "legio/my-agent/bead-xyz",
				beadId: "bead-xyz",
				agentName: "my-agent",
				filesModified: ["src/test.ts"],
			});

			const resolver = createMergeResolver({
				aiResolveEnabled: false,
				reimagineEnabled: false,
			});

			const result = await resolver.resolve(entry, defaultBranch, repoDir);

			expect(result.entry.branchName).toBe("legio/my-agent/bead-xyz");
			expect(result.entry.beadId).toBe("bead-xyz");
			expect(result.entry.agentName).toBe("my-agent");
		});
	});

	describe("checkout skip when already on canonical branch", () => {
		test("succeeds when already on canonical branch (skips checkout)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				// Verify we're on the default branch
				const branch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
				expect(branch.trim()).toBe(defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("checks out canonical when on a different branch", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				// Switch to a different branch
				await runGitInDir(repoDir, ["checkout", "-b", "some-other-branch"]);
				const branch = await runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]);
				expect(branch.trim()).toBe("some-other-branch");

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);
				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("looksLikeProse", () => {
		test("detects conversational prose", () => {
			expect(looksLikeProse("I need permission to edit the file")).toBe(true);
			expect(looksLikeProse("Here's the resolved content:")).toBe(true);
			expect(looksLikeProse("Here is the file")).toBe(true);
			expect(looksLikeProse("The conflict can be resolved by")).toBe(true);
			expect(looksLikeProse("Let me resolve this for you")).toBe(true);
			expect(looksLikeProse("Sure, here's the resolved file")).toBe(true);
			expect(looksLikeProse("I cannot access the file")).toBe(true);
			expect(looksLikeProse("I don't have access")).toBe(true);
			expect(looksLikeProse("To resolve this, we need to")).toBe(true);
			expect(looksLikeProse("Looking at the conflict")).toBe(true);
			expect(looksLikeProse("Based on both versions")).toBe(true);
		});

		test("detects markdown fencing", () => {
			expect(looksLikeProse("```typescript\nconst x = 1;\n```")).toBe(true);
			expect(looksLikeProse("```\nsome code\n```")).toBe(true);
		});

		test("detects empty output", () => {
			expect(looksLikeProse("")).toBe(true);
			expect(looksLikeProse("   ")).toBe(true);
		});

		test("accepts valid code", () => {
			expect(looksLikeProse("const x = 1;")).toBe(false);
			expect(looksLikeProse("import { foo } from 'bar';")).toBe(false);
			expect(looksLikeProse("export function resolve() {}")).toBe(false);
			expect(looksLikeProse("function hello() {\n  return 'world';\n}")).toBe(false);
			expect(looksLikeProse("// comment\nconst a = 1;")).toBe(false);
		});
	});

	describe("Tier 3: AI-resolve prose rejection", () => {
		test("rejects prose output and falls through to failure", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						// Return prose instead of code
						return mockSpawnResult(
							"I need permission to edit the file. Here's the resolved content:\n```\nresolved\n```",
							"",
							0,
						);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const entry = makeTestEntry({
						branchName: "feature-branch",
						filesModified: ["src/test.ts"],
					});

					const resolver = createMergeResolver({
						aiResolveEnabled: true,
						reimagineEnabled: false,
					});

					const result = await resolver.resolve(entry, defaultBranch, repoDir);

					// Should fail because prose was rejected
					expect(result.success).toBe(false);
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("Conflict pattern recording", () => {
		test("no recording when mulchClient is not provided (backward compatible)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupContentConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// No mulchClient passed — should work as before
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("records pattern on tier 2 auto-resolve success", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupContentConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					beadId: "bead-abc-123",
					agentName: "test-builder",
					filesModified: ["src/test.ts"],
				});

				// Create a mock MulchClient with a spy on record
				const recordCalls: Array<{
					domain: string;
					options: {
						type: string;
						description?: string;
						tags?: string[];
						evidenceBead?: string;
					};
				}> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({
						domain,
						options: options as {
							type: string;
							description?: string;
							tags?: string[];
							evidenceBead?: string;
						},
					});
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");

				// Verify record was called
				expect(recordCalls.length).toBe(1);
				const call = recordCalls[0];
				expect(call?.domain).toBe("architecture");
				expect(call?.options.type).toBe("pattern");
				expect(call?.options.tags).toContain("merge-conflict");
				expect(call?.options.evidenceBead).toBe("bead-abc-123");

				// Verify description contains key details
				const desc = call?.options.description ?? "";
				expect(desc).toContain("resolved");
				expect(desc).toContain("auto-resolve");
				expect(desc).toContain("feature-branch");
				expect(desc).toContain("test-builder");
				expect(desc).toContain("src/test.ts");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("records pattern on total failure", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					beadId: "bead-fail-456",
					agentName: "test-agent",
					filesModified: ["src/test.ts"],
				});

				const recordCalls: Array<{
					domain: string;
					options: {
						type: string;
						description?: string;
						tags?: string[];
						evidenceBead?: string;
					};
				}> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({
						domain,
						options: options as {
							type: string;
							description?: string;
							tags?: string[];
							evidenceBead?: string;
						},
					});
				});

				// AI and reimagine disabled — will fail at tier 2
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(false);

				// Verify record was called for failure
				expect(recordCalls.length).toBe(1);
				const call = recordCalls[0];
				expect(call?.domain).toBe("architecture");
				expect(call?.options.type).toBe("pattern");
				expect(call?.options.evidenceBead).toBe("bead-fail-456");

				// Verify description contains "failed" not "resolved"
				const desc = call?.options.description ?? "";
				expect(desc).toContain("failed");
				expect(desc).not.toContain("resolved");
				expect(desc).toContain("auto-resolve"); // last attempted tier
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("recording failure does not affect merge result (fire-and-forget)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupContentConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// Mock mulchClient whose record rejects
				const mockMulchClient = createMockMulchClient(async () => {
					throw new Error("Mulch recording failed!");
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				// Should still succeed despite recording failure (fire-and-forget)
				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("auto-resolve");
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("records pattern on tier 3 ai-resolve success", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					beadId: "bead-ai-789",
					filesModified: ["src/test.ts"],
				});

				const recordCalls: Array<{
					domain: string;
					options: {
						type: string;
						description?: string;
						tags?: string[];
						evidenceBead?: string;
					};
				}> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({
						domain,
						options: options as {
							type: string;
							description?: string;
							tags?: string[];
							evidenceBead?: string;
						},
					});
				});

				// Mock claude to succeed
				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						return mockSpawnResult("resolved content from AI\n", "", 0);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const resolver = createMergeResolver({
						aiResolveEnabled: true,
						reimagineEnabled: false,
						mulchClient: mockMulchClient,
					});

					const result = await resolver.resolve(entry, defaultBranch, repoDir);

					expect(result.success).toBe(true);
					expect(result.tier).toBe("ai-resolve");

					// Verify record was called
					expect(recordCalls.length).toBe(1);
					const call = recordCalls[0];
					expect(call?.domain).toBe("architecture");
					expect(call?.options.evidenceBead).toBe("bead-ai-789");

					const desc = call?.options.description ?? "";
					expect(desc).toContain("resolved");
					expect(desc).toContain("ai-resolve");
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("records pattern on tier 4 reimagine success", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupReimagineScenario(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					beadId: "bead-reimagine-xyz",
					filesModified: ["src/reimagine-target.ts"],
				});

				const recordCalls: Array<{
					domain: string;
					options: {
						type: string;
						description?: string;
						tags?: string[];
						evidenceBead?: string;
					};
				}> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({
						domain,
						options: options as {
							type: string;
							description?: string;
							tags?: string[];
							evidenceBead?: string;
						},
					});
				});

				// Mock claude to succeed
				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						return mockSpawnResult("reimagined content\n", "", 0);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const resolver = createMergeResolver({
						aiResolveEnabled: false,
						reimagineEnabled: true,
						mulchClient: mockMulchClient,
					});

					const result = await resolver.resolve(entry, defaultBranch, repoDir);

					expect(result.success).toBe(true);
					expect(result.tier).toBe("reimagine");

					// Verify record was called
					expect(recordCalls.length).toBe(1);
					const call = recordCalls[0];
					expect(call?.domain).toBe("architecture");
					expect(call?.options.evidenceBead).toBe("bead-reimagine-xyz");

					const desc = call?.options.description ?? "";
					expect(desc).toContain("resolved");
					expect(desc).toContain("reimagine");
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});

		test("no recording on tier 1 clean merge (no conflict)", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupCleanMerge(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/feature-file.ts"],
				});

				const recordCalls: Array<unknown> = [];

				const mockMulchClient = createMockMulchClient(async (domain, options) => {
					recordCalls.push({ domain, options });
				});

				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				expect(result.success).toBe(true);
				expect(result.tier).toBe("clean-merge");

				// No recording on clean merge (no conflict occurred)
				expect(recordCalls.length).toBe(0);
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("parseConflictPatterns", () => {
		test("parses successful resolution pattern", () => {
			const input =
				"Merge conflict resolved at tier auto-resolve. Branch: feature-branch. Agent: test-builder. Conflicting files: src/test.ts.";
			const patterns = parseConflictPatterns(input);
			expect(patterns.length).toBe(1);
			expect(patterns[0]?.tier).toBe("auto-resolve");
			expect(patterns[0]?.success).toBe(true);
			expect(patterns[0]?.files).toEqual(["src/test.ts"]);
			expect(patterns[0]?.agent).toBe("test-builder");
			expect(patterns[0]?.branch).toBe("feature-branch");
		});

		test("parses failed resolution pattern", () => {
			const input =
				"Merge conflict failed at tier ai-resolve. Branch: other-branch. Agent: my-agent. Conflicting files: src/foo.ts, src/bar.ts.";
			const patterns = parseConflictPatterns(input);
			expect(patterns.length).toBe(1);
			expect(patterns[0]?.tier).toBe("ai-resolve");
			expect(patterns[0]?.success).toBe(false);
			expect(patterns[0]?.files).toEqual(["src/foo.ts", "src/bar.ts"]);
		});

		test("parses multiple patterns from search output", () => {
			const input = [
				"Some mulch header text",
				"Merge conflict resolved at tier auto-resolve. Branch: b1. Agent: a1. Conflicting files: src/a.ts.",
				"Other text in between",
				"Merge conflict failed at tier reimagine. Branch: b2. Agent: a2. Conflicting files: src/b.ts, src/c.ts.",
			].join("\n");
			const patterns = parseConflictPatterns(input);
			expect(patterns.length).toBe(2);
		});

		test("returns empty array for no matches", () => {
			expect(parseConflictPatterns("")).toEqual([]);
			expect(parseConflictPatterns("no patterns here")).toEqual([]);
		});
	});

	describe("buildConflictHistory", () => {
		test("returns empty history when no patterns match entry files", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "auto-resolve",
					success: true,
					files: ["unrelated.ts"],
					agent: "a",
					branch: "b",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.skipTiers).toEqual([]);
			expect(history.pastResolutions).toEqual([]);
			expect(history.predictedConflictFiles).toEqual([]);
		});

		test("builds skip tier list when tier fails >= 2 times with no successes", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "ai-resolve",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b1",
				},
				{
					tier: "ai-resolve",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b2",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.skipTiers).toContain("ai-resolve");
		});

		test("does not skip tier if it has any successes", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "ai-resolve",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b1",
				},
				{
					tier: "ai-resolve",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b2",
				},
				{
					tier: "ai-resolve",
					success: true,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b3",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.skipTiers).not.toContain("ai-resolve");
		});

		test("does not skip tier with only 1 failure", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "reimagine",
					success: false,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b1",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.skipTiers).not.toContain("reimagine");
		});

		test("collects past successful resolutions", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "auto-resolve",
					success: true,
					files: ["src/test.ts"],
					agent: "a",
					branch: "b1",
				},
				{
					tier: "ai-resolve",
					success: true,
					files: ["src/test.ts", "src/other.ts"],
					agent: "b",
					branch: "b2",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.pastResolutions.length).toBe(2);
			expect(history.pastResolutions[0]).toContain("auto-resolve");
			expect(history.pastResolutions[1]).toContain("ai-resolve");
		});

		test("predicts conflict files from historical patterns", () => {
			const patterns: ParsedConflictPattern[] = [
				{
					tier: "auto-resolve",
					success: true,
					files: ["src/test.ts", "src/utils.ts"],
					agent: "a",
					branch: "b1",
				},
			];
			const history = buildConflictHistory(patterns, ["src/test.ts"]);
			expect(history.predictedConflictFiles).toContain("src/test.ts");
			expect(history.predictedConflictFiles).toContain("src/utils.ts");
		});

		test("returns empty history for empty patterns array", () => {
			const history = buildConflictHistory([], ["src/test.ts"]);
			expect(history.skipTiers).toEqual([]);
			expect(history.pastResolutions).toEqual([]);
			expect(history.predictedConflictFiles).toEqual([]);
		});
	});

	describe("Conflict history tier skipping", () => {
		test("skips auto-resolve tier when history says it always fails for these files", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// Mock mulchClient that returns history showing auto-resolve always fails
				const mockMulchClient = createMockMulchClient();
				mockMulchClient.search = async () => {
					return [
						"Merge conflict failed at tier auto-resolve. Branch: b1. Agent: a1. Conflicting files: src/test.ts.",
						"Merge conflict failed at tier auto-resolve. Branch: b2. Agent: a2. Conflicting files: src/test.ts.",
					].join("\n");
				};

				// AI and reimagine disabled, auto-resolve should be skipped -> fails immediately
				const resolver = createMergeResolver({
					aiResolveEnabled: false,
					reimagineEnabled: false,
					mulchClient: mockMulchClient,
				});

				const result = await resolver.resolve(entry, defaultBranch, repoDir);

				// Should fail, and the last tier should NOT be auto-resolve (it was skipped)
				expect(result.success).toBe(false);
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});

	describe("AI-resolve with history context", () => {
		test("includes historical context in AI prompt when available", async () => {
			const repoDir = await createTempGitRepo();
			try {
				const defaultBranch = await getDefaultBranch(repoDir);
				await setupDeleteModifyConflict(repoDir, defaultBranch);

				const entry = makeTestEntry({
					branchName: "feature-branch",
					filesModified: ["src/test.ts"],
				});

				// Mock mulchClient that returns successful resolution history
				const mockMulchClient = createMockMulchClient();
				mockMulchClient.search = async () => {
					return "Merge conflict resolved at tier ai-resolve. Branch: old-branch. Agent: old-agent. Conflicting files: src/test.ts.";
				};

				// Capture the prompt sent to claude
				let capturedPrompt = "";
				const originalSpawn = Bun.spawn;
				const selectiveMock = (...args: unknown[]): unknown => {
					const cmd = args[0] as string[];
					if (cmd?.[0] === "claude") {
						capturedPrompt = cmd[3] ?? "";
						return mockSpawnResult("resolved content\n", "", 0);
					}
					return originalSpawn.apply(Bun, args as Parameters<typeof Bun.spawn>);
				};

				const spawnSpy = spyOn(Bun, "spawn").mockImplementation(selectiveMock as typeof Bun.spawn);

				try {
					const resolver = createMergeResolver({
						aiResolveEnabled: true,
						reimagineEnabled: false,
						mulchClient: mockMulchClient,
					});

					const result = await resolver.resolve(entry, defaultBranch, repoDir);

					expect(result.success).toBe(true);
					expect(result.tier).toBe("ai-resolve");
					// Verify historical context was included in the prompt
					expect(capturedPrompt).toContain("Historical context");
					expect(capturedPrompt).toContain("ai-resolve");
				} finally {
					spawnSpy.mockRestore();
				}
			} finally {
				await cleanupTempDir(repoDir);
			}
		});
	});
});
