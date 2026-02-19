/**
 * Tests for the `legio spec` command.
 *
 * Uses real filesystem (temp dirs) for all tests. No mocks.
 * Philosophy: "never mock what you can use for real" (mx-252b16).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { specCommand, writeSpec } from "./spec.ts";

let tempDir: string;
let legioDir: string;
let originalCwd: string;
let stdoutOutput: string;
let _stderrOutput: string;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
	tempDir = await createTempGitRepo();
	legioDir = join(tempDir, ".legio");
	await mkdir(legioDir, { recursive: true });

	// Write minimal config.yaml so resolveProjectRoot works
	await writeFile(
		join(legioDir, "config.yaml"),
		`project:\n  name: test-project\n  root: ${tempDir}\n  canonicalBranch: main\n`,
	);

	originalCwd = process.cwd();
	process.chdir(tempDir);

	// Capture stdout/stderr
	stdoutOutput = "";
	_stderrOutput = "";
	originalStdoutWrite = process.stdout.write;
	originalStderrWrite = process.stderr.write;
	process.stdout.write = ((chunk: string) => {
		stdoutOutput += chunk;
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		_stderrOutput += chunk;
		return true;
	}) as typeof process.stderr.write;
});

afterEach(async () => {
	process.chdir(originalCwd);
	process.stdout.write = originalStdoutWrite;
	process.stderr.write = originalStderrWrite;
	await cleanupTempDir(tempDir);
});

// === help ===

describe("help", () => {
	test("--help shows usage", async () => {
		await specCommand(["--help"]);
		expect(stdoutOutput).toContain("legio spec");
		expect(stdoutOutput).toContain("write");
		expect(stdoutOutput).toContain("--body");
		expect(stdoutOutput).toContain("--agent");
	});

	test("-h shows usage", async () => {
		await specCommand(["-h"]);
		expect(stdoutOutput).toContain("legio spec");
	});

	test("no args shows help", async () => {
		await specCommand([]);
		expect(stdoutOutput).toContain("legio spec");
	});
});

// === validation ===

describe("validation", () => {
	test("unknown subcommand throws ValidationError", async () => {
		await expect(specCommand(["unknown"])).rejects.toThrow("Unknown spec subcommand");
	});

	test("write without bead-id throws ValidationError", async () => {
		await expect(specCommand(["write"])).rejects.toThrow("Bead ID is required");
	});

	test("write without body throws ValidationError", async () => {
		await expect(specCommand(["write", "task-abc", "--agent", "scout-1"])).rejects.toThrow(
			"Spec body is required",
		);
	});

	test("write with empty body throws ValidationError", async () => {
		await expect(specCommand(["write", "task-abc", "--body", "  "])).rejects.toThrow(
			"Spec body is required",
		);
	});
});

// === writeSpec (core function) ===

describe("writeSpec", () => {
	test("writes spec file to .legio/specs/<bead-id>.md", async () => {
		const specPath = await writeSpec(tempDir, "task-abc", "# My Spec\n\nDetails here.");

		expect(specPath).toBe(join(tempDir, ".legio", "specs", "task-abc.md"));

		const content = await readFile(specPath, "utf-8");
		expect(content).toBe("# My Spec\n\nDetails here.\n");
	});

	test("creates specs directory if it does not exist", async () => {
		// Verify specs dir does not exist yet (no .gitkeep check needed)
		await writeSpec(tempDir, "task-xyz", "content");

		const specsDir = join(legioDir, "specs");
		const content = await readFile(join(specsDir, "task-xyz.md"), "utf-8");
		expect(content).toBe("content\n");
	});

	test("adds attribution header when agent is provided", async () => {
		const specPath = await writeSpec(tempDir, "task-123", "# Spec body", "scout-1");

		const content = await readFile(specPath, "utf-8");
		expect(content).toContain("<!-- written-by: scout-1 -->");
		expect(content).toContain("# Spec body");
	});

	test("does not add attribution header when agent is omitted", async () => {
		const specPath = await writeSpec(tempDir, "task-456", "# Spec body");

		const content = await readFile(specPath, "utf-8");
		expect(content).not.toContain("written-by");
		expect(content).toBe("# Spec body\n");
	});

	test("ensures trailing newline", async () => {
		const specPath = await writeSpec(tempDir, "task-nl", "no newline at end");

		const content = await readFile(specPath, "utf-8");
		expect(content.endsWith("\n")).toBe(true);
	});

	test("does not double trailing newline", async () => {
		const specPath = await writeSpec(tempDir, "task-nl2", "already has newline\n");

		const content = await readFile(specPath, "utf-8");
		expect(content).toBe("already has newline\n");
		expect(content.endsWith("\n\n")).toBe(false);
	});

	test("overwrites existing spec file", async () => {
		await writeSpec(tempDir, "task-ow", "version 1");
		await writeSpec(tempDir, "task-ow", "version 2");

		const specPath = join(legioDir, "specs", "task-ow.md");
		const content = await readFile(specPath, "utf-8");
		expect(content).toBe("version 2\n");
	});
});

// === specCommand (CLI integration) ===

describe("specCommand write", () => {
	test("writes spec and prints path", async () => {
		await specCommand(["write", "task-cmd", "--body", "# CLI Spec"]);

		// Path may differ due to macOS /var -> /private/var symlink resolution
		expect(stdoutOutput.trim()).toContain(".legio/specs/task-cmd.md");

		const specPath = stdoutOutput.trim();
		const content = await readFile(specPath, "utf-8");
		expect(content).toBe("# CLI Spec\n");
	});

	test("writes spec with agent attribution", async () => {
		await specCommand(["write", "task-attr", "--body", "# Attributed", "--agent", "scout-2"]);

		expect(stdoutOutput.trim()).toContain(".legio/specs/task-attr.md");

		const specPath = stdoutOutput.trim();
		const content = await readFile(specPath, "utf-8");
		expect(content).toContain("<!-- written-by: scout-2 -->");
		expect(content).toContain("# Attributed");
	});

	test("flags can appear in any order", async () => {
		await specCommand(["write", "--agent", "scout-3", "--body", "# Content", "task-order"]);

		expect(stdoutOutput.trim()).toContain(".legio/specs/task-order.md");

		const specPath = stdoutOutput.trim();
		const content = await readFile(specPath, "utf-8");
		expect(content).toContain("<!-- written-by: scout-3 -->");
		expect(content).toContain("# Content");
	});
});
