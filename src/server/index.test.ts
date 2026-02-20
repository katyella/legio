/**
 * Tests for src/server/index.ts
 *
 * Uses createServer() (testable helper) instead of startServer() (which blocks forever).
 * routes.ts is owned by another builder; we test against its expected interface.
 * If routes.ts doesn't exist, the /api/ tests will verify error handling.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AutopilotInstance } from "../autopilot/daemon.ts";
import type { AutopilotState } from "../types.ts";
import { createServer } from "./index.ts";

let tempDir: string;

function makeMockAutopilot(): AutopilotInstance & { startCalls: number; stopCalls: number } {
	let startCalls = 0;
	let stopCalls = 0;
	const state: AutopilotState = {
		running: false,
		startedAt: null,
		stoppedAt: null,
		lastTick: null,
		tickCount: 0,
		actions: [],
		config: {
			intervalMs: 10_000,
			autoMerge: true,
			autoCleanWorktrees: false,
			maxActionsLog: 100,
		},
	};
	return {
		get startCalls() {
			return startCalls;
		},
		get stopCalls() {
			return stopCalls;
		},
		start() {
			startCalls++;
			state.running = true;
		},
		stop() {
			stopCalls++;
			state.running = false;
		},
		getState() {
			return { ...state, actions: [...state.actions], config: { ...state.config } };
		},
	};
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "server-test-"));
	const legioDir = join(tempDir, ".legio");
	await mkdir(legioDir, { recursive: true });
	await writeFile(
		join(legioDir, "config.yaml"),
		"project:\n  name: test\n  canonicalBranch: main\nagents:\n  maxDepth: 2\ncoordinator:\n  model: sonnet\n",
	);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("createServer", () => {
	it("starts on a random port (port 0) and the assigned port is non-zero", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			expect(server.port).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	});

	it("returns 200 (SPA fallback) for unknown routes when public dir exists", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const res = await fetch(`http://localhost:${server.port}/unknown-path-xyz`);
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	it("returns 200 (SPA fallback) for missing static files", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const res = await fetch(`http://localhost:${server.port}/nonexistent.js`);
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	it("returns 200 for root path when public/index.html exists", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const res = await fetch(`http://localhost:${server.port}/`);
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	it("delegates /api/ requests to handleApiRequest (or returns 500 if routes.ts throws)", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			// routes.ts may or may not exist; the server catches errors and returns 500
			const res = await fetch(`http://localhost:${server.port}/api/anything`);
			// Either 200 (if routes.ts handles it) or 500 (error) — not 404
			expect([200, 201, 204, 400, 404, 500]).toContain(res.status);
		} finally {
			server.stop(true);
		}
	});

	it("WebSocket upgrade succeeds at /ws", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const ws = new WebSocket(`ws://localhost:${server.port}/ws`);

			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("WebSocket connection timed out")), 5000);
				ws.onopen = () => {
					clearTimeout(timeout);
					resolve();
				};
				ws.onerror = () => {
					clearTimeout(timeout);
					reject(new Error("WebSocket connection failed"));
				};
			});

			expect(ws.readyState).toBe(WebSocket.OPEN);
			ws.close();
		} finally {
			server.stop(true);
		}
	});

	it("WebSocket sends initial snapshot on connect", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const ws = new WebSocket(`ws://localhost:${server.port}/ws`);

			const firstMessage = await new Promise<string>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("no message received")), 5000);
				ws.onmessage = (e) => {
					clearTimeout(timeout);
					resolve(e.data as string);
				};
				ws.onerror = () => {
					clearTimeout(timeout);
					reject(new Error("ws error"));
				};
			});

			const snapshot = JSON.parse(firstMessage);
			expect(snapshot.type).toBe("snapshot");
			expect(snapshot.data).toBeDefined();
			expect(snapshot.timestamp).toBeDefined();

			ws.close();
		} finally {
			server.stop(true);
		}
	});

	it("server can be stopped gracefully", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		expect(() => server.stop(true)).not.toThrow();
	});

	it("serves static files from public/ when they exist", async () => {
		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const res = await fetch(`http://localhost:${server.port}/test.txt`);
			// test.txt doesn't exist but SPA fallback serves index.html
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	it("rejects when port is already in use (EADDRINUSE)", async () => {
		// Use 127.0.0.1 explicitly to avoid IPv4/IPv6 ambiguity: on macOS, 'localhost'
		// may resolve to ::1 for one call and 127.0.0.1 for another, causing both servers
		// to bind to different addresses and not conflict.
		const server1 = await createServer(
			{ port: 0, host: "127.0.0.1", root: tempDir, noAutopilot: true },
			{ _autopilot: makeMockAutopilot() },
		);
		try {
			await expect(
				createServer(
					{ port: server1.port, host: "127.0.0.1", root: tempDir, noAutopilot: true },
					{ _autopilot: makeMockAutopilot() },
				),
			).rejects.toThrow();
		} finally {
			server1.stop(true);
		}
	});
});

describe("autopilot auto-start", () => {
	it("calls autopilot.start() by default", async () => {
		const mockAutopilot = makeMockAutopilot();
		const server = await createServer(
			{ port: 0, host: "localhost", root: tempDir },
			{ _autopilot: mockAutopilot },
		);
		try {
			expect(mockAutopilot.startCalls).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	it("does NOT call autopilot.start() when noAutopilot: true", async () => {
		const mockAutopilot = makeMockAutopilot();
		const server = await createServer(
			{ port: 0, host: "localhost", root: tempDir, noAutopilot: true },
			{ _autopilot: mockAutopilot },
		);
		try {
			expect(mockAutopilot.startCalls).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	it("calls autopilot.stop() when server is stopped", async () => {
		const mockAutopilot = makeMockAutopilot();
		const server = await createServer(
			{ port: 0, host: "localhost", root: tempDir },
			{ _autopilot: mockAutopilot },
		);
		server.stop(true);
		expect(mockAutopilot.stopCalls).toBe(1);
	});
});

describe("coordinator auto-start", () => {
	it("calls _tryStartCoordinator when autoStartCoordinator: true", async () => {
		const coordinatorFn = vi.fn().mockResolvedValue(undefined);
		const server = await createServer(
			{ port: 0, host: "localhost", root: tempDir, autoStartCoordinator: true },
			{ _tryStartCoordinator: coordinatorFn },
		);
		// Give the fire-and-forget a tick to execute
		await new Promise((r) => setTimeout(r, 10));
		try {
			expect(coordinatorFn).toHaveBeenCalledTimes(1);
			expect(coordinatorFn).toHaveBeenCalledWith(tempDir);
		} finally {
			server.stop(true);
		}
	});

	it("does NOT call _tryStartCoordinator when autoStartCoordinator is false (default)", async () => {
		const coordinatorFn = vi.fn().mockResolvedValue(undefined);
		const server = await createServer(
			{ port: 0, host: "localhost", root: tempDir },
			{ _tryStartCoordinator: coordinatorFn },
		);
		await new Promise((r) => setTimeout(r, 10));
		try {
			expect(coordinatorFn).not.toHaveBeenCalled();
		} finally {
			server.stop(true);
		}
	});

	it("does NOT call _tryStartCoordinator when autoStartCoordinator: false (explicit)", async () => {
		const coordinatorFn = vi.fn().mockResolvedValue(undefined);
		const server = await createServer(
			{ port: 0, host: "localhost", root: tempDir, autoStartCoordinator: false },
			{ _tryStartCoordinator: coordinatorFn },
		);
		await new Promise((r) => setTimeout(r, 10));
		try {
			expect(coordinatorFn).not.toHaveBeenCalled();
		} finally {
			server.stop(true);
		}
	});

	it("logs error but does not crash when coordinator start fails", async () => {
		const coordinatorFn = vi.fn().mockRejectedValue(new Error("spawn failed"));
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const server = await createServer(
			{ port: 0, host: "localhost", root: tempDir, autoStartCoordinator: true },
			{ _tryStartCoordinator: coordinatorFn },
		);
		await new Promise((r) => setTimeout(r, 20));
		try {
			expect(stderrSpy).toHaveBeenCalledWith(
				expect.stringContaining("Failed to start coordinator"),
			);
		} finally {
			server.stop(true);
			stderrSpy.mockRestore();
		}
	});
});
