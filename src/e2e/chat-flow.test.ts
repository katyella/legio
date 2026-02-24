/**
 * E2E tests for the chat flow: POST and GET routes for coordinator and agent chat.
 *
 * Tests:
 *   1. POST /api/coordinator/chat stores message with from=human, to=coordinator, audience=human
 *   2. POST /api/agents/:name/chat stores message in mail.db
 *   3. GET /api/coordinator/chat/history returns bidirectional messages
 *   4. GET /api/agents/:name/chat/history returns bidirectional messages
 *   5. History excludes audience=agent messages
 *   6. Limit param works
 *
 * Uses real SQLite databases in temp directories. No mocking of store logic.
 * Mock setup mirrors routes.test.ts (see header there for rationale).
 *
 */

import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { vi } from "vitest";

// Stub the global Bun object because production modules (e.g., config.ts) still use Bun APIs
// and have not yet been migrated to Node.js equivalents. This shim provides only the subset
// of the Bun API surface required by the code paths exercised by these chat tests.
vi.stubGlobal("Bun", {
	file: (path: string) => ({
		exists: async () => {
			try {
				accessSync(path, fsConstants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		text: async () => readFileSync(path, "utf-8"),
		json: async () => JSON.parse(readFileSync(path, "utf-8")),
	}),
	spawn: () => {
		throw new Error("Bun.spawn not available in Node.js/vitest environment");
	},
	sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
	write: async (path: string, content: string) => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, content, "utf-8");
	},
});

// Redirect bun:sqlite → better-sqlite3 for Node.js/vitest compatibility.
vi.mock("bun:sqlite", async () => {
	const mod = await import("better-sqlite3");
	const BetterDb = mod.default;

	// bun:sqlite accepts { $key: value } but better-sqlite3 expects { key: value }.
	function normalizeParams(params: unknown): unknown {
		if (typeof params !== "object" || params === null || Array.isArray(params)) {
			return params;
		}
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(params as Record<string, unknown>)) {
			result[key.startsWith("$") ? key.slice(1) : key] = val;
		}
		return result;
	}

	class CompatStatement {
		private _stmt: ReturnType<InstanceType<typeof BetterDb>["prepare"]>;
		constructor(stmt: ReturnType<InstanceType<typeof BetterDb>["prepare"]>) {
			this._stmt = stmt;
		}
		// bun:sqlite returns null for missing row; better-sqlite3 returns undefined.
		get(params?: unknown) {
			const bound =
				params !== undefined
					? (normalizeParams(params) as Record<string, unknown>)
					: ([] as unknown as Record<string, unknown>);
			return (this._stmt.get(bound) as unknown) ?? null;
		}
		all(params?: unknown) {
			const bound =
				params !== undefined
					? (normalizeParams(params) as Record<string, unknown>)
					: ([] as unknown as Record<string, unknown>);
			return this._stmt.all(bound);
		}
		run(params?: unknown) {
			const bound =
				params !== undefined
					? (normalizeParams(params) as Record<string, unknown>)
					: ([] as unknown as Record<string, unknown>);
			this._stmt.run(bound);
		}
		// bun:sqlite-specific; map to all() for compatibility
		values(params?: unknown) {
			const bound =
				params !== undefined
					? (normalizeParams(params) as Record<string, unknown>)
					: ([] as unknown as Record<string, unknown>);
			return this._stmt.all(bound);
		}
	}

	class Database {
		private _db: InstanceType<typeof BetterDb>;
		constructor(path: string) {
			this._db = new BetterDb(path);
		}
		exec(sql: string) {
			return this._db.exec(sql);
		}
		prepare(sql: string) {
			return new CompatStatement(this._db.prepare(sql));
		}
		// bun:sqlite alias for prepare
		query(sql: string) {
			return new CompatStatement(this._db.prepare(sql));
		}
		close() {
			return this._db.close();
		}
	}

	return { Database };
});

// Mock the beads client so tests can run without `bd` on PATH.
vi.mock("../beads/client.ts", () => ({
	createBeadsClient: () => ({
		ready: async () => [],
		list: async () => [],
		show: async (id: string) => {
			throw new Error(`bd not available: ${id}`);
		},
		create: async () => "bead-test-001",
		claim: async () => {},
		close: async () => {},
	}),
}));

// Mock tmux so tests don't interfere with real developer tmux sessions.
const { mockIsSessionAlive, mockSendKeys } = vi.hoisted(() => ({
	mockIsSessionAlive: vi.fn().mockResolvedValue(true),
	mockSendKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../worktree/tmux.ts", () => ({
	isSessionAlive: mockIsSessionAlive,
	sendKeys: mockSendKeys,
}));

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMailStore } from "../mail/store.ts";
import { createSessionStore } from "../sessions/store.ts";
import { handleApiRequest } from "../server/routes.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(path: string, query?: Record<string, string>): Request {
	const url = new URL(`http://localhost${path}`);
	if (query) {
		for (const [k, v] of Object.entries(query)) {
			url.searchParams.set(k, v);
		}
	}
	return new Request(url.toString(), { method: "GET" });
}

function makePostRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tempDir: string;
let legioDir: string;
let projectRoot: string;

beforeEach(async () => {
	tempDir = await (async () => {
		const base = join(tmpdir(), `chat-flow-test-${Date.now()}`);
		await mkdir(base, { recursive: true });
		return base;
	})();
	legioDir = join(tempDir, ".legio");
	projectRoot = tempDir;
	await mkdir(legioDir, { recursive: true });

	// Write minimal config.yaml for loadConfig
	await writeFile(
		join(legioDir, "config.yaml"),
		[
			"project:",
			"  name: test",
			"  canonicalBranch: main",
			"agents:",
			"  maxDepth: 2",
			"coordinator:",
			"  model: claude-sonnet-4-6",
		].join("\n"),
	);
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

async function dispatch(path: string, query?: Record<string, string>): Promise<Response> {
	return handleApiRequest(makeRequest(path, query), legioDir, projectRoot);
}

async function dispatchPost(path: string, body: unknown): Promise<Response> {
	return handleApiRequest(makePostRequest(path, body), legioDir, projectRoot);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: chat flow", () => {
	it("POST /api/coordinator/chat stores message with from=human, to=coordinator, audience=human", async () => {
		// Seed orchestrator-tmux.json so resolveTerminalSession returns a session name
		await writeFile(
			join(legioDir, "orchestrator-tmux.json"),
			JSON.stringify({ tmuxSession: "legio-fake-orchestrator" }),
		);

		const res = await dispatchPost("/api/coordinator/chat", { text: "hello coordinator" });
		expect(res.status).toBe(201);

		const body = (await res.json()) as { from: string; to: string; audience: string; body: string };
		expect(body.from).toBe("human");
		expect(body.to).toBe("coordinator");
		expect(body.audience).toBe("human");
		expect(body.body).toBe("hello coordinator");

		// Verify the message was persisted in mail.db
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		const messages = mailStore.getAll({ from: "human", to: "coordinator" });
		mailStore.close();
		expect(messages.length).toBe(1);
		expect(messages[0]?.audience).toBe("human");
		expect(messages[0]?.body).toBe("hello coordinator");
	});

	it("POST /api/agents/:name/chat stores message in mail.db", async () => {
		// Seed sessions.db with test-agent in working state
		const sessStore = createSessionStore(join(legioDir, "sessions.db"));
		const now = new Date().toISOString();
		sessStore.upsert({
			id: "sess-chat-001",
			agentName: "test-agent",
			capability: "builder",
			worktreePath: "/tmp/wt/test-agent",
			branchName: "legio/test-agent/task-1",
			beadId: "task-1",
			tmuxSession: "legio-fake-test-agent",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 1,
			runId: "run-001",
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		sessStore.close();

		const res = await dispatchPost("/api/agents/test-agent/chat", { text: "hello agent" });
		expect(res.status).toBe(201);

		const body = (await res.json()) as { from: string; to: string; audience: string };
		expect(body.from).toBe("human");
		expect(body.to).toBe("test-agent");
		expect(body.audience).toBe("human");

		// Verify persisted in mail.db
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		const messages = mailStore.getAll({ from: "human", to: "test-agent" });
		mailStore.close();
		expect(messages.length).toBe(1);
		expect(messages[0]?.body).toBe("hello agent");
	});

	it("GET /api/coordinator/chat/history returns bidirectional messages", async () => {
		// Seed both directions: human→coordinator and coordinator→human
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		mailStore.insert({
			id: "msg-human-to-coord",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "user message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		mailStore.insert({
			id: "msg-coord-to-human",
			from: "coordinator",
			to: "human",
			subject: "response",
			body: "coordinator reply",
			type: "result",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		mailStore.close();

		const res = await dispatch("/api/coordinator/chat/history");
		expect(res.status).toBe(200);

		const messages = (await res.json()) as Array<{ from: string; to: string }>;
		expect(messages.length).toBe(2);
		expect(messages.some((m) => m.from === "human" && m.to === "coordinator")).toBe(true);
		expect(messages.some((m) => m.from === "coordinator" && m.to === "human")).toBe(true);
	});

	it("GET /api/agents/:name/chat/history returns bidirectional messages", async () => {
		// Seed both directions: human→agent and agent→human
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		mailStore.insert({
			id: "msg-human-to-agent",
			from: "human",
			to: "my-agent",
			subject: "chat",
			body: "user asks",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		mailStore.insert({
			id: "msg-agent-to-human",
			from: "my-agent",
			to: "human",
			subject: "response",
			body: "agent responds",
			type: "result",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		mailStore.close();

		const res = await dispatch("/api/agents/my-agent/chat/history");
		expect(res.status).toBe(200);

		const messages = (await res.json()) as Array<{ from: string; to: string }>;
		expect(messages.length).toBe(2);
		expect(messages.some((m) => m.from === "human" && m.to === "my-agent")).toBe(true);
		expect(messages.some((m) => m.from === "my-agent" && m.to === "human")).toBe(true);
	});

	it("GET /api/coordinator/chat/history excludes audience=agent messages", async () => {
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		mailStore.insert({
			id: "msg-human-visible",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "visible message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		mailStore.insert({
			id: "msg-agent-hidden",
			from: "human",
			to: "coordinator",
			subject: "internal",
			body: "agent-only message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		mailStore.close();

		const res = await dispatch("/api/coordinator/chat/history");
		expect(res.status).toBe(200);

		const messages = (await res.json()) as Array<{ id: string; audience: string }>;
		// Only the human-audience message should appear
		expect(messages.length).toBe(1);
		expect(messages[0]?.id).toBe("msg-human-visible");
		expect(messages.some((m) => m.id === "msg-agent-hidden")).toBe(false);
	});

	it("GET /api/coordinator/chat/history respects limit param", async () => {
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		for (let i = 0; i < 5; i++) {
			mailStore.insert({
				id: `msg-limit-${i}`,
				from: "human",
				to: "coordinator",
				subject: "chat",
				body: `message ${i}`,
				type: "status",
				priority: "normal",
				threadId: null,
				audience: "human",
			});
		}
		mailStore.close();

		const res = await dispatch("/api/coordinator/chat/history", { limit: "2" });
		expect(res.status).toBe(200);

		const messages = (await res.json()) as unknown[];
		expect(messages.length).toBe(2);
	});
});
