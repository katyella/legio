/**
 * Tests for the server command.
 *
 * Tests arg parsing and validation only. Actual server startup is
 * tested in src/server/index.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../errors.ts";
import { serverCommand } from "./server.ts";

describe("serverCommand", () => {
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
