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
	merge: {
		aiResolveEnabled: false,
		reimagineEnabled: false,
	},
	watchdog: {
		tier0Enabled: false,
		tier0IntervalMs: 30000,
		tier1Enabled: false,
		tier2Enabled: false,
		zombieThresholdMs: 600000,
		nudgeIntervalMs: 60000,
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
		expect(checks.length).toBeGreaterThanOrEqual(5);

		// Verify we have checks for each tool
		const toolNames = checks.map((c) => c.name);
		expect(toolNames).toContain("git availability");
		expect(toolNames).toContain("node availability");
		expect(toolNames).toContain("tmux availability");
		expect(toolNames).toContain("sd availability");
		expect(toolNames).toContain("mulch availability");
		expect(toolNames).toContain("bd availability");
	});

	test("sd is required when backend is auto", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.legio");
		const sdCheck = checks.find((c) => c.name === "sd availability");
		// sd should be required (fail if missing) when backend is "auto"
		if (sdCheck?.status !== "pass") {
			expect(sdCheck?.status).toBe("fail");
		}
	});

	test("bd is optional when backend is auto", async () => {
		const checks = await checkDependencies(mockConfig, "/tmp/.legio");
		const bdCheck = checks.find((c) => c.name === "bd availability");
		// bd should be optional (warn if missing) when backend is "auto"
		if (bdCheck?.status !== "pass") {
			expect(bdCheck?.status).toBe("warn");
		}
	});

	test("bd is required when backend is beads", async () => {
		const beadsConfig = {
			...mockConfig,
			taskTracker: { backend: "beads" as const, enabled: true },
		};
		const checks = await checkDependencies(beadsConfig, "/tmp/.legio");
		const bdCheck = checks.find((c) => c.name === "bd availability");
		// bd should be required (fail if missing) when backend is "beads"
		if (bdCheck?.status !== "pass") {
			expect(bdCheck?.status).toBe("fail");
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
