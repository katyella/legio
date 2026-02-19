/**
 * Unit tests for beads molecules module.
 *
 * WHY MOCKING IS USED HERE:
 * The molecules.ts module expects a bd mol API that doesn't exist yet in beads.
 * Expected API: bd mol create --name, bd mol step add, bd mol list, bd mol status
 * Actual API: bd formula, bd cook, bd mol pour, bd mol wisp
 *
 * These tests mock Bun.spawn to verify the module's logic is correct.
 * When the bd API is implemented to match the module's expectations,
 * these can be converted to integration tests using the real bd CLI.
 *
 * See mulch record mx-56558b for why mocking is normally avoided.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentError } from "../errors.ts";
import {
	createMoleculePrototype,
	getConvoyStatus,
	listPrototypes,
	pourMolecule,
} from "./molecules.ts";

/**
 * Mock Bun.spawn to simulate bd mol CLI responses.
 * Returns a mock process with configurable stdout/stderr/exitCode.
 */
function mockSpawn(
	stdout: string,
	stderr = "",
	exitCode = 0,
): {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
} {
	const stdoutBody = new Response(stdout).body;
	const stderrBody = new Response(stderr).body;
	if (!stdoutBody || !stderrBody) {
		throw new Error("Response body is null");
	}
	return {
		stdout: stdoutBody,
		stderr: stderrBody,
		exited: Promise.resolve(exitCode),
	};
}

let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
	// Save original spawn
	originalSpawn = Bun.spawn;
});

describe("molecules", () => {
	beforeEach(() => {
		// Restore original spawn before each test
		Bun.spawn = originalSpawn;
	});

	afterEach(() => {
		// Ensure cleanup after each test to prevent mock leaks
		Bun.spawn = originalSpawn;
	});

	describe("createMoleculePrototype", () => {
		test("creates a prototype with ordered steps", async () => {
			let callCount = 0;
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock((cmd: string[], _opts?: unknown) => {
				callCount++;
				// First call: bd mol create
				if (callCount === 1) {
					expect(cmd).toEqual(["bd", "mol", "create", "--name", "Test Workflow", "--json"]);
					return mockSpawn(JSON.stringify({ id: "mol-123" }));
				}
				// Subsequent calls: bd mol step add
				expect(cmd[0]).toBe("bd");
				expect(cmd[1]).toBe("mol");
				expect(cmd[2]).toBe("step");
				expect(cmd[3]).toBe("add");
				expect(cmd[4]).toBe("mol-123");
				return mockSpawn(JSON.stringify({ success: true }));
			});

			const molId = await createMoleculePrototype("/test/dir", {
				name: "Test Workflow",
				steps: [
					{ title: "Step 1: Setup", type: "task" },
					{ title: "Step 2: Implementation", type: "task" },
					{ title: "Step 3: Testing", type: "task" },
				],
			});

			expect(molId).toBe("mol-123");
			expect(callCount).toBe(4); // 1 create + 3 step adds
		});

		test("creates a prototype with default type (task)", async () => {
			let callCount = 0;
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock((cmd: string[], _opts?: unknown) => {
				callCount++;
				if (callCount === 1) {
					return mockSpawn(JSON.stringify({ id: "mol-456" }));
				}
				// Check that default type is "task"
				expect(cmd).toContain("--type");
				const typeIndex = cmd.indexOf("--type");
				expect(cmd[typeIndex + 1]).toBe("task");
				return mockSpawn(JSON.stringify({ success: true }));
			});

			const molId = await createMoleculePrototype("/test/dir", {
				name: "Default Type Workflow",
				steps: [{ title: "Step without explicit type" }],
			});

			expect(molId).toBe("mol-456");
			expect(callCount).toBe(2); // 1 create + 1 step add
		});

		test("creates a prototype with empty steps array", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn(JSON.stringify({ id: "mol-empty" }));
			});

			const molId = await createMoleculePrototype("/test/dir", {
				name: "Empty Workflow",
				steps: [],
			});

			expect(molId).toBe("mol-empty");
		});

		test("throws AgentError on create failure", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn("", "bd mol create failed: invalid name", 1);
			});

			await expect(
				createMoleculePrototype("/test/dir", {
					name: "Bad",
					steps: [],
				}),
			).rejects.toThrow(AgentError);
		});

		test("throws AgentError on step add failure", async () => {
			let callCount = 0;
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				callCount++;
				if (callCount === 1) {
					return mockSpawn(JSON.stringify({ id: "mol-789" }));
				}
				// Step add fails
				return mockSpawn("", "step add failed", 1);
			});

			await expect(
				createMoleculePrototype("/test/dir", {
					name: "Test",
					steps: [{ title: "Step 1" }],
				}),
			).rejects.toThrow(AgentError);
		});
	});

	describe("listPrototypes", () => {
		test("returns all created prototypes", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn(
					JSON.stringify([
						{ id: "mol-1", name: "List Test 1", stepCount: 1 },
						{ id: "mol-2", name: "List Test 2", stepCount: 2 },
					]),
				);
			});

			const prototypes = await listPrototypes("/test/dir");

			expect(prototypes).toHaveLength(2);
			expect(prototypes[0]).toEqual({ id: "mol-1", name: "List Test 1", stepCount: 1 });
			expect(prototypes[1]).toEqual({ id: "mol-2", name: "List Test 2", stepCount: 2 });
		});

		test("returns empty array when no prototypes exist", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn(JSON.stringify([]));
			});

			const prototypes = await listPrototypes("/test/dir");

			expect(Array.isArray(prototypes)).toBe(true);
			expect(prototypes).toHaveLength(0);
		});

		test("throws AgentError on failure", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn("", "bd mol list failed", 1);
			});

			await expect(listPrototypes("/test/dir")).rejects.toThrow(AgentError);
		});

		test("throws AgentError on empty output", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn("");
			});

			await expect(listPrototypes("/test/dir")).rejects.toThrow(AgentError);
		});
	});

	describe("pourMolecule", () => {
		test("pours a prototype into actual issues", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock((cmd: string[]) => {
				expect(cmd).toEqual(["bd", "mol", "pour", "mol-123", "--json"]);
				return mockSpawn(JSON.stringify({ ids: ["issue-1", "issue-2", "issue-3"] }));
			});

			const issueIds = await pourMolecule("/test/dir", {
				prototypeId: "mol-123",
			});

			expect(Array.isArray(issueIds)).toBe(true);
			expect(issueIds).toHaveLength(3);
			expect(issueIds).toEqual(["issue-1", "issue-2", "issue-3"]);
		});

		test("applies prefix when provided", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock((cmd: string[]) => {
				expect(cmd).toEqual(["bd", "mol", "pour", "mol-456", "--json", "--prefix", "v2.0"]);
				return mockSpawn(JSON.stringify({ ids: ["issue-4", "issue-5"] }));
			});

			const issueIds = await pourMolecule("/test/dir", {
				prototypeId: "mol-456",
				prefix: "v2.0",
			});

			expect(issueIds).toEqual(["issue-4", "issue-5"]);
		});

		test("handles empty prototype (0 steps)", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn(JSON.stringify({ ids: [] }));
			});

			const issueIds = await pourMolecule("/test/dir", {
				prototypeId: "mol-empty",
			});

			expect(Array.isArray(issueIds)).toBe(true);
			expect(issueIds).toHaveLength(0);
		});

		test("throws AgentError for nonexistent prototype", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn("", "prototype not found", 1);
			});

			await expect(
				pourMolecule("/test/dir", {
					prototypeId: "nonexistent-mol-id",
				}),
			).rejects.toThrow(AgentError);
		});
	});

	describe("getConvoyStatus", () => {
		test("returns status for poured prototype", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock((cmd: string[]) => {
				expect(cmd).toEqual(["bd", "mol", "status", "mol-123", "--json"]);
				return mockSpawn(
					JSON.stringify({
						total: 3,
						completed: 1,
						inProgress: 1,
						blocked: 0,
					}),
				);
			});

			const status = await getConvoyStatus("/test/dir", "mol-123");

			expect(status).toBeDefined();
			expect(status.total).toBe(3);
			expect(status.completed).toBe(1);
			expect(status.inProgress).toBe(1);
			expect(status.blocked).toBe(0);
		});

		test("handles empty poured prototype", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn(
					JSON.stringify({
						total: 0,
						completed: 0,
						inProgress: 0,
						blocked: 0,
					}),
				);
			});

			const status = await getConvoyStatus("/test/dir", "mol-empty");

			expect(status.total).toBe(0);
			expect(status.completed).toBe(0);
			expect(status.inProgress).toBe(0);
			expect(status.blocked).toBe(0);
		});

		test("throws AgentError for nonexistent prototype", async () => {
			// @ts-expect-error - Mocking Bun.spawn for testing
			Bun.spawn = mock(() => {
				return mockSpawn("", "prototype not found", 1);
			});

			await expect(getConvoyStatus("/test/dir", "nonexistent-mol-id")).rejects.toThrow(AgentError);
		});
	});
});
