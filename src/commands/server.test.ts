/**
 * Tests for the server command.
 *
 * Tests arg parsing, PID file management, stop, and status subcommands.
 * No real daemon spawning or HTTP server startup occurs in these tests.
 * Uses temp git repos + DI (ServerDeps) to avoid tmux/spawn side effects.
 *
 * Actual server startup is tested in src/server/index.test.ts.
 */

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../errors.ts";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import {
	readServerPid,
	removeServerPid,
	type ServerDeps,
	serverCommand,
	writeServerPid,
} from "./server.ts";

// --- Test Setup ---

let tempDir: string;
let legioDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
	process.chdir(originalCwd);

	tempDir = await realpath(await createTempGitRepo());
	legioDir = join(tempDir, ".legio");
	await mkdir(legioDir, { recursive: true });

	// Minimal config.yaml for loadConfig
	await writeFile(
		join(legioDir, "config.yaml"),
		["project:", "  name: test-server", `  root: ${tempDir}`, "  canonicalBranch: main"].join("\n"),
	);

	process.chdir(tempDir);
});

afterEach(async () => {
	process.chdir(originalCwd);
	await cleanupTempDir(tempDir);
});

// --- Help / Usage ---

describe("serverCommand — help", () => {
	it("should print help when --help is passed", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await serverCommand(["--help"]);
			expect(output).toContain("server");
			expect(output).toContain("start");
			expect(output).toContain("stop");
			expect(output).toContain("status");
			expect(output).toContain("--daemon");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	it("should print help when -h is passed", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await serverCommand(["-h"]);
			expect(output).toContain("server");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	it("should print help when no args are passed", async () => {
		const originalWrite = process.stdout.write;
		let output = "";
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await serverCommand([]);
			expect(output).toContain("server");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	it("should exit with error for unknown subcommand", async () => {
		const originalExit = process.exit;
		const originalStderr = process.stderr.write;
		let exitCode: number | undefined;
		let stderrOutput = "";

		process.exit = vi.fn((code?: string | number | null | undefined) => {
			exitCode = typeof code === "number" ? code : 1;
			throw new Error("process.exit called");
		}) as never;

		process.stderr.write = vi.fn((chunk: unknown) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write;

		try {
			await expect(serverCommand(["bogus"])).rejects.toThrow("process.exit called");
			expect(exitCode).toBe(1);
			expect(stderrOutput).toContain("bogus");
		} finally {
			process.exit = originalExit;
			process.stderr.write = originalStderr;
		}
	});
});

// --- Port Validation ---

describe("serverCommand start — port validation", () => {
	it("should throw ValidationError for non-numeric port", async () => {
		await expect(serverCommand(["start", "--port", "abc"])).rejects.toBeInstanceOf(ValidationError);
	});

	it("should throw ValidationError for port 0", async () => {
		await expect(serverCommand(["start", "--port", "0"])).rejects.toBeInstanceOf(ValidationError);
	});

	it("should throw ValidationError for port > 65535", async () => {
		await expect(serverCommand(["start", "--port", "99999"])).rejects.toBeInstanceOf(
			ValidationError,
		);
	});

	it("should throw ValidationError for negative port", async () => {
		await expect(serverCommand(["start", "--port", "-1"])).rejects.toBeInstanceOf(ValidationError);
	});
});

// --- PID File Helpers ---

describe("PID file helpers", () => {
	it("readServerPid returns null when no file exists", async () => {
		const pid = await readServerPid(tempDir);
		expect(pid).toBeNull();
	});

	it("writeServerPid and readServerPid round-trip", async () => {
		await writeServerPid(tempDir, 12345);
		const pid = await readServerPid(tempDir);
		expect(pid).toBe(12345);
	});

	it("removeServerPid removes the file", async () => {
		await writeServerPid(tempDir, 12345);
		await removeServerPid(tempDir);
		const pid = await readServerPid(tempDir);
		expect(pid).toBeNull();
	});

	it("removeServerPid is idempotent (no error if file missing)", async () => {
		await expect(removeServerPid(tempDir)).resolves.toBeUndefined();
	});
});

// --- Daemon Flag ---

describe("serverCommand start --daemon", () => {
	it("prints already running message when process is alive", async () => {
		// Write a PID file with a fake alive PID (use current process PID)
		await writeServerPid(tempDir, process.pid);

		const deps: ServerDeps = {
			_isProcessRunning: () => true,
		};

		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["start", "--daemon"], deps);
			expect(output).toContain("already running");
			expect(output).toContain(String(process.pid));
		} finally {
			process.stdout.write = originalWrite;
		}

		// PID file should still exist (we didn't stop it)
		const pid = await readServerPid(tempDir);
		expect(pid).toBe(process.pid);
	});

	it("spawns daemon and writes PID file when not running", async () => {
		const fakePid = 55555;
		let spawnCalled = false;
		let spawnArgs: string[] | undefined;
		let spawnEnv: NodeJS.ProcessEnv | undefined;

		let spawnCmd: string | undefined;
		const deps: ServerDeps = {
			_isProcessRunning: (pid) => pid === fakePid,
			_spawn: (cmd, args, opts) => {
				spawnCalled = true;
				spawnCmd = cmd;
				spawnArgs = args;
				spawnEnv = opts.env as NodeJS.ProcessEnv;
				return { pid: fakePid, unref: () => {} };
			},
			_sleep: async () => {},
		};

		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["start", "--daemon", "--port", "4200"], deps);
		} finally {
			process.stdout.write = originalWrite;
		}

		expect(spawnCalled).toBe(true);
		expect(spawnCmd).toBe("legio");
		expect(spawnArgs).toContain("server");
		expect(spawnArgs).toContain("start");
		expect(spawnArgs).toContain("--port");
		expect(spawnArgs).toContain("4200");
		// Should NOT include --daemon (prevents recursion)
		expect(spawnArgs).not.toContain("--daemon");
		// Should set LEGIO_SERVER_DAEMON env var
		expect(spawnEnv?.LEGIO_SERVER_DAEMON).toBe("1");

		// PID file should be written with the child's PID
		const pid = await readServerPid(tempDir);
		expect(pid).toBe(fakePid);

		// Output should mention the PID and URL
		expect(output).toContain(String(fakePid));
		expect(output).toContain("http://");
	});

	it("cleans up stale PID file when process is dead before spawning", async () => {
		// Write a stale PID file
		await writeServerPid(tempDir, 99991);

		const fakePid = 55556;
		const deps: ServerDeps = {
			_isProcessRunning: (pid) => pid === fakePid,
			_spawn: () => ({ pid: fakePid, unref: () => {} }),
			_sleep: async () => {},
		};

		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn(() => true) as typeof process.stdout.write;

		try {
			await serverCommand(["start", "--daemon"], deps);
		} finally {
			process.stdout.write = originalWrite;
		}

		// PID file should now have the new daemon's PID
		const pid = await readServerPid(tempDir);
		expect(pid).toBe(fakePid);
	});

	it("reports failure and cleans up PID when daemon exits immediately (port conflict)", async () => {
		const fakePid = 55558;
		const deps: ServerDeps = {
			_isProcessRunning: () => false,
			_spawn: () => ({ pid: fakePid, unref: () => {} }),
			_sleep: async () => {},
		};

		const originalExit = process.exit;
		let exitCode: number | undefined;
		process.exit = vi.fn((code?: string | number | null | undefined) => {
			exitCode = typeof code === "number" ? code : 1;
			throw new Error("process.exit called");
		}) as never;

		let stderrOutput = "";
		const originalStderr = process.stderr.write;
		process.stderr.write = vi.fn((chunk: unknown) => {
			stderrOutput += String(chunk);
			return true;
		}) as typeof process.stderr.write;

		const originalStdout = process.stdout.write;
		process.stdout.write = vi.fn(() => true) as typeof process.stdout.write;

		try {
			await expect(serverCommand(["start", "--daemon"], deps)).rejects.toThrow(
				"process.exit called",
			);
			expect(exitCode).toBe(1);
			expect(stderrOutput).toContain("exited immediately");
		} finally {
			process.exit = originalExit;
			process.stderr.write = originalStderr;
			process.stdout.write = originalStdout;
		}

		const pid = await readServerPid(tempDir);
		expect(pid).toBeNull();
	});
});

// --- Stop Subcommand ---

describe("serverCommand stop", () => {
	it("prints 'Server not running' when no PID file exists", async () => {
		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["stop"]);
		} finally {
			process.stdout.write = originalWrite;
		}

		expect(output).toContain("Server not running");
	});

	it("cleans up stale PID file when process is dead", async () => {
		await writeServerPid(tempDir, 99992);

		const deps: ServerDeps = {
			_isProcessRunning: () => false,
		};

		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["stop"], deps);
		} finally {
			process.stdout.write = originalWrite;
		}

		expect(output).toContain("not running");
		// PID file should be removed
		const pid = await readServerPid(tempDir);
		expect(pid).toBeNull();
	});

	it("sends SIGTERM and removes PID file when process is running", async () => {
		const fakePid = 99993;
		await writeServerPid(tempDir, fakePid);

		const killCalls: Array<{ pid: number; signal: string }> = [];
		const originalKill = process.kill;
		process.kill = vi.fn((pid: number, signal?: string | number) => {
			killCalls.push({ pid, signal: String(signal ?? "SIGTERM") });
			return true;
		}) as typeof process.kill;

		const deps: ServerDeps = {
			_isProcessRunning: (pid) => pid === fakePid,
		};

		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["stop"], deps);
		} finally {
			process.stdout.write = originalWrite;
			process.kill = originalKill;
		}

		expect(killCalls.length).toBeGreaterThan(0);
		expect(killCalls[0]?.signal).toBe("SIGTERM");
		expect(output).toContain("stopped");
		expect(output).toContain(String(fakePid));

		// PID file removed
		const pid = await readServerPid(tempDir);
		expect(pid).toBeNull();
	});
});

// --- Status Subcommand ---

describe("serverCommand status", () => {
	it("prints 'Server not running' when no PID file", async () => {
		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["status"]);
		} finally {
			process.stdout.write = originalWrite;
		}

		expect(output).toContain("not running");
	});

	it("reports running with PID when process is alive", async () => {
		const fakePid = 99994;
		await writeServerPid(tempDir, fakePid);

		const deps: ServerDeps = {
			_isProcessRunning: (pid) => pid === fakePid,
		};

		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["status"], deps);
		} finally {
			process.stdout.write = originalWrite;
		}

		expect(output).toContain("running");
		expect(output).toContain(String(fakePid));
	});

	it("cleans up stale PID and reports not running", async () => {
		await writeServerPid(tempDir, 99995);

		const deps: ServerDeps = {
			_isProcessRunning: () => false,
		};

		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["status"], deps);
		} finally {
			process.stdout.write = originalWrite;
		}

		expect(output).toContain("not running");
		// PID file cleaned up
		const pid = await readServerPid(tempDir);
		expect(pid).toBeNull();
	});

	it("--json flag outputs JSON when not running", async () => {
		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["status", "--json"]);
		} finally {
			process.stdout.write = originalWrite;
		}

		const parsed = JSON.parse(output.trim());
		expect(parsed.running).toBe(false);
	});

	it("--json flag outputs JSON with PID when running", async () => {
		const fakePid = 99996;
		await writeServerPid(tempDir, fakePid);

		const deps: ServerDeps = {
			_isProcessRunning: (pid) => pid === fakePid,
		};

		let output = "";
		const originalWrite = process.stdout.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;

		try {
			await serverCommand(["status", "--json"], deps);
		} finally {
			process.stdout.write = originalWrite;
		}

		const parsed = JSON.parse(output.trim());
		expect(parsed.running).toBe(true);
		expect(parsed.pid).toBe(fakePid);
		expect(typeof parsed.port).toBe("number");
	});
});
