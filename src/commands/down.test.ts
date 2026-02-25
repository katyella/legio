/**
 * Tests for legio down command.
 *
 * Uses DI (DownDeps) to inject mock subprocess calls. No real coordinator/server
 * in tests.
 *
 * WHY DI instead of mock.module: mock.module() in vitest is process-global
 * and leaks across test files. DI keeps mocks scoped to each test invocation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownDeps } from "./down.ts";
import { downCommand } from "./down.ts";

/** Builds a mock runCommand with configurable results per command prefix. */
function makeRunCommand(
	responses: Record<string, { stdout: string; stderr: string; exitCode: number }>,
): NonNullable<DownDeps["_runCommand"]> {
	return async (cmd) => {
		const key = cmd.join(" ");
		for (const [prefix, result] of Object.entries(responses)) {
			if (key.startsWith(prefix)) return result;
		}
		return { stdout: "", stderr: `Unexpected command: ${key}`, exitCode: 1 };
	};
}

/** Coordinator stop success response. */
const COORD_STOP_OK = {
	stdout:
		"Coordinator stopped (session: session-123)\nWatchdog stopped\nNo monitor running\nRun completed\n",
	stderr: "",
	exitCode: 0,
};

/** Coordinator stop failure (not running). */
const COORD_STOP_FAIL = {
	stdout: "",
	stderr: "Error [AGENT_ERROR]: No active coordinator session found",
	exitCode: 1,
};

/** Server stop success response. */
const SERVER_STOP_OK = { stdout: "Server stopped (PID 42000)\n", stderr: "", exitCode: 0 };

/** Server stop response when not running. */
const SERVER_NOT_RUNNING = { stdout: "Server not running\n", stderr: "", exitCode: 0 };

/** Server stop response when stale PID cleaned. */
const SERVER_STALE_PID = {
	stdout: "Server not running (stale PID file cleaned up)\n",
	stderr: "",
	exitCode: 0,
};

describe("downCommand", () => {
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
		await downCommand(["--help"]);
		expect(capturedStdout).toContain("legio down");
		expect(capturedStdout).toContain("--json");
	});

	it("prints help for -h", async () => {
		await downCommand(["-h"]);
		expect(capturedStdout).toContain("legio down");
	});

	it("prints Nothing to stop when coordinator not running and server not running", async () => {
		const deps: DownDeps = {
			_runCommand: makeRunCommand({
				"legio coordinator stop": COORD_STOP_FAIL,
				"legio server stop": SERVER_NOT_RUNNING,
			}),
			_projectRoot: "/tmp/test-project",
		};

		await downCommand([], deps);

		expect(capturedStdout).toContain("Nothing to stop");
	});

	it("prints Nothing to stop when server has stale PID", async () => {
		const deps: DownDeps = {
			_runCommand: makeRunCommand({
				"legio coordinator stop": COORD_STOP_FAIL,
				"legio server stop": SERVER_STALE_PID,
			}),
			_projectRoot: "/tmp/test-project",
		};

		await downCommand([], deps);

		expect(capturedStdout).toContain("Nothing to stop");
	});

	it("stops coordinator when running", async () => {
		const commands: string[][] = [];
		const deps: DownDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "legio" && cmd[1] === "coordinator") return COORD_STOP_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_projectRoot: "/tmp/test-project",
		};

		await downCommand([], deps);

		const ranStop = commands.some(
			(c) => c[0] === "legio" && c[1] === "coordinator" && c[2] === "stop",
		);
		expect(ranStop).toBe(true);
		expect(capturedStdout).toContain("Legio stack stopped");
	});

	it("stops server when running", async () => {
		const commands: string[][] = [];
		const deps: DownDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "legio" && cmd[1] === "coordinator") return COORD_STOP_FAIL;
				if (cmd[0] === "legio" && cmd[1] === "server" && cmd[2] === "stop") return SERVER_STOP_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_projectRoot: "/tmp/test-project",
		};

		await downCommand([], deps);

		const serverStopped = commands.some(
			(c) => c[0] === "legio" && c[1] === "server" && c[2] === "stop",
		);
		expect(serverStopped).toBe(true);
		expect(capturedStdout).toContain("Legio stack stopped");
	});

	it("stops both coordinator and server when both running", async () => {
		const commands: string[][] = [];
		const deps: DownDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "legio" && cmd[1] === "coordinator") return COORD_STOP_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_STOP_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_projectRoot: "/tmp/test-project",
		};

		await downCommand([], deps);

		const coordStopped = commands.some(
			(c) => c[0] === "legio" && c[1] === "coordinator" && c[2] === "stop",
		);
		const serverStopped = commands.some(
			(c) => c[0] === "legio" && c[1] === "server" && c[2] === "stop",
		);
		expect(coordStopped).toBe(true);
		expect(serverStopped).toBe(true);
		expect(capturedStdout).toContain("Legio stack stopped");
	});

	it("always calls legio server stop (delegates PID checking)", async () => {
		const commands: string[][] = [];
		const deps: DownDeps = {
			_runCommand: async (cmd) => {
				commands.push(cmd);
				if (cmd[0] === "legio" && cmd[1] === "coordinator") return COORD_STOP_OK;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_NOT_RUNNING;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_projectRoot: "/tmp/test-project",
		};

		await downCommand([], deps);

		const serverStopCalled = commands.some(
			(c) => c[0] === "legio" && c[1] === "server" && c[2] === "stop",
		);
		expect(serverStopCalled).toBe(true);
	});

	it("outputs JSON with correct fields when --json passed (nothing to stop)", async () => {
		const deps: DownDeps = {
			_runCommand: makeRunCommand({
				"legio coordinator stop": COORD_STOP_FAIL,
				"legio server stop": SERVER_NOT_RUNNING,
			}),
			_projectRoot: "/tmp/test-project",
		};

		await downCommand(["--json"], deps);

		const parsed = JSON.parse(capturedStdout.trim()) as {
			coordinatorStopped: boolean;
			serverStopped: boolean;
			nothingToStop: boolean;
		};
		expect(parsed.coordinatorStopped).toBe(false);
		expect(parsed.serverStopped).toBe(false);
		expect(parsed.nothingToStop).toBe(true);
	});

	it("outputs JSON with coordinatorStopped=true when coordinator stops", async () => {
		const deps: DownDeps = {
			_runCommand: makeRunCommand({
				"legio coordinator stop": COORD_STOP_OK,
				"legio server stop": SERVER_NOT_RUNNING,
			}),
			_projectRoot: "/tmp/test-project",
		};

		await downCommand(["--json"], deps);

		const parsed = JSON.parse(capturedStdout.trim()) as {
			coordinatorStopped: boolean;
			serverStopped: boolean;
			nothingToStop: boolean;
		};
		expect(parsed.coordinatorStopped).toBe(true);
		expect(parsed.serverStopped).toBe(false);
		expect(parsed.nothingToStop).toBe(false);
	});

	it("outputs JSON with serverStopped=true when server stops", async () => {
		const deps: DownDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "legio" && cmd[1] === "coordinator") return COORD_STOP_FAIL;
				if (cmd[0] === "legio" && cmd[1] === "server") return SERVER_STOP_OK;
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_projectRoot: "/tmp/test-project",
		};

		await downCommand(["--json"], deps);

		const parsed = JSON.parse(capturedStdout.trim()) as {
			coordinatorStopped: boolean;
			serverStopped: boolean;
			nothingToStop: boolean;
		};
		expect(parsed.coordinatorStopped).toBe(false);
		expect(parsed.serverStopped).toBe(true);
		expect(parsed.nothingToStop).toBe(false);
	});

	it("is graceful when coordinator stop fails (does not throw)", async () => {
		const deps: DownDeps = {
			_runCommand: makeRunCommand({
				"legio coordinator stop": COORD_STOP_FAIL,
				"legio server stop": SERVER_NOT_RUNNING,
			}),
			_projectRoot: "/tmp/test-project",
		};

		// Should not throw — graceful no-op
		await expect(downCommand([], deps)).resolves.toBeUndefined();
		expect(capturedStdout).toContain("Nothing to stop");
	});

	it("stops coordinator before attempting to stop server", async () => {
		const order: string[] = [];
		const deps: DownDeps = {
			_runCommand: async (cmd) => {
				if (cmd[0] === "legio" && cmd[1] === "coordinator") {
					order.push("coordinator");
					return COORD_STOP_OK;
				}
				if (cmd[0] === "legio" && cmd[1] === "server") {
					order.push("server");
					return SERVER_STOP_OK;
				}
				return { stdout: "", stderr: "unexpected", exitCode: 1 };
			},
			_projectRoot: "/tmp/test-project",
		};

		await downCommand([], deps);

		expect(order[0]).toBe("coordinator");
		expect(order[1]).toBe("server");
	});
});
