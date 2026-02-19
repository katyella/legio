import { afterEach, beforeEach, describe, expect, vi, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../sessions/store.ts";
import type { LegioConfig } from "../types.ts";
import type { ConsistencyCheckDeps } from "./consistency.ts";
import { checkConsistency } from "./consistency.ts";

/**
 * Mock tmux functions using dependency injection instead of mock.module().
 * This avoids test isolation issues from module-level mocking.
 */
const mockListSessions = vi.fn(() => Promise.resolve([] as Array<{ name: string; pid: number }>));
const mockIsProcessAlive = vi.fn((_pid: number) => true);

/**
 * Create a minimal temp git repo for worktree tests.
 */
function createTempGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "legio-test-"));
	const git = (args: string[]) => {
		const result = spawnSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString() ?? ""}`);
		}
	};

	git(["init"]);
	git(["config", "user.email", "test@test.com"]);
	git(["config", "user.name", "Test User"]);
	git(["config", "commit.gpgsign", "false"]);
	writeFileSync(join(dir, "README.md"), "# Test Repo\n");
	git(["add", "."]);
	git(["commit", "-m", "Initial commit"]);

	return dir;
}

/**
 * Create a git worktree at the given path.
 */
function createWorktree(repoRoot: string, worktreePath: string, branchName: string): void {
	const result = spawnSync("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
		cwd: repoRoot,
		stdio: ["ignore", "ignore", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`Failed to create worktree: ${result.stderr?.toString() ?? ""}`);
	}
}

describe("checkConsistency", () => {
	let repoRoot: string;
	let legioDir: string;
	let config: LegioConfig;
	let mockDeps: ConsistencyCheckDeps;

	beforeEach(() => {
		repoRoot = createTempGitRepo();
		legioDir = join(repoRoot, ".legio");
		mkdirSync(legioDir, { recursive: true });
		mkdirSync(join(legioDir, "worktrees"), { recursive: true });

		config = {
			project: {
				name: "testproject",
				root: repoRoot,
				canonicalBranch: "main",
			},
			agents: {
				manifestPath: join(legioDir, "agent-manifest.json"),
				baseDir: join(repoRoot, "agents"),
				maxConcurrent: 5,
				staggerDelayMs: 100,
				maxDepth: 2,
			},
			worktrees: {
				baseDir: join(legioDir, "worktrees"),
			},
			beads: {
				enabled: false,
			},
			mulch: {
				enabled: false,
				domains: [],
				primeFormat: "markdown",
			},
			merge: {
				aiResolveEnabled: false,
				reimagineEnabled: false,
			},
			watchdog: {
				tier0Enabled: false,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 60000,
				zombieThresholdMs: 300000,
				nudgeIntervalMs: 30000,
			},
			models: {},
			logging: {
				verbose: false,
				redactSecrets: true,
			},
			autopilot: { intervalMs: 10_000, autoMerge: true, autoCleanWorktrees: false },
		};

		// Reset mocks and create deps object
		mockListSessions.mockReset();
		mockIsProcessAlive.mockReset();
		mockListSessions.mockResolvedValue([]);
		mockIsProcessAlive.mockReturnValue(true);

		mockDeps = {
			listSessions: mockListSessions,
			isProcessAlive: mockIsProcessAlive,
		};
	});

	afterEach(() => {
		if (existsSync(repoRoot)) {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	test("returns all pass when no sessions exist", async () => {
		const checks = await checkConsistency(config, legioDir, mockDeps);

		expect(checks.length).toBeGreaterThan(0);
		const passChecks = checks.filter((c) => c.status === "pass");
		expect(passChecks.length).toBeGreaterThan(0);

		const failChecks = checks.filter((c) => c.status === "fail");
		expect(failChecks.length).toBe(0);
	});

	test("detects orphaned worktrees", async () => {
		// Create a worktree but don't add it to SessionStore
		const worktreePath = join(legioDir, "worktrees", "orphan-agent");
		createWorktree(repoRoot, worktreePath, "legio/orphan-agent/test-123");

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const orphanCheck = checks.find((c) => c.name === "orphaned-worktrees");
		expect(orphanCheck).toBeDefined();
		expect(orphanCheck?.status).toBe("warn");
		expect(orphanCheck?.message).toContain("1 orphaned worktree");
		expect(orphanCheck?.details?.length).toBe(1);
		expect(orphanCheck?.fixable).toBe(true);
	});

	test("detects orphaned tmux sessions", async () => {
		// Mock a tmux session that isn't in SessionStore
		mockListSessions.mockResolvedValue([{ name: "legio-testproject-orphan", pid: 9999 }]);

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const orphanCheck = checks.find((c) => c.name === "orphaned-tmux");
		expect(orphanCheck).toBeDefined();
		expect(orphanCheck?.status).toBe("warn");
		expect(orphanCheck?.message).toContain("1 orphaned tmux session");
		expect(orphanCheck?.fixable).toBe(true);
	});

	test("ignores tmux sessions from other projects", async () => {
		// Mock tmux sessions from different projects
		mockListSessions.mockResolvedValue([
			{ name: "legio-otherproject-agent1", pid: 9999 },
			{ name: "my-custom-session", pid: 8888 },
		]);

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const orphanCheck = checks.find((c) => c.name === "orphaned-tmux");
		expect(orphanCheck).toBeDefined();
		expect(orphanCheck?.status).toBe("pass");
		expect(orphanCheck?.message).toContain("No orphaned tmux sessions");
	});

	test("detects dead PIDs in SessionStore", async () => {
		// Create a session with a PID that's marked as dead
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		store.upsert({
			id: "session-1",
			agentName: "dead-agent",
			capability: "builder",
			worktreePath: join(legioDir, "worktrees", "dead-agent"),
			branchName: "legio/dead-agent/test-123",
			beadId: "test-123",
			tmuxSession: "legio-testproject-dead-agent",
			state: "working",
			pid: 99999, // Non-existent PID
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// Mock that this PID is not alive
		mockIsProcessAlive.mockReturnValue(false);

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const deadPidCheck = checks.find((c) => c.name === "dead-pids");
		expect(deadPidCheck).toBeDefined();
		expect(deadPidCheck?.status).toBe("warn");
		expect(deadPidCheck?.message).toContain("1 session(s) with dead PIDs");
		expect(deadPidCheck?.fixable).toBe(true);
	});

	test("passes when all PIDs are alive", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		store.upsert({
			id: "session-1",
			agentName: "live-agent",
			capability: "builder",
			worktreePath: join(legioDir, "worktrees", "live-agent"),
			branchName: "legio/live-agent/test-123",
			beadId: "test-123",
			tmuxSession: "legio-testproject-live-agent",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// Mock that this PID is alive
		mockIsProcessAlive.mockReturnValue(true);

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const deadPidCheck = checks.find((c) => c.name === "dead-pids");
		expect(deadPidCheck).toBeDefined();
		expect(deadPidCheck?.status).toBe("pass");
	});

	test("detects missing worktrees for SessionStore entries", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		const missingWorktreePath = join(legioDir, "worktrees", "missing-agent");
		store.upsert({
			id: "session-1",
			agentName: "missing-agent",
			capability: "builder",
			worktreePath: missingWorktreePath,
			branchName: "legio/missing-agent/test-123",
			beadId: "test-123",
			tmuxSession: "legio-testproject-missing-agent",
			state: "working",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const missingCheck = checks.find((c) => c.name === "missing-worktrees");
		expect(missingCheck).toBeDefined();
		expect(missingCheck?.status).toBe("warn");
		expect(missingCheck?.message).toContain("1 session(s) with missing worktrees");
		expect(missingCheck?.fixable).toBe(true);
	});

	test("detects missing tmux sessions for SessionStore entries", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		const worktreePath = join(legioDir, "worktrees", "agent-without-tmux");
		createWorktree(repoRoot, worktreePath, "legio/agent-without-tmux/test-123");

		store.upsert({
			id: "session-1",
			agentName: "agent-without-tmux",
			capability: "builder",
			worktreePath,
			branchName: "legio/agent-without-tmux/test-123",
			beadId: "test-123",
			tmuxSession: "legio-testproject-agent-without-tmux",
			state: "working",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// Mock empty tmux sessions list
		mockListSessions.mockResolvedValue([]);

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const missingCheck = checks.find((c) => c.name === "missing-tmux");
		expect(missingCheck).toBeDefined();
		expect(missingCheck?.status).toBe("warn");
		expect(missingCheck?.message).toContain("1 session(s) with missing tmux sessions");
		expect(missingCheck?.fixable).toBe(true);
	});

	test("passes when everything is consistent", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		const worktreePath = join(legioDir, "worktrees", "consistent-agent");
		createWorktree(repoRoot, worktreePath, "legio/consistent-agent/test-123");

		store.upsert({
			id: "session-1",
			agentName: "consistent-agent",
			capability: "builder",
			worktreePath,
			branchName: "legio/consistent-agent/test-123",
			beadId: "test-123",
			tmuxSession: "legio-testproject-consistent-agent",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		// Mock matching tmux session
		mockListSessions.mockResolvedValue([
			{ name: "legio-testproject-consistent-agent", pid: 12345 },
		]);

		// Mock PID as alive
		mockIsProcessAlive.mockReturnValue(true);

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const warnOrFail = checks.filter((c) => c.status === "warn" || c.status === "fail");
		expect(warnOrFail.length).toBe(0);
	});

	test("handles tmux not installed gracefully", async () => {
		// Mock tmux listing to throw an error
		mockListSessions.mockRejectedValue(new Error("tmux: command not found"));

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const tmuxCheck = checks.find((c) => c.name === "tmux-listing");
		expect(tmuxCheck).toBeDefined();
		expect(tmuxCheck?.status).toBe("warn");
		expect(tmuxCheck?.message).toContain("Failed to list tmux sessions");
	});

	test("fails early if git worktree list fails", async () => {
		// Use a non-existent repo root to trigger worktree listing failure
		const badConfig = { ...config, project: { ...config.project, root: "/nonexistent" } };

		const checks = await checkConsistency(badConfig, legioDir, mockDeps);

		expect(checks.length).toBe(1);
		expect(checks[0]?.name).toBe("worktree-listing");
		expect(checks[0]?.status).toBe("fail");
	});

	test("fails early if SessionStore cannot be opened", async () => {
		// Use a bad legio directory path
		const badLegioDir = "/nonexistent/.legio";

		const checks = await checkConsistency(config, badLegioDir, mockDeps);

		const storeCheck = checks.find((c) => c.name === "sessionstore-open");
		expect(storeCheck).toBeDefined();
		expect(storeCheck?.status).toBe("fail");
	});

	test("reviewer-coverage: leads without reviewers emits warn", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		// Add 2 builder sessions under lead-1, no reviewers
		store.upsert({
			id: "session-1",
			agentName: "builder-1",
			capability: "builder",
			worktreePath: join(legioDir, "worktrees", "builder-1"),
			branchName: "legio/builder-1/test-123",
			beadId: "test-123",
			tmuxSession: "legio-testproject-builder-1",
			state: "working",
			pid: null,
			parentAgent: "lead-1",
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});

		store.upsert({
			id: "session-2",
			agentName: "builder-2",
			capability: "builder",
			worktreePath: join(legioDir, "worktrees", "builder-2"),
			branchName: "legio/builder-2/test-456",
			beadId: "test-456",
			tmuxSession: "legio-testproject-builder-2",
			state: "working",
			pid: null,
			parentAgent: "lead-1",
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const reviewerCheck = checks.find((c) => c.name === "reviewer-coverage");
		expect(reviewerCheck).toBeDefined();
		expect(reviewerCheck?.status).toBe("warn");
		expect(reviewerCheck?.message).toContain("without any reviewers");
		expect(reviewerCheck?.details).toBeDefined();
		expect(reviewerCheck?.details?.length).toBeGreaterThan(0);
	});

	test("reviewer-coverage: partial reviewer coverage emits warn", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		// Add 3 builders and 1 reviewer under same parent
		for (let i = 1; i <= 3; i++) {
			store.upsert({
				id: `session-builder-${i}`,
				agentName: `builder-${i}`,
				capability: "builder",
				worktreePath: join(legioDir, "worktrees", `builder-${i}`),
				branchName: `legio/builder-${i}/test-${i}`,
				beadId: `test-${i}`,
				tmuxSession: `legio-testproject-builder-${i}`,
				state: "working",
				pid: null,
				parentAgent: "lead-1",
				depth: 1,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
		}

		store.upsert({
			id: "session-reviewer-1",
			agentName: "reviewer-1",
			capability: "reviewer",
			worktreePath: join(legioDir, "worktrees", "reviewer-1"),
			branchName: "legio/reviewer-1/test-r1",
			beadId: "test-r1",
			tmuxSession: "legio-testproject-reviewer-1",
			state: "working",
			pid: null,
			parentAgent: "lead-1",
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const reviewerCheck = checks.find((c) => c.name === "reviewer-coverage");
		expect(reviewerCheck).toBeDefined();
		expect(reviewerCheck?.status).toBe("warn");
		expect(reviewerCheck?.message).toContain("partial reviewer coverage");
	});

	test("reviewer-coverage: full reviewer coverage emits pass", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		// Add 2 builders and 2 reviewers under same parent
		for (let i = 1; i <= 2; i++) {
			store.upsert({
				id: `session-builder-${i}`,
				agentName: `builder-${i}`,
				capability: "builder",
				worktreePath: join(legioDir, "worktrees", `builder-${i}`),
				branchName: `legio/builder-${i}/test-${i}`,
				beadId: `test-${i}`,
				tmuxSession: `legio-testproject-builder-${i}`,
				state: "working",
				pid: null,
				parentAgent: "lead-1",
				depth: 1,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});

			store.upsert({
				id: `session-reviewer-${i}`,
				agentName: `reviewer-${i}`,
				capability: "reviewer",
				worktreePath: join(legioDir, "worktrees", `reviewer-${i}`),
				branchName: `legio/reviewer-${i}/test-r${i}`,
				beadId: `test-r${i}`,
				tmuxSession: `legio-testproject-reviewer-${i}`,
				state: "working",
				pid: null,
				parentAgent: "lead-1",
				depth: 1,
				runId: null,
				startedAt: new Date().toISOString(),
				lastActivity: new Date().toISOString(),
				escalationLevel: 0,
				stalledSince: null,
			});
		}
		store.close();

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const reviewerCheck = checks.find((c) => c.name === "reviewer-coverage");
		expect(reviewerCheck).toBeDefined();
		expect(reviewerCheck?.status).toBe("pass");
	});

	test("reviewer-coverage: no builder sessions emits pass", async () => {
		// Don't create any sessions at all
		const checks = await checkConsistency(config, legioDir, mockDeps);

		const reviewerCheck = checks.find((c) => c.name === "reviewer-coverage");
		expect(reviewerCheck).toBeDefined();
		expect(reviewerCheck?.status).toBe("pass");
		expect(reviewerCheck?.message).toContain("No builder sessions found");
	});

	test("reviewer-coverage: multiple leads mixed coverage", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);

		// Lead-1 has builders + reviewers (good)
		store.upsert({
			id: "session-builder-1",
			agentName: "builder-1",
			capability: "builder",
			worktreePath: join(legioDir, "worktrees", "builder-1"),
			branchName: "legio/builder-1/test-1",
			beadId: "test-1",
			tmuxSession: "legio-testproject-builder-1",
			state: "working",
			pid: null,
			parentAgent: "lead-1",
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});

		store.upsert({
			id: "session-reviewer-1",
			agentName: "reviewer-1",
			capability: "reviewer",
			worktreePath: join(legioDir, "worktrees", "reviewer-1"),
			branchName: "legio/reviewer-1/test-r1",
			beadId: "test-r1",
			tmuxSession: "legio-testproject-reviewer-1",
			state: "working",
			pid: null,
			parentAgent: "lead-1",
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});

		// Lead-2 has builders only (bad)
		store.upsert({
			id: "session-builder-2",
			agentName: "builder-2",
			capability: "builder",
			worktreePath: join(legioDir, "worktrees", "builder-2"),
			branchName: "legio/builder-2/test-2",
			beadId: "test-2",
			tmuxSession: "legio-testproject-builder-2",
			state: "working",
			pid: null,
			parentAgent: "lead-2",
			depth: 1,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const checks = await checkConsistency(config, legioDir, mockDeps);

		const reviewerCheck = checks.find((c) => c.name === "reviewer-coverage");
		expect(reviewerCheck).toBeDefined();
		expect(reviewerCheck?.status).toBe("warn");
		expect(reviewerCheck?.details).toBeDefined();
		// Should contain lead-2 in the details
		const detailsStr = reviewerCheck?.details?.join(" ");
		expect(detailsStr).toContain("lead-2");
	});
});
