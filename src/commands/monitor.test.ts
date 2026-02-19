/**
 * Tests for src/commands/monitor.ts
 *
 * Note: We do NOT test start/stop/status subcommands here because they require
 * tmux session management, which is fragile in test environments and interferes
 * with developer tmux sessions. Those operations are covered by E2E testing.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ValidationError } from "../errors.ts";
import { buildMonitorBeacon, monitorCommand } from "./monitor.ts";

describe("buildMonitorBeacon", () => {
	test("contains monitor agent name", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("monitor");
	});

	test("contains tier-2 designation", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("tier-2");
	});

	test("contains ISO timestamp with today's date", () => {
		const beacon = buildMonitorBeacon();
		const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
		if (!today) {
			throw new Error("Failed to extract date from ISO string");
		}
		expect(beacon).toContain(today);
	});

	test("contains startup instruction: mulch prime", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("mulch prime");
	});

	test("contains startup instruction: legio status --json", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("legio status --json");
	});

	test("contains startup instruction: legio mail check --agent monitor", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("legio mail check --agent monitor");
	});

	test("contains startup instruction: patrol loop", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("patrol loop");
	});

	test("contains [LEGIO] prefix", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("[LEGIO]");
	});

	test("contains Depth: 0", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("Depth: 0");
	});

	test("contains Parent: none", () => {
		const beacon = buildMonitorBeacon();
		expect(beacon).toContain("Parent: none");
	});
});

describe("monitorCommand", () => {
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stdoutWrites: string[] = [];

	beforeEach(() => {
		stdoutWrites = [];
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdoutWrites.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	test("--help prints help text containing 'legio monitor'", async () => {
		await monitorCommand(["--help"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("legio monitor");
	});

	test("--help prints help text containing 'start'", async () => {
		await monitorCommand(["--help"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("start");
	});

	test("--help prints help text containing 'stop'", async () => {
		await monitorCommand(["--help"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("stop");
	});

	test("--help prints help text containing 'status'", async () => {
		await monitorCommand(["--help"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("status");
	});

	test("-h prints help text", async () => {
		await monitorCommand(["-h"]);
		const output = stdoutWrites.join("");
		expect(output).toContain("legio monitor");
	});

	test("empty args [] shows help (same as --help)", async () => {
		await monitorCommand([]);
		const output = stdoutWrites.join("");
		expect(output).toContain("legio monitor");
	});

	test("unknown subcommand 'restart' throws ValidationError", async () => {
		await expect(monitorCommand(["restart"])).rejects.toThrow(ValidationError);
	});

	test("unknown subcommand error message contains the bad value 'restart'", async () => {
		try {
			await monitorCommand(["restart"]);
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			if (err instanceof ValidationError) {
				expect(err.message).toContain("restart");
			} else {
				throw err;
			}
		}
	});
});
