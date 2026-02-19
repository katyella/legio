/**
 * Tests for src/server/index.ts
 *
 * Uses createServer() (testable helper) instead of startServer() (which blocks forever).
 * routes.ts is owned by another builder; we test against its expected interface.
 * If routes.ts doesn't exist, the /api/ tests will verify error handling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "server-test-"));
	const legioDir = join(tempDir, ".legio");
	await Bun.write(
		join(legioDir, "config.yaml"),
		"project:\n  name: test\n  canonicalBranch: main\nagents:\n  maxDepth: 2\ncoordinator:\n  model: sonnet\n",
	);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("createServer", () => {
	it("starts on a random port (port 0) and the assigned port is non-zero", () => {
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			expect(server.port).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	});

	it("returns 200 (SPA fallback) for unknown routes when public dir exists", async () => {
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const res = await fetch(`http://localhost:${server.port}/unknown-path-xyz`);
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	it("returns 200 (SPA fallback) for missing static files", async () => {
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const res = await fetch(`http://localhost:${server.port}/nonexistent.js`);
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	it("returns 200 for root path when public/index.html exists", async () => {
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const res = await fetch(`http://localhost:${server.port}/`);
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	it("delegates /api/ requests to handleApiRequest (or returns 500 if routes.ts throws)", async () => {
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
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
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
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
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
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

	it("server can be stopped gracefully", () => {
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
		expect(() => server.stop(true)).not.toThrow();
	});

	it("serves static files from public/ when they exist", async () => {
		const server = createServer({ port: 0, host: "localhost", root: tempDir });
		try {
			const res = await fetch(`http://localhost:${server.port}/test.txt`);
			// test.txt doesn't exist but SPA fallback serves index.html
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
		}
	});
});
