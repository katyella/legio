import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { ValidationError } from "./errors.ts";

describe("loadConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "legio-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeConfig(yaml: string): Promise<void> {
		const legioDir = join(tempDir, ".legio");
		await writeFile(join(legioDir, "config.yaml"), yaml);
	}

	async function ensureLegioDir(): Promise<void> {
		await mkdir(join(tempDir, ".legio"), { recursive: true });
	}

	test("returns defaults when no config file exists", async () => {
		const config = await loadConfig(tempDir);

		expect(config.project.root).toBe(tempDir);
		expect(config.project.canonicalBranch).toBe("main");
		expect(config.agents.maxConcurrent).toBe(25);
		expect(config.agents.maxDepth).toBe(2);
		expect(config.taskTracker.enabled).toBe(true);
		expect(config.taskTracker.backend).toBe("auto");
		expect(config.mulch.enabled).toBe(true);
		expect(config.mulch.primeFormat).toBe("markdown");
		expect(config.logging.verbose).toBe(false);
	});

	test("sets project.name from directory name", async () => {
		const config = await loadConfig(tempDir);
		const parts = tempDir.split("/");
		const expectedName = parts[parts.length - 1] ?? "unknown";
		expect(config.project.name).toBe(expectedName);
	});

	test("merges config file values over defaults", async () => {
		await ensureLegioDir();
		await writeConfig(`
project:
  canonicalBranch: develop
agents:
  maxConcurrent: 10
`);

		const config = await loadConfig(tempDir);

		expect(config.project.canonicalBranch).toBe("develop");
		expect(config.agents.maxConcurrent).toBe(10);
		// Non-overridden values keep defaults
		expect(config.agents.maxDepth).toBe(2);
		expect(config.taskTracker.enabled).toBe(true);
	});

	test("always sets project.root to the actual projectRoot", async () => {
		await ensureLegioDir();
		await writeConfig(`
project:
  root: /some/wrong/path
`);

		const config = await loadConfig(tempDir);
		expect(config.project.root).toBe(tempDir);
	});

	test("parses boolean values correctly", async () => {
		await ensureLegioDir();
		await writeConfig(`
taskTracker:
  enabled: false
  backend: beads
mulch:
  enabled: true
logging:
  verbose: true
  redactSecrets: false
`);

		const config = await loadConfig(tempDir);

		expect(config.taskTracker.enabled).toBe(false);
		expect(config.taskTracker.backend).toBe("beads");
		expect(config.mulch.enabled).toBe(true);
		expect(config.logging.verbose).toBe(true);
		expect(config.logging.redactSecrets).toBe(false);
	});

	test("parses empty array literal", async () => {
		await ensureLegioDir();
		await writeConfig(`
mulch:
  domains: []
`);

		const config = await loadConfig(tempDir);
		expect(config.mulch.domains).toEqual([]);
	});

	test("parses numeric values including underscore-separated", async () => {
		await ensureLegioDir();
		await writeConfig(`
agents:
  staggerDelayMs: 5000
watchdog:
  tier0IntervalMs: 60000
  zombieThresholdMs: 300000
`);

		const config = await loadConfig(tempDir);
		expect(config.agents.staggerDelayMs).toBe(5000);
		expect(config.watchdog.tier0IntervalMs).toBe(60000);
	});

	test("handles quoted string values", async () => {
		await ensureLegioDir();
		await writeConfig(`
project:
  canonicalBranch: "develop"
`);

		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("develop");
	});

	test("ignores comments and empty lines", async () => {
		await ensureLegioDir();
		await writeConfig(`
# This is a comment
project:
  canonicalBranch: develop  # inline comment

  # Another comment
agents:
  maxConcurrent: 3
`);

		const config = await loadConfig(tempDir);
		expect(config.project.canonicalBranch).toBe("develop");
		expect(config.agents.maxConcurrent).toBe(3);
	});

	test("config.local.yaml overrides values from config.yaml", async () => {
		await ensureLegioDir();
		await writeConfig(`
project:
  canonicalBranch: develop
agents:
  maxConcurrent: 10
`);
		await writeFile(join(tempDir, ".legio", "config.local.yaml"), `agents:\n  maxConcurrent: 4\n`);

		const config = await loadConfig(tempDir);
		// Local override wins
		expect(config.agents.maxConcurrent).toBe(4);
		// Non-overridden value from config.yaml preserved
		expect(config.project.canonicalBranch).toBe("develop");
	});

	test("config.local.yaml works when config.yaml does not exist", async () => {
		await ensureLegioDir();
		// No config.yaml, only config.local.yaml
		await writeFile(join(tempDir, ".legio", "config.local.yaml"), `agents:\n  maxConcurrent: 3\n`);

		const config = await loadConfig(tempDir);
		expect(config.agents.maxConcurrent).toBe(3);
		// Defaults still applied
		expect(config.project.canonicalBranch).toBe("main");
	});

	test("values from config.local.yaml are validated", async () => {
		await ensureLegioDir();
		await writeConfig(`
project:
  canonicalBranch: main
`);
		await writeFile(join(tempDir, ".legio", "config.local.yaml"), `agents:\n  maxConcurrent: -1\n`);

		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("config.local.yaml deep merges nested objects", async () => {
		await ensureLegioDir();
		await writeConfig(`
watchdog:
  tier0Enabled: false
  zombieThresholdMs: 120000
`);
		await writeFile(
			join(tempDir, ".legio", "config.local.yaml"),
			`watchdog:\n  tier0Enabled: true\n`,
		);

		const config = await loadConfig(tempDir);
		// Local override
		expect(config.watchdog.tier0Enabled).toBe(true);
		// Non-overridden value from config.yaml preserved
		expect(config.watchdog.zombieThresholdMs).toBe(120000);
	});

	test("migrates deprecated watchdog tier1/tier2 keys to tier0/tier1", async () => {
		await ensureLegioDir();
		await writeConfig(`
watchdog:
  tier1Enabled: true
  tier1IntervalMs: 45000
  tier2Enabled: true
`);

		const config = await loadConfig(tempDir);
		// Old tier1 (mechanical daemon) → new tier0
		expect(config.watchdog.tier0Enabled).toBe(true);
		expect(config.watchdog.tier0IntervalMs).toBe(45000);
		// Old tier2 (AI triage) → new tier1
		expect(config.watchdog.tier1Enabled).toBe(true);
	});

	test("migrates deprecated 'beads' key to taskTracker", async () => {
		await ensureLegioDir();
		await writeConfig(`
beads:
  enabled: false
`);

		const config = await loadConfig(tempDir);
		expect(config.taskTracker.enabled).toBe(false);
		expect(config.taskTracker.backend).toBe("auto");
	});

	test("new-style tier keys take precedence over deprecated keys", async () => {
		await ensureLegioDir();
		await writeConfig(`
watchdog:
  tier0Enabled: false
  tier0IntervalMs: 20000
  tier1Enabled: true
`);

		const config = await loadConfig(tempDir);
		// New keys used directly — no migration needed
		expect(config.watchdog.tier0Enabled).toBe(false);
		expect(config.watchdog.tier0IntervalMs).toBe(20000);
		expect(config.watchdog.tier1Enabled).toBe(true);
	});
});

describe("validateConfig", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "legio-test-"));
		await mkdir(join(tempDir, ".legio"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeConfig(yaml: string): Promise<void> {
		await writeFile(join(tempDir, ".legio", "config.yaml"), yaml);
	}

	test("rejects negative maxConcurrent", async () => {
		await writeConfig(`
agents:
  maxConcurrent: -1
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects zero maxConcurrent", async () => {
		await writeConfig(`
agents:
  maxConcurrent: 0
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects negative maxDepth", async () => {
		await writeConfig(`
agents:
  maxDepth: -1
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects negative staggerDelayMs", async () => {
		await writeConfig(`
agents:
  staggerDelayMs: -100
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects invalid mulch.primeFormat", async () => {
		await writeConfig(`
mulch:
  primeFormat: yaml
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("rejects non-positive tier0IntervalMs when tier0 is enabled", async () => {
		await writeConfig(`
watchdog:
  tier0Enabled: true
  tier0IntervalMs: 0
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});

	test("accepts empty models section", async () => {
		await writeConfig(`
models:
`);
		const config = await loadConfig(tempDir);
		expect(config.models).toBeDefined();
	});

	test("accepts valid model names in models section", async () => {
		await writeConfig(`
models:
  coordinator: sonnet
  monitor: haiku
  builder: opus
`);
		const config = await loadConfig(tempDir);
		expect(config.models.coordinator).toBe("sonnet");
		expect(config.models.monitor).toBe("haiku");
		expect(config.models.builder).toBe("opus");
	});

	test("rejects invalid model name in models section", async () => {
		await writeConfig(`
models:
  coordinator: gpt4
`);
		await expect(loadConfig(tempDir)).rejects.toThrow(ValidationError);
	});
});

describe("DEFAULT_CONFIG", () => {
	test("has all required top-level keys", () => {
		expect(DEFAULT_CONFIG.project).toBeDefined();
		expect(DEFAULT_CONFIG.agents).toBeDefined();
		expect(DEFAULT_CONFIG.worktrees).toBeDefined();
		expect(DEFAULT_CONFIG.taskTracker).toBeDefined();
		expect(DEFAULT_CONFIG.mulch).toBeDefined();
		expect(DEFAULT_CONFIG.merge).toBeDefined();
		expect(DEFAULT_CONFIG.watchdog).toBeDefined();
		expect(DEFAULT_CONFIG.models).toBeDefined();
		expect(DEFAULT_CONFIG.logging).toBeDefined();
	});

	test("has sensible default values", () => {
		expect(DEFAULT_CONFIG.project.canonicalBranch).toBe("main");
		expect(DEFAULT_CONFIG.agents.maxConcurrent).toBe(25);
		expect(DEFAULT_CONFIG.agents.maxDepth).toBe(2);
		expect(DEFAULT_CONFIG.agents.staggerDelayMs).toBe(2_000);
		expect(DEFAULT_CONFIG.watchdog.tier0IntervalMs).toBe(30_000);
		expect(DEFAULT_CONFIG.watchdog.zombieThresholdMs).toBe(600_000);
	});

	test("agents.maxAgentsPerLead defaults to 5", () => {
		expect(DEFAULT_CONFIG.agents.maxAgentsPerLead).toBe(5);
	});

	test("has qualityGates with npm defaults (no typecheck — language-specific)", () => {
		expect(DEFAULT_CONFIG.qualityGates).toBeDefined();
		expect(DEFAULT_CONFIG.qualityGates?.test).toBe("npm test");
		expect(DEFAULT_CONFIG.qualityGates?.lint).toBe("npm run lint");
		expect(DEFAULT_CONFIG.qualityGates?.typecheck).toBeUndefined();
	});
});

describe("loadConfig qualityGates", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "legio-test-"));
		await mkdir(join(tempDir, ".legio"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function writeConfig(yaml: string): Promise<void> {
		await writeFile(join(tempDir, ".legio", "config.yaml"), yaml);
	}

	test("full custom qualityGates override", async () => {
		await writeConfig(`
qualityGates:
  test: "bun test"
  lint: "bun run lint"
  typecheck: "bun run typecheck"
`);
		const config = await loadConfig(tempDir);
		expect(config.qualityGates?.test).toBe("bun test");
		expect(config.qualityGates?.lint).toBe("bun run lint");
		expect(config.qualityGates?.typecheck).toBe("bun run typecheck");
	});

	test("partial qualityGates override keeps defaults for unspecified fields", async () => {
		await writeConfig(`
qualityGates:
  test: "bun test"
`);
		const config = await loadConfig(tempDir);
		expect(config.qualityGates?.test).toBe("bun test");
		expect(config.qualityGates?.lint).toBe("npm run lint");
		expect(config.qualityGates?.typecheck).toBeUndefined();
	});
});
