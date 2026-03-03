/**
 * Tests for legio up command.
 *
 * Uses DI (UpDeps) to inject mock subprocess calls, filesystem checks,
 * and PID reads. No real init/server/coordinator in tests.
 *
 * WHY DI instead of mock.module: mock.module() in vitest is process-global
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
const GATEWAY_STATUS_NOT_RUNNING = {
	stdout: JSON.stringify({ running: false }),
	stderr: "",
	exitCode: 0,
};

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
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async () => false, // config.yaml not found, no server.pid
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"), // config exists, no server.pid
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"), // initialized, no server.pid
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async () => true, // config.yaml exists AND server.pid exists
			_readPid: async () => 12345,
			_isProcessRunning: () => true, // server is alive
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml") || p.endsWith("server.pid"),
			_readPid: async () => 12345,
			_isProcessRunning: () => false, // PID exists but process is dead
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"), // no server.pid
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {
				browserOpened = true;
			},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: (url) => {
				openedUrl = url;
			},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
			_spawnDetached: () => {},
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
			_spawnDetached: () => {},
		};

		await expect(upCommand([], deps)).rejects.toThrow(ValidationError);
	});

	it("outputs JSON when --json is passed", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
		};

		await upCommand(["--json"], deps);

		const parsed = JSON.parse(capturedStdout.trim()) as {
			url: string;
			initRan: boolean;
			serverStarted: boolean;
			serverAlreadyRunning: boolean;
			gatewayStarted: boolean;
			gatewayAlreadyRunning: boolean;
		};
		expect(parsed.url).toBe("http://127.0.0.1:4173");
		expect(parsed.serverStarted).toBe(true);
		expect(parsed.initRan).toBe(false);
		expect(parsed.serverAlreadyRunning).toBe(false);
		expect(parsed.gatewayStarted).toBe(true);
		expect(parsed.gatewayAlreadyRunning).toBe(false);
	});

	it("JSON output shows serverAlreadyRunning when server is up", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async () => true,
			_readPid: async () => 99,
			_isProcessRunning: () => true,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
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
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
		};

		await upCommand(["--port", "5000"], deps);
		expect(capturedStdout).toContain("http://127.0.0.1:5000");
	});

	it("starts gateway via detached spawn when not already running", async () => {
		const detachedCalls: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: (cmd) => {
				detachedCalls.push(cmd);
			},
		};

		await upCommand(["--json"], deps);

		const gatewayStartCmd = detachedCalls.find(
			(c) => c[0] === "legio" && c[1] === "gateway" && c[2] === "start",
		);
		expect(gatewayStartCmd).toBeDefined();
		expect(gatewayStartCmd).toContain("--no-attach");

		const parsed = JSON.parse(capturedStdout.trim()) as {
			gatewayStarted: boolean;
			gatewayAlreadyRunning: boolean;
		};
		expect(parsed.gatewayStarted).toBe(true);
		expect(parsed.gatewayAlreadyRunning).toBe(false);
	});

	it("skips gateway start when already running", async () => {
		const detachedCalls: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status") {
					return { stdout: JSON.stringify({ running: true }), stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: (cmd) => {
				detachedCalls.push(cmd);
			},
		};

		await upCommand(["--json"], deps);

		// No detached spawn should have been called for gateway
		const gatewaySpawned = detachedCalls.some(
			(c) => c[0] === "legio" && c[1] === "gateway" && c[2] === "start",
		);
		expect(gatewaySpawned).toBe(false);

		const parsed = JSON.parse(capturedStdout.trim()) as {
			gatewayStarted: boolean;
			gatewayAlreadyRunning: boolean;
		};
		expect(parsed.gatewayStarted).toBe(false);
		expect(parsed.gatewayAlreadyRunning).toBe(true);
	});

	it("gateway spawn failure is non-fatal", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {
				throw new Error("spawn failed");
			},
		};

		// Gateway failure must NOT propagate — command completes successfully
		await expect(upCommand(["--json"], deps)).resolves.toBeUndefined();

		const parsed = JSON.parse(capturedStdout.trim()) as {
			gatewayStarted: boolean;
			gatewayAlreadyRunning: boolean;
		};
		// Gateway did not start successfully
		expect(parsed.gatewayStarted).toBe(false);
		expect(parsed.gatewayAlreadyRunning).toBe(false);
	});

	it("continues when gateway status check fails", async () => {
		const detachedCalls: string[][] = [];
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status") {
					return { stdout: "", stderr: "status failed", exitCode: 1 };
				}
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: (cmd) => {
				detachedCalls.push(cmd);
			},
		};

		await expect(upCommand([], deps)).resolves.toBeUndefined();

		// Gateway should still be spawned even if status check failed
		const gatewaySpawned = detachedCalls.some(
			(c) => c[0] === "legio" && c[1] === "gateway" && c[2] === "start",
		);
		expect(gatewaySpawned).toBe(true);
	});

	it("shows spinner succeed messages for each step", async () => {
		const deps: UpDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "git") return GIT_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_START_OK;
				if (cmd[0] === "legio" && cmd[1] === "gateway" && cmd[2] === "status")
					return GATEWAY_STATUS_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_fileExists: async (p) => p.endsWith("config.yaml"),
			_readPid: async () => null,
			_isProcessRunning: () => false,
			_openBrowser: () => {},
			_projectRoot: "/tmp/test-project",
			_spawnDetached: () => {},
		};

		await upCommand([], deps);

		expect(capturedStdout).toContain("Git repository");
		expect(capturedStdout).toContain("Already initialized");
		expect(capturedStdout).toContain("Server started");
		expect(capturedStdout).toContain("Gateway launched");
		expect(capturedStdout).toContain("Legio is up");
	});
});
