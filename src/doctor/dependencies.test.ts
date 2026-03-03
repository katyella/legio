import { describe, expect, test } from "vitest";
import type { LegioConfig } from "../types.ts";
import { checkDependencies } from "./dependencies.ts";

// Minimal config for testing
const mockConfig: LegioConfig = {
	project: {
		name: "test-project",
		root: "/tmp/test",
		canonicalBranch: "main",
	},
	agents: {
		manifestPath: "/tmp/.legio/agent-manifest.json",
		baseDir: "/tmp/.legio/agents",
		maxConcurrent: 5,
		staggerDelayMs: 1000,
		maxDepth: 2,
	},
	worktrees: {
		baseDir: "/tmp/.legio/worktrees",
	},
	taskTracker: {
		backend: "auto" as const,
		enabled: false,
	},
	mulch: {
		enabled: false,
		domains: [],
		primeFormat: "markdown",
	},
	memory: {
		backend: "auto" as const,
		enabled: false,
		domains: [],
		primeFormat: "markdown" as const,
	},
	merge: {
		aiResolveEnabled: false,
		reimagineEnabled: false,
	},
	watchman: {
		tier0Enabled: false,
		tier0IntervalMs: 30000,
		tier1Enabled: false,
		tier2Enabled: false,
		zombieThresholdMs: 600000,
		nudgeIntervalMs: 60000,
		mailIntervalMs: 5_000,
		reNudgeIntervalMs: 10_000,
		warnAfterMs: 60_000,
		beaconNudgeMs: 20_000,
	},
	models: {},
	logging: {
		verbose: false,
		redactSecrets: true,
	},
};

describe("checkDependencies", () => {
	test("returns checks for all required tools", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.legio");

		expect(Array.isArray(checks)).toBe(true);
		expect(checks.length).toBeGreaterThanOrEqual(6);

		// Verify we have checks for each tool
		const toolNames = checks.map((c) => c.name);
		expect(toolNames).toContain("git availability");
		expect(toolNames).toContain("node availability");
		expect(toolNames).toContain("tmux availability");
		expect(toolNames).toContain("bun availability");
		expect(toolNames).toContain("sd availability");
		expect(toolNames).toContain("mulch availability");
		expect(toolNames).toContain("bd availability");
	});

	test("bun, sd, mulch, and bd are all optional (warn if missing)", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.legio");
		for (const name of ["bun", "sd", "mulch", "bd"]) {
			const check = checks.find((c) => c.name === `${name} availability`);
			if (check?.status !== "pass") {
				expect(check?.status).toBe("warn");
			}
		}
	});

	test("all checks have required DoctorCheck fields", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.legio");

		for (const check of checks) {
			expect(check).toHaveProperty("name");
			expect(check).toHaveProperty("category");
			expect(check).toHaveProperty("status");
			expect(check).toHaveProperty("message");

			expect(check.category).toBe("dependencies");
			expect(["pass", "warn", "fail"]).toContain(check.status);
			expect(typeof check.name).toBe("string");
			expect(typeof check.message).toBe("string");

			if (check.details !== undefined) {
				expect(Array.isArray(check.details)).toBe(true);
			}

			if (check.fixable !== undefined) {
				expect(typeof check.fixable).toBe("boolean");
			}
		}
	});

	test("checks for commonly available tools should pass", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.legio");

		// git and node should definitely be available in this environment
		const gitCheck = checks.find((c) => c.name === "git availability");
		const nodeCheck = checks.find((c) => c.name === "node availability");

		expect(gitCheck).toBeDefined();
		expect(nodeCheck).toBeDefined();

		// These should pass in a normal development environment
		expect(gitCheck?.status).toBe("pass");
		expect(nodeCheck?.status).toBe("pass");

		// Passing checks should include version info
		if (gitCheck?.status === "pass") {
			expect(Array.isArray(gitCheck.details)).toBe(true);
			expect(gitCheck.details?.length).toBeGreaterThan(0);
		}
	});

	test("checks include version details for available tools", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.legio");

		const passingChecks = checks.filter((c) => c.status === "pass");

		for (const check of passingChecks) {
			expect(check.details).toBeDefined();
			expect(Array.isArray(check.details)).toBe(true);
			expect(check.details?.length).toBeGreaterThan(0);

			// Version string should not be empty
			const version = check.details?.[0];
			expect(version).toBeDefined();
			expect(typeof version).toBe("string");
			expect(version?.length).toBeGreaterThan(0);
		}
	});

	test("failing checks are marked as fixable", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.legio");

		const failingChecks = checks.filter((c) => c.status === "fail" || c.status === "warn");

		// If there are any failing checks, they should be marked fixable
		for (const check of failingChecks) {
			expect(check.fixable).toBe(true);
		}
	});
});
