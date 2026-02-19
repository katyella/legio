import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { initCommand, LEGIO_GITIGNORE } from "./init.ts";

/**
 * Tests for `legio init` -- agent definition deployment.
 *
 * Uses real temp git repos. Suppresses stdout to keep test output clean.
 * process.cwd() is saved/restored because initCommand uses it to find the project root.
 */

const AGENT_DEF_FILES = [
	"scout.md",
	"builder.md",
	"reviewer.md",
	"lead.md",
	"merger.md",
	"supervisor.md",
	"coordinator.md",
	"monitor.md",
];

/** Resolve the source agents directory (same logic as init.ts). */
const SOURCE_AGENTS_DIR = join(import.meta.dir, "..", "..", "agents");

describe("initCommand: agent-defs deployment", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("creates .legio/agent-defs/ with all 8 agent definition files", async () => {
		await initCommand([]);

		const agentDefsDir = join(tempDir, ".legio", "agent-defs");
		const files = await readdir(agentDefsDir);
		const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

		expect(mdFiles).toEqual(AGENT_DEF_FILES.slice().sort());
	});

	test("copied files match source content", async () => {
		await initCommand([]);

		for (const fileName of AGENT_DEF_FILES) {
			const sourcePath = join(SOURCE_AGENTS_DIR, fileName);
			const targetPath = join(tempDir, ".legio", "agent-defs", fileName);

			const sourceContent = await Bun.file(sourcePath).text();
			const targetContent = await Bun.file(targetPath).text();

			expect(targetContent).toBe(sourceContent);
		}
	});

	test("--force reinit overwrites existing agent def files", async () => {
		// First init
		await initCommand([]);

		// Tamper with one of the deployed files
		const tamperPath = join(tempDir, ".legio", "agent-defs", "scout.md");
		await Bun.write(tamperPath, "# tampered content\n");

		// Verify tamper worked
		const tampered = await Bun.file(tamperPath).text();
		expect(tampered).toBe("# tampered content\n");

		// Reinit with --force
		await initCommand(["--force"]);

		// Verify the file was overwritten with the original source
		const sourceContent = await Bun.file(join(SOURCE_AGENTS_DIR, "scout.md")).text();
		const restored = await Bun.file(tamperPath).text();
		expect(restored).toBe(sourceContent);
	});

	test("Stop hook includes mulch learn command", async () => {
		await initCommand([]);

		const hooksPath = join(tempDir, ".legio", "hooks.json");
		const content = await Bun.file(hooksPath).text();
		const parsed = JSON.parse(content);
		const stopHooks = parsed.hooks.Stop[0].hooks;

		expect(stopHooks.length).toBe(2);
		expect(stopHooks[0].command).toContain("legio log session-end");
		expect(stopHooks[1].command).toBe("mulch learn");
	});
});

describe("initCommand: .legio/.gitignore", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalWrite: typeof process.stdout.write;

	beforeEach(async () => {
		tempDir = await createTempGitRepo();
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Suppress stdout noise from initCommand
		originalWrite = process.stdout.write;
		process.stdout.write = (() => true) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		process.stdout.write = originalWrite;
		await cleanupTempDir(tempDir);
	});

	test("creates .legio/.gitignore with wildcard+whitelist model", async () => {
		await initCommand([]);

		const gitignorePath = join(tempDir, ".legio", ".gitignore");
		const content = await Bun.file(gitignorePath).text();

		// Verify wildcard+whitelist pattern
		expect(content).toContain("*\n");
		expect(content).toContain("!.gitignore\n");
		expect(content).toContain("!config.yaml\n");
		expect(content).toContain("!agent-manifest.json\n");
		expect(content).toContain("!hooks.json\n");
		expect(content).toContain("!groups.json\n");
		expect(content).toContain("!agent-defs/\n");

		// Verify it matches the exported constant
		expect(content).toBe(LEGIO_GITIGNORE);
	});

	test("gitignore is always written when init completes", async () => {
		// Init should write gitignore
		await initCommand([]);

		const gitignorePath = join(tempDir, ".legio", ".gitignore");
		const content = await Bun.file(gitignorePath).text();

		// Verify gitignore was written with correct content
		expect(content).toBe(LEGIO_GITIGNORE);

		// Verify the file exists
		const exists = await Bun.file(gitignorePath).exists();
		expect(exists).toBe(true);
	});

	test("--force reinit overwrites stale .legio/.gitignore", async () => {
		// First init
		await initCommand([]);

		const gitignorePath = join(tempDir, ".legio", ".gitignore");

		// Tamper with the gitignore file (simulate old deny-list format)
		await Bun.write(gitignorePath, "# old format\nworktrees/\nlogs/\nmail.db\n");

		// Verify tamper worked
		const tampered = await Bun.file(gitignorePath).text();
		expect(tampered).not.toContain("*\n");
		expect(tampered).not.toContain("!.gitignore\n");

		// Reinit with --force
		await initCommand(["--force"]);

		// Verify the file was overwritten with the new wildcard+whitelist format
		const restored = await Bun.file(gitignorePath).text();
		expect(restored).toBe(LEGIO_GITIGNORE);
		expect(restored).toContain("*\n");
		expect(restored).toContain("!.gitignore\n");
	});

	test("subsequent init without --force does not overwrite gitignore", async () => {
		// First init
		await initCommand([]);

		const gitignorePath = join(tempDir, ".legio", ".gitignore");

		// Tamper with the gitignore file
		await Bun.write(gitignorePath, "# custom content\n");

		// Verify tamper worked
		const tampered = await Bun.file(gitignorePath).text();
		expect(tampered).toBe("# custom content\n");

		// Second init without --force should return early (not overwrite)
		await initCommand([]);

		// Verify the file was NOT overwritten (early return prevented it)
		const afterSecondInit = await Bun.file(gitignorePath).text();
		expect(afterSecondInit).toBe("# custom content\n");
	});
});
