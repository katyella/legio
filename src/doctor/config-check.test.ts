import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LegioConfig } from "../types.ts";
import { checkConfig } from "./config-check.ts";

// Helper to create a temp legio dir with config.yaml
function createTempLegioDir(configYaml: string): string {
	const tempDir = mkdtempSync(join(tmpdir(), "legio-test-"));
	const legioDir = join(tempDir, ".legio");
	mkdirSync(legioDir, { recursive: true });
	writeFileSync(join(legioDir, "config.yaml"), configYaml);
	return legioDir;
}

// Valid minimal config
const validConfigYaml = `
projectName: test-project
project:
  root: ${tmpdir()}
  canonicalBranch: main
maxConcurrent: 5
maxDepth: 2
watchdog:
  tier0Enabled: false
  tier1Enabled: false
  tier2Enabled: false
  tier3Enabled: false
`;

const mockConfig: LegioConfig = {
	project: {
		name: "test-project",
		root: tmpdir(),
		canonicalBranch: "main",
	},
	agents: {
		manifestPath: `${tmpdir()}/.legio/agent-manifest.json`,
		baseDir: `${tmpdir()}/.legio/agents`,
		maxConcurrent: 5,
		staggerDelayMs: 1000,
		maxDepth: 2,
	},
	worktrees: {
		baseDir: `${tmpdir()}/.legio/worktrees`,
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
		staleThresholdMs: 300000,
		zombieThresholdMs: 600000,
		nudgeIntervalMs: 60000,
	},
	models: {},
	logging: {
		verbose: false,
		redactSecrets: true,
	},
	autopilot: { intervalMs: 10_000, autoMerge: true, autoCleanWorktrees: false },
};

describe("checkConfig", () => {
	test("returns checks with category config", async () => {
		const legioDir = createTempLegioDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, legioDir);

		expect(Array.isArray(checks)).toBe(true);
		expect(checks.length).toBeGreaterThan(0);

		for (const check of checks) {
			expect(check.category).toBe("config");
		}
	});

	test("includes all four config checks", async () => {
		const legioDir = createTempLegioDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, legioDir);

		const checkNames = checks.map((c) => c.name);
		expect(checkNames).toContain("config-parseable");
		expect(checkNames).toContain("config-valid");
		expect(checkNames).toContain("project-root-exists");
		expect(checkNames).toContain("canonical-branch-exists");
	});

	test("config-parseable passes with valid config", async () => {
		const legioDir = createTempLegioDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, legioDir);

		const parseableCheck = checks.find((c) => c.name === "config-parseable");
		expect(parseableCheck).toBeDefined();
		expect(parseableCheck?.status).toBe("pass");
	});

	test("config-valid passes with valid config", async () => {
		const legioDir = createTempLegioDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, legioDir);

		const validCheck = checks.find((c) => c.name === "config-valid");
		expect(validCheck).toBeDefined();
		expect(validCheck?.status).toBe("pass");
	});

	test("project-root-exists passes when directory exists", async () => {
		const legioDir = createTempLegioDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, legioDir);

		const rootCheck = checks.find((c) => c.name === "project-root-exists");
		expect(rootCheck).toBeDefined();
		expect(rootCheck?.status).toBe("pass");
		expect(rootCheck?.details).toBeDefined();
	});

	test("project-root-exists fails when directory does not exist", async () => {
		const legioDir = createTempLegioDir(validConfigYaml);
		const configWithBadRoot = {
			...mockConfig,
			project: {
				...mockConfig.project,
				root: "/nonexistent/path/that/does/not/exist",
			},
		};
		const checks = await checkConfig(configWithBadRoot, legioDir);

		const rootCheck = checks.find((c) => c.name === "project-root-exists");
		expect(rootCheck).toBeDefined();
		expect(rootCheck?.status).toBe("fail");
		expect(rootCheck?.fixable).toBe(true);
	});

	test("canonical-branch-exists warns when branch does not exist", async () => {
		const legioDir = createTempLegioDir(validConfigYaml);
		const configWithBadBranch = {
			...mockConfig,
			project: {
				...mockConfig.project,
				canonicalBranch: "nonexistent-branch-xyz",
			},
		};
		const checks = await checkConfig(configWithBadBranch, legioDir);

		const branchCheck = checks.find((c) => c.name === "canonical-branch-exists");
		expect(branchCheck).toBeDefined();
		expect(branchCheck?.status).toBe("warn");
		expect(branchCheck?.message).toContain("nonexistent-branch-xyz");
	});

	test("all checks have required DoctorCheck fields", async () => {
		const legioDir = createTempLegioDir(validConfigYaml);
		const checks = await checkConfig(mockConfig, legioDir);

		for (const check of checks) {
			expect(check).toHaveProperty("name");
			expect(check).toHaveProperty("category");
			expect(check).toHaveProperty("status");
			expect(check).toHaveProperty("message");

			expect(typeof check.name).toBe("string");
			expect(typeof check.message).toBe("string");
			expect(["pass", "warn", "fail"]).toContain(check.status);

			if (check.details !== undefined) {
				expect(Array.isArray(check.details)).toBe(true);
			}

			if (check.fixable !== undefined) {
				expect(typeof check.fixable).toBe("boolean");
			}
		}
	});
});
