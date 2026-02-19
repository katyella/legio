/**
 * Tests for legio hooks install/uninstall/status command.
 *
 * Uses real temp directories and real filesystem (no mocks needed).
 * Each test gets an isolated temp directory with minimal .legio/
 * and .claude/ scaffolding.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { hooksCommand } from "./hooks.ts";

let tempDir: string;
const originalCwd = process.cwd();

/** Orchestrator hooks content for .legio/hooks.json. */
const SAMPLE_HOOKS = {
	hooks: {
		SessionStart: [
			{
				matcher: "",
				hooks: [{ type: "command", command: "legio prime --agent orchestrator" }],
			},
		],
		Stop: [
			{
				matcher: "",
				hooks: [{ type: "command", command: "legio log session-end --agent orchestrator" }],
			},
		],
	},
};

/** Capture stdout.write output during a function call. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write;
	process.stdout.write = ((chunk: string) => {
		chunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

beforeEach(async () => {
	process.chdir(originalCwd);
	tempDir = await realpath(await createTempGitRepo());

	// Create minimal .legio/ with config.yaml
	const legioDir = join(tempDir, ".legio");
	await mkdir(legioDir, { recursive: true });
	await Bun.write(
		join(legioDir, "config.yaml"),
		["project:", "  name: test-project", `  root: ${tempDir}`, "  canonicalBranch: main"].join(
			"\n",
		),
	);

	process.chdir(tempDir);
});

afterEach(async () => {
	process.chdir(originalCwd);
	await cleanupTempDir(tempDir);
});

describe("hooksCommand help", () => {
	test("--help outputs help text", async () => {
		const output = await captureStdout(() => hooksCommand(["--help"]));
		expect(output).toContain("legio hooks");
		expect(output).toContain("install");
		expect(output).toContain("uninstall");
		expect(output).toContain("status");
	});

	test("empty args outputs help text", async () => {
		const output = await captureStdout(() => hooksCommand([]));
		expect(output).toContain("legio hooks");
	});

	test("unknown subcommand throws ValidationError", async () => {
		await expect(hooksCommand(["frobnicate"])).rejects.toThrow(ValidationError);
	});
});

describe("hooks install", () => {
	test("installs hooks from .legio/hooks.json to .claude/settings.local.json", async () => {
		// Write source hooks
		await Bun.write(
			join(tempDir, ".legio", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install"]));

		// Verify target file was created
		const targetPath = join(tempDir, ".claude", "settings.local.json");
		const content = await Bun.file(targetPath).text();
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(parsed.hooks).toBeDefined();
		expect(content).toContain("legio prime");
	});

	test("preserves existing non-hooks keys in settings.local.json", async () => {
		await Bun.write(
			join(tempDir, ".legio", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		// Write existing settings.local.json with non-hooks content
		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ env: { SOME_VAR: "1" } }, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install"]));

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(parsed.hooks).toBeDefined();
		expect(parsed.env).toEqual({ SOME_VAR: "1" });
	});

	test("warns when hooks already exist without --force", async () => {
		await Bun.write(
			join(tempDir, ".legio", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: { old: "hooks" } }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["install"]));
		expect(output).toContain("already present");
		expect(output).toContain("--force");

		// Verify hooks were NOT overwritten
		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		expect(content).toContain("old");
	});

	test("--force overwrites existing hooks", async () => {
		await Bun.write(
			join(tempDir, ".legio", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: { old: "hooks" } }, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install", "--force"]));

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		expect(content).not.toContain("old");
		expect(content).toContain("legio prime");
	});

	test("throws when .legio/hooks.json does not exist", async () => {
		await expect(hooksCommand(["install"])).rejects.toThrow(ValidationError);
	});

	test("writes JSON with trailing newline", async () => {
		await Bun.write(
			join(tempDir, ".legio", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		await captureStdout(() => hooksCommand(["install"]));

		const content = await Bun.file(join(tempDir, ".claude", "settings.local.json")).text();
		expect(content.endsWith("\n")).toBe(true);
	});
});

describe("hooks uninstall", () => {
	test("removes hooks-only settings.local.json file entirely", async () => {
		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: { some: "hooks" } }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["uninstall"]));
		expect(output).toContain("Removed");

		const exists = await Bun.file(join(claudeDir, "settings.local.json")).exists();
		expect(exists).toBe(false);
	});

	test("preserves non-hooks keys when uninstalling", async () => {
		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: { some: "hooks" }, env: { KEY: "val" } }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["uninstall"]));
		expect(output).toContain("preserved other settings");

		const content = await Bun.file(join(claudeDir, "settings.local.json")).text();
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(parsed.hooks).toBeUndefined();
		expect(parsed.env).toEqual({ KEY: "val" });
	});

	test("handles missing settings.local.json gracefully", async () => {
		const output = await captureStdout(() => hooksCommand(["uninstall"]));
		expect(output).toContain("nothing to uninstall");
	});

	test("handles settings.local.json with no hooks key", async () => {
		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ env: { KEY: "val" } }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["uninstall"]));
		expect(output).toContain("No hooks found");
	});
});

describe("hooks status", () => {
	test("reports source missing when .legio/hooks.json does not exist", async () => {
		const output = await captureStdout(() => hooksCommand(["status"]));
		expect(output).toContain("missing");
	});

	test("reports installed:false when no hooks in .claude/", async () => {
		await Bun.write(
			join(tempDir, ".legio", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["status"]));
		expect(output).toContain("present");
		expect(output).toContain("no");
		expect(output).toContain("legio hooks install");
	});

	test("reports installed:true when hooks present in .claude/", async () => {
		await Bun.write(
			join(tempDir, ".legio", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const claudeDir = join(tempDir, ".claude");
		await mkdir(claudeDir, { recursive: true });
		await Bun.write(
			join(claudeDir, "settings.local.json"),
			`${JSON.stringify({ hooks: {} }, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["status"]));
		expect(output).toContain("yes");
	});

	test("--json outputs correct fields", async () => {
		await Bun.write(
			join(tempDir, ".legio", "hooks.json"),
			`${JSON.stringify(SAMPLE_HOOKS, null, "\t")}\n`,
		);

		const output = await captureStdout(() => hooksCommand(["status", "--json"]));
		const parsed = JSON.parse(output) as Record<string, unknown>;
		expect(parsed.sourceExists).toBe(true);
		expect(parsed.installed).toBe(false);
	});
});
