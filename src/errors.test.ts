import { describe, expect, test } from "vitest";
import { isRunningAsRoot } from "./errors.ts";

describe("isRunningAsRoot", () => {
	test("returns false in normal test environment (not root)", () => {
		// This test runs as a regular user during development and CI.
		// process.getuid() should return a non-zero UID.
		if (typeof process.getuid === "function") {
			expect(process.getuid()).not.toBe(0);
		}
		expect(isRunningAsRoot()).toBe(false);
	});

	test("returns false when process.getuid is not available (Windows)", () => {
		// Simulate a platform without process.getuid by overriding it to undefined
		const original = process.getuid;
		(process as unknown as Record<string, unknown>).getuid = undefined;
		expect(isRunningAsRoot()).toBe(false);
		process.getuid = original;
	});
});
