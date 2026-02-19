/**
 * Tests for legio up command.
 *
 * Uses DI (UpDeps) to inject mock subprocess calls, filesystem checks,
 * and PID reads. No real init/server/coordinator in tests.
 *
 * WHY DI instead of mock.module: mock.module() in bun:test is process-global
 * and leaks across test files. DI keeps mocks scoped to each test invocation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerError, ValidationError } from "../errors.ts";
import type { UpDeps } from "./up.ts";
import { upCommand } from "./up.ts";

/** Builds a mock runCommand with configurable results per command prefix. */
function makeRunCommand(
	responses: Record<string, { stdout: string; stderr: string; exitCode: number }>,
): NonNullable<UpDeps["_runCommand"]> {
	return async (cmd) => {
		const key = cmd.join(" ");
		// Find matching prefix
		for (const [prefix, result] of Object.entries(responses)) {
			if (key.startsWith(prefix)) return result;
		}
		return { stdout: "", stderr: `Unexpected command: ${key}`, exitCode: 1 };
	};
}

/** Standard successful subprocess responses. */
const GIT_OK = { stdout: "true\n", stderr: "", exitCode: 0 };
const INIT_OK = { stdout: "Initialized .legio/\n", stderr: "", exitCode: 0 };
const SERVER_START_OK = { stdout: "Server started\n", stderr: "", exitCode: 0 };

describe("upCommand", () => {
	let capturedStdout: string;
	let _capturedStderr: string;
	let originalStdout: typeof process.stdout.write;
	let originalStderr: typeof process.stderr.write;

	beforeEach(() => {
		capturedStdout = "";
		_capturedStderr = "";
		originalStdout = process.stdout.write;
		originalStderr = process.stderr.write;
		process.stdout.write = vi.fn((chunk: unknown) => {
			capturedStdout += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = vi.fn((chunk: unknown) => {
			_capturedStderr += String(chunk);
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(() => {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
	});

	it("prints help for --help", async () => {
		await upCommand(["--help"]);
		expect(capturedStdout).toContain("legio up");
		expect(capturedStdout).toContain("--port");
		expect(capturedStdout).toContain("--no-open");
	});

	it("prints help for -h", async () => {
		await upCommand(["-h"]);
		expect(capturedStdout).toContain("legio up");
	});

	it("throws ValidationError when not in a git repo", async () => {
		const deps: UpDeps = {
			_runCommand: makeRunCommand({
				"git rev-parse": { stdout: "", stderr: "not a git repo", exitCode: 128 },
			}),
			_fileExists: async () => false,
			_projectRoot: "/tmp/not-a-repo",
		};
		await expect(upCommand([], deps)).rejects.toThrow(ValidationError);
	});

	it("throws ValidationError for invalid port", async () => {
		await expect(upCommand(["--port", "99999"])).rejects.toThrow(ValidationError);
		await expect(upCommand(["--port", "abc"])).rejects.toThrow(ValidationError);
		await expect(upCommand(["--port", "0"])).rejects.toThrow(ValidationError);
	});

	it("runs init when .legio/ not initialized", async () => {
		const commands: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "init") return INIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async () => false, // config.yaml not found, no server.pid
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand([], deps);

		const ranInit = commands.some((c) => c[0] === "legio" && c[1] === "init");
		expect(ranInit).toBe(true);
		// Should NOT have --force
		const initCmd = commands.find((c) => c[0] === "legio" && c[1] === "init");
		expect(initCmd).not.toContain("--force");
	});

	it("skips init when already initialized", async () => {
		const commands: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"), // config exists, no server.pid
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand([], deps);

		const ranInit = commands.some((c) => c[0] === "legio" && c[1] === "init");
		expect(ranInit).toBe(false);
	});

	it("runs init --force when --force flag and already initialized", async () => {
		const commands: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "init") return INIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"), // initialized, no server.pid
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand(["--force"], deps);

		const initCmd = commands.find((c) => c[0] === "legio" && c[1] === "init");
		expect(initCmd).toContain("--force");
	});

	it("skips server start when server already running", async () => {
		const commands: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "git") return GIT_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async () => true, // config.yaml exists AND server.pid exists
			_readPid: async () => 12345,
			_isProcessRunning: () => true, // server is alive
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand([], deps);

		const serverStarted = commands.some(
			(c) => c[0] === "legio" && c[1] === "server" && c[2] === "start",
		);
		expect(serverStarted).toBe(false);
		expect(capturedStdout).toContain("already running");
		expect(capturedStdout).toContain("12345");
	});

	it("starts server when not running (dead PID)", async () => {
		const commands: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml") || p.endsWith("server.pid"),
			_readPid: async () => 12345,
			_isProcessRunning: () => false, // PID exists but process is dead
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand([], deps);

		const serverStarted = commands.some(
			(c) => c[0] === "legio" && c[1] === "server" && c[2] === "start",
		);
		expect(serverStarted).toBe(true);
	});

	it("starts server when no PID file", async () => {
		const commands: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"), // no server.pid
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand([], deps);

		const serverCmd = commands.find(
			(c) => c[0] === "legio" && c[1] === "server" && c[2] === "start",
		);
		expect(serverCmd).toBeDefined();
		// Verify default port and host
		expect(serverCmd).toContain("4173");
		expect(serverCmd).toContain("127.0.0.1");
	});

	it("passes custom port and host to server start", async () => {
		const commands: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand(["--port", "8080", "--host", "0.0.0.0"], deps);

		const serverCmd = commands.find(
			(c) => c[0] === "legio" && c[1] === "server" && c[2] === "start",
		);
		expect(serverCmd).toContain("8080");
		expect(serverCmd).toContain("0.0.0.0");
		expect(serverCmd).toContain("--daemon");
	});

	it("does not open browser when --no-open is set", async () => {
		let browserOpened = false;
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {
				browserOpened = true;
			},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand(["--no-open"], deps);
		expect(browserOpened).toBe(false);
	});

	it("opens browser when server starts (default)", async () => {
		let openedUrl = "";
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: (url) => {
				openedUrl = url;
			},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand([], deps);
		expect(openedUrl).toBe("http://127.0.0.1:4173");
	});

	it("throws ServerError when server start fails", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") {
					return { stdout: "", stderr: "port already in use", exitCode: 1 };
				}
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await expect(upCommand([], deps)).rejects.toThrow(ServerError);
	});

	it("throws ValidationError when init fails", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "init") {
					return { stdout: "", stderr: "init failed", exitCode: 1 };
				}
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async () => false, // not initialized
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await expect(upCommand([], deps)).rejects.toThrow(ValidationError);
	});

	it("outputs JSON when --json is passed", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand(["--json"], deps);

		const parsed = JSON.parse(capturedStdout.trim()) as {
			url: string;
			initRan: boolean;
			serverStarted: boolean;
			serverAlreadyRunning: boolean;
		};
		expect(parsed.url).toBe("http://127.0.0.1:4173");
		expect(parsed.serverStarted).toBe(true);
		expect(parsed.initRan).toBe(false);
		expect(parsed.serverAlreadyRunning).toBe(false);
	});

	it("JSON output shows serverAlreadyRunning when server is up", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async () => true,
			_readPid: async () => 99,
			_isProcessRunning: () => true,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand(["--json"], deps);

		const parsed = JSON.parse(capturedStdout.trim()) as {
			serverAlreadyRunning: boolean;
			serverStarted: boolean;
		};
		expect(parsed.serverAlreadyRunning).toBe(true);
		expect(parsed.serverStarted).toBe(false);
	});

	it("prints URL summary when server starts", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
		};

		await upCommand(["--port", "5000"], deps);
		expect(capturedStdout).toContain("http://127.0.0.1:5000");
	});
});
