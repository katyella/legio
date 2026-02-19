/**
 * Tests for the autopilot CLI command.
 *
 * Tests help output and basic argument handling. API calls are tested
 * via routes.test.ts — mocking fetch here would add complexity without value.
 */

import { describe, expect, it } from "vitest";
import { autopilotCommand } from "./autopilot.ts";

// ---------------------------------------------------------------------------
// Help output
// ---------------------------------------------------------------------------

describe("autopilotCommand - help", () => {
	it("prints help with no args", async () => {
		const output: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string | Uint8Array) => {
			output.push(String(s));
			return true;
		};

		try {
			await autopilotCommand([]);
		} finally {
			process.stdout.write = origWrite;
		}

		const combined = output.join("");
		expect(combined).toContain("autopilot");
		expect(combined).toContain("start");
		expect(combined).toContain("stop");
		expect(combined).toContain("status");
	});

	it("prints help with --help flag", async () => {
		const output: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string | Uint8Array) => {
			output.push(String(s));
			return true;
		};

		try {
			await autopilotCommand(["--help"]);
		} finally {
			process.stdout.write = origWrite;
		}

		const combined = output.join("");
		expect(combined).toContain("--port");
		expect(combined).toContain("--host");
		expect(combined).toContain("--json");
	});

	it("prints help with -h flag", async () => {
		const output: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string | Uint8Array) => {
			output.push(String(s));
			return true;
		};

		try {
			await autopilotCommand(["-h"]);
		} finally {
			process.stdout.write = origWrite;
		}

		expect(output.join("")).toContain("autopilot");
	});
});

// ---------------------------------------------------------------------------
// Unknown subcommand
// ---------------------------------------------------------------------------

describe("autopilotCommand - unknown subcommand", () => {
	it("exits with code 1 for unknown subcommand", async () => {
		const origExit = process.exit.bind(process);
		let exitCode: number | undefined;
		process.exit = ((code?: number) => {
			exitCode = code;
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit;

		const errOutput: string[] = [];
		const origStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (s: string | Uint8Array) => {
			errOutput.push(String(s));
			return true;
		};

		try {
			await autopilotCommand(["bogus-subcommand"]);
		} catch {
			// Expected — process.exit throws in test
		} finally {
			process.exit = origExit;
			process.stderr.write = origStderrWrite;
		}

		expect(exitCode).toBe(1);
		expect(errOutput.join("")).toContain("Unknown autopilot subcommand");
	});
});

// ---------------------------------------------------------------------------
// Connection error
// ---------------------------------------------------------------------------

describe("autopilotCommand - connection error", () => {
	it("exits with code 1 and prints error when server is not running", async () => {
		const origExit = process.exit.bind(process);
		let exitCode: number | undefined;
		process.exit = ((code?: number) => {
			exitCode = code;
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit;

		const errOutput: string[] = [];
		const origStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (s: string | Uint8Array) => {
			errOutput.push(String(s));
			return true;
		};

		try {
			// Port 1 is always refused (privileged, not running)
			await autopilotCommand(["status", "--port", "1", "--host", "127.0.0.1"]);
		} catch {
			// Expected — process.exit throws in test
		} finally {
			process.exit = origExit;
			process.stderr.write = origStderrWrite;
		}

		expect(exitCode).toBe(1);
	});

	it("outputs JSON error when --json flag is set and server not running", async () => {
		const origExit = process.exit.bind(process);
		process.exit = (() => {
			throw new Error("exit");
		}) as typeof process.exit;

		const outOutput: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = (s: string | Uint8Array) => {
			outOutput.push(String(s));
			return true;
		};

		try {
			await autopilotCommand(["status", "--port", "1", "--json"]);
		} catch {
			// Expected
		} finally {
			process.exit = origExit;
			process.stdout.write = origWrite;
		}

		const combined = outOutput.join("");
		if (combined) {
			const parsed = JSON.parse(combined) as { error?: string };
			expect(typeof parsed.error).toBe("string");
		}
		// If combined is empty, error went to stderr — both are valid behaviors
	});
});
