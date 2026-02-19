import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { createWebSocketManager, type WebSocketData } from "./websocket.ts";

let tempDir: string;
let legioDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ws-test-"));
	legioDir = join(tempDir, ".legio");
	await mkdir(legioDir, { recursive: true });
	await writeFile(
		join(legioDir, "config.yaml"),
		"project:\n  name: test\n  canonicalBranch: main\nagents:\n  maxDepth: 2\ncoordinator:\n  model: sonnet\n",
	);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("createWebSocketManager", () => {
	it("returns a manager with the expected interface", () => {
		const manager = createWebSocketManager(legioDir);
		expect(typeof manager.addClient).toBe("function");
		expect(typeof manager.removeClient).toBe("function");
		expect(typeof manager.handleMessage).toBe("function");
		expect(typeof manager.startPolling).toBe("function");
		expect(typeof manager.stopPolling).toBe("function");
	});

	it("startPolling and stopPolling do not throw", () => {
		const manager = createWebSocketManager(legioDir);
		expect(() => manager.startPolling()).not.toThrow();
		expect(() => manager.stopPolling()).not.toThrow();
	});

	it("stopPolling is idempotent", () => {
		const manager = createWebSocketManager(legioDir);
		expect(() => {
			manager.stopPolling();
			manager.stopPolling();
		}).not.toThrow();
	});

	it("gatherSnapshot returns valid shape with missing dbs", () => {
		// Use a non-existent dir — all stores will fail to open and fall back to empty data
		const manager = createWebSocketManager(join(tempDir, "no-such-dir"));
		// We test gatherSnapshot indirectly via addClient's initial snapshot send
		let received: string | null = null;
		const fakeWs = {
			send(msg: string) {
				received = msg;
			},
		} as unknown as WebSocket;
		// WebSocketData is unused at runtime but keeps test aligned with implementation
		const _unused: WebSocketData = { connectedAt: "" };

		manager.addClient(fakeWs);

		expect(received).not.toBeNull();
		if (received === null) throw new Error("expected a message");
		const parsed = JSON.parse(received);
		expect(parsed.type).toBe("snapshot");
		expect(parsed.data).toBeDefined();
		expect(Array.isArray(parsed.data.agents)).toBe(true);
		expect(typeof parsed.data.mail.unreadCount).toBe("number");
		expect(Array.isArray(parsed.data.mergeQueue)).toBe(true);
		expect(typeof parsed.data.metrics.totalSessions).toBe("number");
		expect(parsed.timestamp).toBeDefined();
	});

	it("addClient sends initial snapshot immediately", () => {
		const manager = createWebSocketManager(legioDir);
		let received: string | null = null;

		const fakeWs = {
			send(msg: string) {
				received = msg;
			},
		} as unknown as WebSocket;

		manager.addClient(fakeWs);
		expect(received).not.toBeNull();
		if (received === null) throw new Error("expected a message");

		const snapshot = JSON.parse(received);
		expect(snapshot.type).toBe("snapshot");
	});

	it("removeClient stops further sends to that client", () => {
		const manager = createWebSocketManager(legioDir);
		let count = 0;

		const fakeWs = {
			send() {
				count++;
			},
		} as unknown as WebSocket;

		manager.addClient(fakeWs); // triggers 1 send (initial snapshot)
		const countAfterAdd = count;
		expect(countAfterAdd).toBe(1);

		manager.removeClient(fakeWs);

		// Trigger broadcast — should not reach removed client
		const fakeWs2 = {
			send() {
				count++;
			},
		} as unknown as WebSocket;
		manager.addClient(fakeWs2); // sends to ws2, not to ws1

		// count should only increase by 1 (for fakeWs2 add), not for fakeWs
		expect(count).toBe(2);
	});

	it("handleMessage with {type:'refresh'} sends a snapshot to that client", () => {
		const manager = createWebSocketManager(legioDir);
		const received: string[] = [];

		const fakeWs = {
			send(msg: string) {
				received.push(msg);
			},
		} as unknown as WebSocket;

		manager.addClient(fakeWs); // initial snapshot = received[0]
		manager.handleMessage(fakeWs, Buffer.from(JSON.stringify({ type: "refresh" })));

		expect(received.length).toBe(2);
		const refreshed = JSON.parse(received[1] as string);
		expect(refreshed.type).toBe("snapshot");
	});

	it("handleMessage with unknown type does not throw", () => {
		const manager = createWebSocketManager(legioDir);
		const fakeWs = {
			send() {},
		} as unknown as WebSocket;

		manager.addClient(fakeWs);
		expect(() =>
			manager.handleMessage(fakeWs, Buffer.from(JSON.stringify({ type: "unknown" }))),
		).not.toThrow();
	});

	it("handleMessage with invalid JSON does not throw", () => {
		const manager = createWebSocketManager(legioDir);
		const fakeWs = {
			send() {},
		} as unknown as WebSocket;

		manager.addClient(fakeWs);
		expect(() => manager.handleMessage(fakeWs, Buffer.from("not-json{{{"))).not.toThrow();
	});

	it("multiple clients receive snapshot when added", () => {
		const manager = createWebSocketManager(legioDir);
		const messages: Record<string, string[]> = { a: [], b: [] };

		const ws1 = {
			send(msg: string) {
				messages.a?.push(msg);
			},
		} as unknown as WebSocket;

		const ws2 = {
			send(msg: string) {
				messages.b?.push(msg);
			},
		} as unknown as WebSocket;

		manager.addClient(ws1);
		manager.addClient(ws2);

		expect(messages.a?.length).toBe(1);
		expect(messages.b?.length).toBe(1);

		const snap1 = JSON.parse(messages.a?.[0] ?? "{}");
		const snap2 = JSON.parse(messages.b?.[0] ?? "{}");
		expect(snap1.type).toBe("snapshot");
		expect(snap2.type).toBe("snapshot");
	});
});

describe("WebSocket integration (real server)", () => {
	it("client receives initial snapshot on connect and can request refresh", async () => {
		// Dynamic import to avoid top-level routes.ts dependency issues
		const { createServer } = await import("./index.ts");
		const { WebSocket: WsClient } = await import("ws");

		const server = await createServer({ port: 0, host: "localhost", root: tempDir });
		const port = server.port;

		try {
			const ws = new WsClient(`ws://localhost:${port}/ws`);

			const messages: string[] = [];
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
				ws.onmessage = (e) => {
					messages.push(e.data as string);
					if (messages.length === 1) {
						// Got initial snapshot, send refresh
						ws.send(JSON.stringify({ type: "refresh" }));
					} else {
						clearTimeout(timeout);
						resolve();
					}
				};
				ws.onerror = () => reject(new Error("ws error"));
			});

			expect(messages.length).toBeGreaterThanOrEqual(2);
			const initial = JSON.parse(messages[0] as string);
			expect(initial.type).toBe("snapshot");
			const refreshed = JSON.parse(messages[1] as string);
			expect(refreshed.type).toBe("snapshot");

			ws.close();
		} finally {
			server.stop(true);
		}
	});
});
