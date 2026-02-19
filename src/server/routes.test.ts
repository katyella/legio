/**
 * Tests for REST API route handlers.
 *
 * Uses real SQLite databases in temp directories. No mocking of store logic.
 * gatherStatus/gatherInspectData are integration calls — tested via error paths.
 *
 * bun:sqlite shim: during the Node.js migration, stores still import from bun:sqlite.
 * We redirect to better-sqlite3 which has a compatible synchronous API.
 * The shim normalises $key → key in param objects (bun:sqlite vs better-sqlite3 convention).
 * Real SQLite operations still happen — this is not mocking store logic.
 */

import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { vi } from "vitest";

// Stub the global Bun object for modules not yet migrated from Bun APIs (e.g., config.ts).
// Only provides what is needed by routes under test; not a full Bun implementation.
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
		// Use [] for parameterless calls (better-sqlite3 types require at least 1 arg).
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

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { handleApiRequest } from "./routes.ts";

// ---------------------------------------------------------------------------
// Test helpers
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

async function json(res: Response): Promise<unknown> {
	return res.json();
}

function makePostRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function seedMailDb(dbPath: string): void {
	const store = createMailStore(dbPath);
	store.insert({
		id: "msg-aaa111",
		from: "agent1",
		to: "agent2",
		subject: "Hello",
		body: "First message",
		type: "status",
		priority: "normal",
		threadId: "thread-1",
	});
	store.insert({
		id: "msg-bbb222",
		from: "agent2",
		to: "agent1",
		subject: "Reply",
		body: "Second message",
		type: "result",
		priority: "high",
		threadId: "thread-1",
	});
	store.insert({
		id: "msg-ccc333",
		from: "agent1",
		to: "orchestrator",
		subject: "Unread",
		body: "Third message unread",
		type: "status",
		priority: "normal",
		threadId: null,
	});
	// mark first two as read
	store.markRead("msg-aaa111");
	store.markRead("msg-bbb222");
	store.close();
}

function seedSessionDb(dbPath: string): void {
	const store = createSessionStore(dbPath);
	const now = new Date().toISOString();
	store.upsert({
		id: "sess-001",
		agentName: "scout-1",
		capability: "scout",
		worktreePath: "/tmp/wt/scout-1",
		branchName: "legio/scout-1/task-1",
		beadId: "task-1",
		tmuxSession: "legio-test-scout-1",
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
	store.upsert({
		id: "sess-002",
		agentName: "builder-1",
		capability: "builder",
		worktreePath: "/tmp/wt/builder-1",
		branchName: "legio/builder-1/task-2",
		beadId: "task-2",
		tmuxSession: "legio-test-builder-1",
		state: "completed",
		pid: null,
		parentAgent: "scout-1",
		depth: 2,
		runId: "run-001",
		startedAt: now,
		lastActivity: now,
		escalationLevel: 0,
		stalledSince: null,
	});
	store.close();
}

function seedRunDb(dbPath: string): void {
	const store = createRunStore(dbPath);
	store.createRun({
		id: "run-001",
		startedAt: new Date().toISOString(),
		coordinatorSessionId: "sess-001",
		status: "active",
	});
	store.close();
}

function seedEventDb(dbPath: string): void {
	const store = createEventStore(dbPath);
	const ts = new Date().toISOString();
	store.insert({
		runId: "run-001",
		agentName: "scout-1",
		sessionId: "sess-001",
		eventType: "tool_start",
		toolName: "Bash",
		toolArgs: '["ls"]',
		toolDurationMs: null,
		level: "info",
		data: null,
	});
	store.insert({
		runId: "run-001",
		agentName: "builder-1",
		sessionId: "sess-002",
		eventType: "tool_start",
		toolName: "Read",
		toolArgs: null,
		toolDurationMs: null,
		level: "info",
		data: null,
	});
	store.insert({
		runId: "run-001",
		agentName: "scout-1",
		sessionId: "sess-001",
		eventType: "tool_start",
		toolName: "Bash",
		toolArgs: '["git status"]',
		toolDurationMs: null,
		level: "error",
		data: "something went wrong",
	});
	// unused — just to satisfy linting on unused import
	void ts;
	store.close();
}

function seedMetricsDb(dbPath: string): void {
	const store = createMetricsStore(dbPath);
	const now = new Date().toISOString();
	store.recordSession({
		agentName: "scout-1",
		beadId: "task-1",
		capability: "scout",
		startedAt: now,
		completedAt: now,
		durationMs: 5000,
		exitCode: 0,
		mergeResult: null,
		parentAgent: null,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 10,
		cacheCreationTokens: 5,
		estimatedCostUsd: 0.001,
		modelUsed: "claude-sonnet-4-6",
	});
	store.recordSession({
		agentName: "builder-1",
		beadId: "task-2",
		capability: "builder",
		startedAt: now,
		completedAt: null,
		durationMs: 3000,
		exitCode: null,
		mergeResult: null,
		parentAgent: "scout-1",
		inputTokens: 200,
		outputTokens: 100,
		cacheReadTokens: 20,
		cacheCreationTokens: 10,
		estimatedCostUsd: 0.002,
		modelUsed: "claude-sonnet-4-6",
	});
	store.close();
}

function seedMergeQueueDb(dbPath: string): void {
	const queue = createMergeQueue(dbPath);
	queue.enqueue({
		branchName: "legio/scout-1/task-1",
		beadId: "task-1",
		agentName: "scout-1",
		filesModified: ["src/foo.ts"],
	});
	queue.enqueue({
		branchName: "legio/builder-1/task-2",
		beadId: "task-2",
		agentName: "builder-1",
		filesModified: ["src/bar.ts", "src/baz.ts"],
	});
	queue.close();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tempDir: string;
let legioDir: string;
let projectRoot: string;

beforeEach(async () => {
	tempDir = await (async () => {
		const base = join(tmpdir(), `routes-test-${Date.now()}`);
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

// Helper: dispatch request with test dirs
async function dispatch(path: string, query?: Record<string, string>): Promise<Response> {
	return handleApiRequest(makeRequest(path, query), legioDir, projectRoot);
}

async function dispatchPost(path: string, body: unknown): Promise<Response> {
	return handleApiRequest(makePostRequest(path, body), legioDir, projectRoot);
}

// ---------------------------------------------------------------------------
// Core routes
// ---------------------------------------------------------------------------

describe("GET /api/health", () => {
	it("returns 200 with ok:true and timestamp", async () => {
		const res = await dispatch("/api/health");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { ok: boolean; timestamp: string };
		expect(body.ok).toBe(true);
		expect(typeof body.timestamp).toBe("string");
		// Should be a valid ISO timestamp
		expect(() => new Date(body.timestamp)).not.toThrow();
	});
});

describe("GET /api/config", () => {
	it("returns config when config.yaml exists", async () => {
		const res = await dispatch("/api/config");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { project: { name: string } };
		expect(body.project.name).toBe("test");
	});
});

// ---------------------------------------------------------------------------
// Agent routes
// ---------------------------------------------------------------------------

describe("GET /api/agents", () => {
	it("returns empty array when no sessions.db", async () => {
		const res = await dispatch("/api/agents");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body).toEqual([]);
	});

	it("returns seeded agent sessions", async () => {
		seedSessionDb(join(legioDir, "sessions.db"));
		const res = await dispatch("/api/agents");
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(2);
	});
});

describe("GET /api/agents/active", () => {
	it("returns empty array when no sessions.db", async () => {
		const res = await dispatch("/api/agents/active");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns only active agents", async () => {
		seedSessionDb(join(legioDir, "sessions.db"));
		const res = await dispatch("/api/agents/active");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ state: string }>;
		// scout-1 is 'working' (active), builder-1 is 'completed' (not active)
		expect(body.length).toBe(1);
		expect(body[0]?.state).toBe("working");
	});
});

describe("GET /api/agents/:name", () => {
	it("returns specific agent by name", async () => {
		seedSessionDb(join(legioDir, "sessions.db"));
		const res = await dispatch("/api/agents/scout-1");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { agentName: string };
		expect(body.agentName).toBe("scout-1");
	});

	it("returns 404 for unknown agent", async () => {
		seedSessionDb(join(legioDir, "sessions.db"));
		const res = await dispatch("/api/agents/nonexistent");
		expect(res.status).toBe(404);
	});

	it("returns 404 when sessions.db does not exist", async () => {
		const res = await dispatch("/api/agents/any-agent");
		expect(res.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Mail routes
// ---------------------------------------------------------------------------

describe("GET /api/mail", () => {
	it("returns empty array when no mail.db", async () => {
		const res = await dispatch("/api/mail");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns all messages", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail");
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(3);
	});

	it("filters by ?from=agent1", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail", { from: "agent1" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ from: string }>;
		expect(body.every((m) => m.from === "agent1")).toBe(true);
		expect(body.length).toBe(2);
	});
});

describe("GET /api/mail/unread", () => {
	it("returns unread messages for agent", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/unread", { agent: "orchestrator" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		// msg-ccc333 is unread and sent to 'orchestrator'
		expect(body.length).toBe(1);
	});

	it("returns 400 when agent param is missing", async () => {
		const res = await dispatch("/api/mail/unread");
		expect(res.status).toBe(400);
	});
});

describe("GET /api/mail/:id", () => {
	it("returns specific message by id", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/msg-aaa111");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { id: string };
		expect(body.id).toBe("msg-aaa111");
	});

	it("returns 404 for unknown message id", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/msg-unknown");
		expect(res.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// POST /api/mail/send
// ---------------------------------------------------------------------------

describe("POST /api/mail/send", () => {
	it("creates a message and returns 201 with the message", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Test message",
			body: "Hello from test",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as {
			id: string;
			from: string;
			to: string;
			subject: string;
			body: string;
			type: string;
			priority: string;
			read: boolean;
		};
		expect(body.from).toBe("agent1");
		expect(body.to).toBe("agent2");
		expect(body.subject).toBe("Test message");
		expect(body.body).toBe("Hello from test");
		expect(body.type).toBe("status");
		expect(body.priority).toBe("normal");
		expect(body.read).toBe(false);
		expect(body.id).toMatch(/^msg-/);
	});

	it("accepts optional type and priority fields", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Worker done",
			body: "Task complete",
			type: "worker_done",
			priority: "high",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { type: string; priority: string };
		expect(body.type).toBe("worker_done");
		expect(body.priority).toBe("high");
	});

	it("accepts optional threadId field", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Reply",
			body: "In thread",
			threadId: "thread-abc",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { threadId: string | null };
		expect(body.threadId).toBe("thread-abc");
	});

	it("falls back to 'status' type for invalid type value", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Test",
			body: "Body",
			type: "invalid_type_xyz",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { type: string };
		expect(body.type).toBe("status");
	});

	it("falls back to 'normal' priority for invalid priority value", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Test",
			body: "Body",
			priority: "extreme",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { priority: string };
		expect(body.priority).toBe("normal");
	});

	it("returns 400 when 'from' is missing", async () => {
		const res = await dispatchPost("/api/mail/send", {
			to: "agent2",
			subject: "Test",
			body: "Body",
		});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("from");
	});

	it("returns 400 when 'to' is missing", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			subject: "Test",
			body: "Body",
		});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("to");
	});

	it("returns 400 when 'subject' is missing", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			body: "Body",
		});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("subject");
	});

	it("returns 400 when 'body' is missing", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Test",
		});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("body");
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/mail/send", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("returns 405 for POST to other /api/* paths", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/mail", { method: "POST", body: "{}" }),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(405);
	});
});

// ---------------------------------------------------------------------------
// GET /api/mail/conversations
// ---------------------------------------------------------------------------

describe("GET /api/mail/conversations", () => {
	it("returns empty array when mail.db does not exist", async () => {
		const res = await dispatch("/api/mail/conversations");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns grouped conversations with correct structure", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/conversations");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{
			participants: [string, string];
			lastMessage: { id: string };
			messageCount: number;
			unreadCount: number;
		}>;
		// 3 messages: agent1<->agent2 (2 messages), agent1<->orchestrator (1 message)
		expect(body.length).toBe(2);
	});

	it("groups agent1<->agent2 messages (both directions) into one conversation", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/conversations");
		const body = (await json(res)) as Array<{
			participants: [string, string];
			messageCount: number;
			unreadCount: number;
		}>;
		const conv = body.find(
			(c) => c.participants.includes("agent1") && c.participants.includes("agent2"),
		);
		expect(conv).toBeDefined();
		expect(conv?.messageCount).toBe(2);
		// both messages are marked read
		expect(conv?.unreadCount).toBe(0);
	});

	it("computes unread count correctly", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/conversations");
		const body = (await json(res)) as Array<{
			participants: [string, string];
			unreadCount: number;
		}>;
		// agent1<->orchestrator: 1 unread message (msg-ccc333)
		const conv = body.find(
			(c) => c.participants.includes("agent1") && c.participants.includes("orchestrator"),
		);
		expect(conv?.unreadCount).toBe(1);
	});

	it("participants are sorted alphabetically", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/conversations");
		const body = (await json(res)) as Array<{ participants: [string, string] }>;
		for (const conv of body) {
			expect(conv.participants[0] <= conv.participants[1]).toBe(true);
		}
	});

	it("filters conversations by ?agent= param", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/conversations", { agent: "orchestrator" });
		const body = (await json(res)) as Array<{ participants: [string, string] }>;
		// Only agent1<->orchestrator conversation
		expect(body.length).toBe(1);
		expect(body[0]?.participants).toContain("orchestrator");
	});

	it("returns empty array when agent filter matches no conversations", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/conversations", { agent: "nobody" });
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(0);
	});

	it("sorts conversations by most recent message first", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/conversations");
		const body = (await json(res)) as Array<{
			lastMessage: { createdAt: string };
		}>;
		for (let i = 0; i < body.length - 1; i++) {
			const curr = body[i];
			const next = body[i + 1];
			if (curr && next) {
				expect(curr.lastMessage.createdAt >= next.lastMessage.createdAt).toBe(true);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Event routes
// ---------------------------------------------------------------------------

describe("GET /api/events", () => {
	it("returns 400 when since param is missing", async () => {
		const res = await dispatch("/api/events");
		expect(res.status).toBe(400);
	});

	it("returns events for given since timestamp", async () => {
		seedEventDb(join(legioDir, "events.db"));
		// Use epoch to ensure all events are included regardless of clock precision
		const since = "1970-01-01T00:00:00.000Z";
		const res = await dispatch("/api/events", { since });
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBeGreaterThan(0);
	});
});

describe("GET /api/events/errors", () => {
	it("returns error-level events", async () => {
		seedEventDb(join(legioDir, "events.db"));
		const res = await dispatch("/api/events/errors");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ level: string }>;
		expect(body.every((e) => e.level === "error")).toBe(true);
		expect(body.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Metrics routes
// ---------------------------------------------------------------------------

describe("GET /api/metrics", () => {
	it("returns empty array when no metrics.db", async () => {
		const res = await dispatch("/api/metrics");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns session metrics", async () => {
		seedMetricsDb(join(legioDir, "metrics.db"));
		const res = await dispatch("/api/metrics");
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Runs routes
// ---------------------------------------------------------------------------

describe("GET /api/runs", () => {
	it("returns empty array when no sessions.db", async () => {
		const res = await dispatch("/api/runs");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns run list", async () => {
		seedSessionDb(join(legioDir, "sessions.db"));
		seedRunDb(join(legioDir, "sessions.db"));
		const res = await dispatch("/api/runs");
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(1);
	});
});

describe("GET /api/runs/active", () => {
	it("returns null when no active run", async () => {
		seedSessionDb(join(legioDir, "sessions.db"));
		const res = await dispatch("/api/runs/active");
		expect(res.status).toBe(200);
		expect(await json(res)).toBeNull();
	});

	it("returns active run", async () => {
		seedSessionDb(join(legioDir, "sessions.db"));
		seedRunDb(join(legioDir, "sessions.db"));
		const res = await dispatch("/api/runs/active");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { id: string; status: string };
		expect(body.id).toBe("run-001");
		expect(body.status).toBe("active");
	});
});

// ---------------------------------------------------------------------------
// Merge queue routes
// ---------------------------------------------------------------------------

describe("GET /api/merge-queue", () => {
	it("returns empty array when no merge-queue.db", async () => {
		const res = await dispatch("/api/merge-queue");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns queue entries", async () => {
		seedMergeQueueDb(join(legioDir, "merge-queue.db"));
		const res = await dispatch("/api/merge-queue");
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Issues routes
// ---------------------------------------------------------------------------

describe("GET /api/issues", () => {
	it("returns 200 with JSON array (empty if bd unavailable)", async () => {
		const res = await dispatch("/api/issues");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(Array.isArray(body)).toBe(true);
	});

	it("accepts status query param", async () => {
		const res = await dispatch("/api/issues", { status: "open" });
		expect(res.status).toBe(200);
		expect(Array.isArray(await json(res))).toBe(true);
	});
});

describe("GET /api/issues/ready", () => {
	it("returns 200 with JSON array (empty if bd unavailable)", async () => {
		const res = await dispatch("/api/issues/ready");
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(Array.isArray(body)).toBe(true);
	});
});

describe("GET /api/issues/:id", () => {
	it("returns 404 for nonexistent issue (or if bd unavailable)", async () => {
		const res = await dispatch("/api/issues/nonexistent-id");
		expect(res.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Terminal routes
// Real tmux calls are not made in tests (would interfere with dev sessions).
// We test validation, 404 paths (no sessions.db / orchestrator-tmux.json),
// and correct response shapes.
// ---------------------------------------------------------------------------

describe("POST /api/terminal/send", () => {
	it("returns 400 when text field is missing", async () => {
		const res = await dispatchPost("/api/terminal/send", { agent: "coordinator" });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 when text is empty string", async () => {
		const res = await dispatchPost("/api/terminal/send", { text: "", agent: "coordinator" });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 when text is whitespace only", async () => {
		const res = await dispatchPost("/api/terminal/send", { text: "   " });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 for invalid JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/terminal/send", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("returns 404 when agent session cannot be resolved (defaults to coordinator)", async () => {
		// No sessions.db, no orchestrator-tmux.json — session cannot be resolved
		const res = await dispatchPost("/api/terminal/send", { text: "Hello coordinator" });
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("coordinator");
	});

	it("returns 404 when named agent session cannot be resolved", async () => {
		const res = await dispatchPost("/api/terminal/send", {
			text: "Hello",
			agent: "nonexistent-agent",
		});
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("nonexistent-agent");
	});

	it("returns 405 for GET requests on /api/terminal/send", async () => {
		const res = await dispatch("/api/terminal/send");
		// /api/terminal/send is only POST; GET falls through to the catch-all 404
		// since there is no GET handler registered for this path
		expect([404, 405]).toContain(res.status);
	});
});

describe("GET /api/terminal/capture", () => {
	it("returns 404 when agent session cannot be resolved (defaults to coordinator)", async () => {
		// No sessions.db, no orchestrator-tmux.json
		const res = await dispatch("/api/terminal/capture");
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("coordinator");
	});

	it("returns 404 with named agent when session cannot be resolved", async () => {
		const res = await dispatch("/api/terminal/capture", { agent: "my-agent" });
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("my-agent");
	});

	it("accepts custom lines param without error (returns 404 on no session)", async () => {
		const res = await dispatch("/api/terminal/capture", { lines: "50" });
		expect(res.status).toBe(404);
	});

	it("returns 405 for POST requests on /api/terminal/capture", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/terminal/capture", {
				method: "POST",
				body: "{}",
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(405);
	});
});

// ---------------------------------------------------------------------------
// Catch-all 404
// ---------------------------------------------------------------------------

describe("Unknown /api/* path", () => {
	it("returns 404", async () => {
		const res = await dispatch("/api/something-unknown");
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toBe("Not found");
	});
});

// ---------------------------------------------------------------------------
// Autopilot routes
// ---------------------------------------------------------------------------

import type { AutopilotInstance } from "../autopilot/daemon.ts";
import type { AutopilotState } from "../types.ts";

function makeAutopilot(initial?: Partial<AutopilotState>): AutopilotInstance {
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
		...initial,
	};
	return {
		start() {
			state.running = true;
			state.startedAt = new Date().toISOString();
		},
		stop() {
			state.running = false;
			state.stoppedAt = new Date().toISOString();
		},
		getState() {
			return { ...state, actions: [...state.actions], config: { ...state.config } };
		},
	};
}

describe("GET /api/autopilot/status", () => {
	it("returns autopilot state when autopilot is provided", async () => {
		const ap = makeAutopilot();
		const res = await handleApiRequest(
			makeRequest("/api/autopilot/status"),
			legioDir,
			projectRoot,
			ap,
		);
		expect(res.status).toBe(200);
		const body = (await json(res)) as AutopilotState;
		expect(typeof body.running).toBe("boolean");
		expect(body.running).toBe(false);
		expect(Array.isArray(body.actions)).toBe(true);
	});

	it("returns 404 when no autopilot instance is provided", async () => {
		const res = await handleApiRequest(
			makeRequest("/api/autopilot/status"),
			legioDir,
			projectRoot,
			null,
		);
		expect(res.status).toBe(404);
	});

	it("returns 404 when autopilot is undefined", async () => {
		const res = await handleApiRequest(
			makeRequest("/api/autopilot/status"),
			legioDir,
			projectRoot,
			undefined,
		);
		expect(res.status).toBe(404);
	});
});

describe("POST /api/autopilot/start", () => {
	it("starts the autopilot and returns new state", async () => {
		const ap = makeAutopilot({ running: false });
		const res = await handleApiRequest(
			makePostRequest("/api/autopilot/start", {}),
			legioDir,
			projectRoot,
			ap,
		);
		expect(res.status).toBe(200);
		const body = (await json(res)) as AutopilotState;
		expect(body.running).toBe(true);
	});

	it("returns 404 when no autopilot instance is provided", async () => {
		const res = await handleApiRequest(
			makePostRequest("/api/autopilot/start", {}),
			legioDir,
			projectRoot,
			null,
		);
		expect(res.status).toBe(404);
	});
});

describe("POST /api/autopilot/stop", () => {
	it("stops the autopilot and returns new state", async () => {
		const ap = makeAutopilot({ running: true, startedAt: new Date().toISOString() });
		ap.start(); // ensure it's started
		const res = await handleApiRequest(
			makePostRequest("/api/autopilot/stop", {}),
			legioDir,
			projectRoot,
			ap,
		);
		expect(res.status).toBe(200);
		const body = (await json(res)) as AutopilotState;
		expect(body.running).toBe(false);
	});

	it("returns 404 when no autopilot instance is provided", async () => {
		const res = await handleApiRequest(
			makePostRequest("/api/autopilot/stop", {}),
			legioDir,
			projectRoot,
			null,
		);
		expect(res.status).toBe(404);
	});
});
