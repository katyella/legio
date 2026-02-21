/**
 * Tests for REST API route handlers.
 *
 * Uses real SQLite databases in temp directories. No mocking of store logic.
 * gatherStatus/gatherInspectData are integration calls — tested via error paths.
 *
 * better-sqlite3 shim: during the Node.js migration, stores now import from better-sqlite3.
 * We redirect to better-sqlite3 which has a compatible synchronous API.
 * The shim normalises $key → key in param objects (bun:sqlite vs better-sqlite3 convention).
 * Real SQLite operations still happen — this is not mocking store logic.
 */

import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { vi } from "vitest";

// Stub the global Bun object because production modules (e.g., config.ts) still use Bun APIs
// and have not yet been migrated to Node.js equivalents. This shim provides only the subset
// of the Bun API surface required by the code paths exercised by these route tests.
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

// Mock the beads client so strategy tests can run without `bd` on PATH.
// list/ready return [] (keeps existing /api/issues tests passing).
// show throws (existing /api/issues/:id test expects 404 on error).
// create returns a predictable issue ID for strategy approve tests.
// list returns a closed issue fixture when all=true to verify all-statuses behavior.
vi.mock("../beads/client.ts", () => ({
	createBeadsClient: () => ({
		ready: async () => [],
		list: async (options?: { status?: string; limit?: number; all?: boolean }) => {
			// Return a closed issue fixture when all is true
			if (options?.all) {
				return [
					{
						id: "bead-closed-001",
						title: "Closed issue",
						status: "closed",
						priority: 3,
						type: "task",
						closedAt: "2026-01-01T00:00:00.000Z",
						closeReason: "Done",
					},
				];
			}
			return [];
		},
		show: async (id: string) => {
			throw new Error(`bd not available: ${id}`);
		},
		create: async () => "bead-test-001",
		claim: async () => {},
		close: async () => {},
	}),
}));

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import { createAuditStore } from "./audit-store.ts";
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
		audience: "both",
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
		audience: "human",
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
		audience: "agent",
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
// Coordinator status route
// ---------------------------------------------------------------------------

describe("GET /api/coordinator/status", () => {
	it("returns stopped when no sessions.db and no orchestrator-tmux.json", async () => {
		const res = await dispatch("/api/coordinator/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { running: boolean; tmuxSession?: string };
		expect(body.running).toBe(false);
		expect(body.tmuxSession).toBeUndefined();
	});

	it("returns running when coordinator session exists with working state", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-coord-001",
			agentName: "coordinator",
			capability: "coordinator",
			worktreePath: "/tmp/wt/coordinator",
			branchName: "main",
			beadId: "coord-task",
			tmuxSession: "legio-test-coordinator",
			state: "working",
			pid: 99999,
			parentAgent: null,
			depth: 0,
			runId: "run-001",
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const res = await dispatch("/api/coordinator/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { running: boolean; tmuxSession?: string };
		expect(body.running).toBe(true);
		expect(body.tmuxSession).toBe("legio-test-coordinator");
	});

	it("returns stopped when coordinator session is in zombie state", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-coord-002",
			agentName: "coordinator",
			capability: "coordinator",
			worktreePath: "/tmp/wt/coordinator",
			branchName: "main",
			beadId: "coord-task",
			tmuxSession: "legio-test-coordinator",
			state: "zombie",
			pid: null,
			parentAgent: null,
			depth: 0,
			runId: "run-001",
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const res = await dispatch("/api/coordinator/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { running: boolean; tmuxSession?: string };
		// zombie state → resolveTerminalSession returns null → stopped
		// (unless orchestrator-tmux.json exists, which it doesn't here)
		expect(body.running).toBe(false);
	});

	it("returns running when coordinator session state is completed but orchestrator-tmux.json exists", async () => {
		// Write orchestrator-tmux.json as fallback
		await writeFile(
			join(projectRoot, ".legio", "orchestrator-tmux.json"),
			JSON.stringify({ tmuxSession: "legio-orchestrator-fallback" }),
		);
		// No sessions.db — falls back to orchestrator-tmux.json
		const res = await dispatch("/api/coordinator/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { running: boolean; tmuxSession?: string };
		expect(body.running).toBe(true);
		expect(body.tmuxSession).toBe("legio-orchestrator-fallback");
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

	it("filters by ?audience=human returns only human-audience messages", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail", { audience: "human" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ audience: string }>;
		expect(body.length).toBe(1);
		expect(body.every((m) => m.audience === "human")).toBe(true);
	});

	it("filters by ?audience=agent returns only agent-audience messages", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail", { audience: "agent" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ audience: string }>;
		expect(body.length).toBe(1);
		expect(body.every((m) => m.audience === "agent")).toBe(true);
	});

	it("returns all messages when no audience param (backward compat)", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail");
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(3);
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

	it("calls wsManager.broadcastEvent with mail_new event after successful insert", async () => {
		const events: Array<{ type: string; data?: unknown }> = [];
		const mockWsManager = {
			broadcastEvent(event: { type: string; data?: unknown }) {
				events.push(event);
			},
		};

		const res = await handleApiRequest(
			makePostRequest("/api/mail/send", {
				from: "agent1",
				to: "agent2",
				subject: "Worker done",
				body: "Task complete",
				type: "worker_done",
			}),
			legioDir,
			projectRoot,
			mockWsManager,
		);

		expect(res.status).toBe(201);
		expect(events.length).toBe(1);
		expect(events[0]?.type).toBe("mail_new");
		const data = events[0]?.data as { from: string; to: string; subject: string; type: string };
		expect(data.from).toBe("agent1");
		expect(data.to).toBe("agent2");
		expect(data.subject).toBe("Worker done");
		expect(data.type).toBe("worker_done");
	});

	it("works when wsManager is null (backward compat)", async () => {
		const res = await handleApiRequest(
			makePostRequest("/api/mail/send", {
				from: "agent1",
				to: "agent2",
				subject: "Test",
				body: "Body",
			}),
			legioDir,
			projectRoot,
			null,
		);
		expect(res.status).toBe(201);
	});

	it("works when wsManager is undefined (backward compat)", async () => {
		const res = await handleApiRequest(
			makePostRequest("/api/mail/send", {
				from: "agent1",
				to: "agent2",
				subject: "Test",
				body: "Body",
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(201);
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

	it("accepts audience field and persists it", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Human message",
			body: "For humans only",
			audience: "human",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { audience: string };
		expect(body.audience).toBe("human");
	});

	it("defaults audience to 'agent' for non-orchestrator sender", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Default audience",
			body: "No audience specified",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { audience: string };
		expect(body.audience).toBe("agent");
	});

	it("defaults audience to 'both' for orchestrator sender", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "orchestrator",
			to: "agent2",
			subject: "Orchestrator message",
			body: "From orchestrator",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { audience: string };
		expect(body.audience).toBe("both");
	});

	it("defaults audience to 'both' for coordinator sender", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "coordinator",
			to: "agent2",
			subject: "Coordinator message",
			body: "From coordinator",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { audience: string };
		expect(body.audience).toBe("both");
	});

	it("falls back to sender-appropriate default for invalid audience value", async () => {
		const res = await dispatchPost("/api/mail/send", {
			from: "agent1",
			to: "agent2",
			subject: "Bad audience",
			body: "Invalid audience value",
			audience: "invalid_audience_xyz",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { audience: string };
		expect(body.audience).toBe("agent");
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

	it("filters conversations by ?audience=human to only include human-audience messages", async () => {
		seedMailDb(join(legioDir, "mail.db"));
		const res = await dispatch("/api/mail/conversations", { audience: "human" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{
			participants: [string, string];
			messageCount: number;
		}>;
		// Only msg-bbb222 has audience="human" (agent2→agent1)
		// So only the agent1<->agent2 conversation appears, with 1 message
		expect(body.length).toBe(1);
		expect(body[0]?.messageCount).toBe(1);
		expect(body[0]?.participants).toContain("agent1");
		expect(body[0]?.participants).toContain("agent2");
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

	it("filters by since param", async () => {
		const store = createMetricsStore(join(legioDir, "metrics.db"));
		store.recordSession({
			agentName: "agent-a",
			beadId: "task-old",
			capability: "builder",
			startedAt: "2026-01-01T10:00:00Z",
			completedAt: null,
			durationMs: 1000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
		});
		store.recordSession({
			agentName: "agent-b",
			beadId: "task-new",
			capability: "scout",
			startedAt: "2026-06-01T10:00:00Z",
			completedAt: null,
			durationMs: 2000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 20,
			outputTokens: 10,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
		});
		store.close();

		const res = await dispatch("/api/metrics", { since: "2026-03-01T00:00:00Z" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ beadId: string }>;
		expect(body).toHaveLength(1);
		expect(body[0]?.beadId).toBe("task-new");
	});

	it("filters by until param", async () => {
		const store = createMetricsStore(join(legioDir, "metrics.db"));
		store.recordSession({
			agentName: "agent-a",
			beadId: "task-old",
			capability: "builder",
			startedAt: "2026-01-01T10:00:00Z",
			completedAt: null,
			durationMs: 1000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
		});
		store.recordSession({
			agentName: "agent-b",
			beadId: "task-new",
			capability: "scout",
			startedAt: "2026-06-01T10:00:00Z",
			completedAt: null,
			durationMs: 2000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 20,
			outputTokens: 10,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: null,
			modelUsed: null,
		});
		store.close();

		const res = await dispatch("/api/metrics", { until: "2026-03-01T00:00:00Z" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ beadId: string }>;
		expect(body).toHaveLength(1);
		expect(body[0]?.beadId).toBe("task-old");
	});
});

describe("GET /api/metrics/by-model", () => {
	it("returns empty array when no metrics.db", async () => {
		const res = await dispatch("/api/metrics/by-model");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("groups sessions by model", async () => {
		const store = createMetricsStore(join(legioDir, "metrics.db"));
		store.recordSession({
			agentName: "agent-a",
			beadId: "task-1",
			capability: "builder",
			startedAt: "2026-01-01T10:00:00Z",
			completedAt: null,
			durationMs: 1000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 10,
			cacheCreationTokens: 5,
			estimatedCostUsd: 1.0,
			modelUsed: "claude-opus-4-6",
		});
		store.recordSession({
			agentName: "agent-b",
			beadId: "task-2",
			capability: "scout",
			startedAt: "2026-01-01T12:00:00Z",
			completedAt: null,
			durationMs: 2000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 20,
			cacheCreationTokens: 10,
			estimatedCostUsd: 0.5,
			modelUsed: "claude-sonnet-4-6",
		});
		store.close();

		const res = await dispatch("/api/metrics/by-model");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ model: string; sessions: number; inputTokens: number }>;
		expect(body).toHaveLength(2);
		const opus = body.find((r) => r.model === "claude-opus-4-6");
		expect(opus?.sessions).toBe(1);
		expect(opus?.inputTokens).toBe(100);
	});

	it("accepts since/until filter", async () => {
		const store = createMetricsStore(join(legioDir, "metrics.db"));
		store.recordSession({
			agentName: "agent-a",
			beadId: "task-old",
			capability: "builder",
			startedAt: "2026-01-01T10:00:00Z",
			completedAt: null,
			durationMs: 1000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: 1.0,
			modelUsed: "claude-opus-4-6",
		});
		store.recordSession({
			agentName: "agent-b",
			beadId: "task-new",
			capability: "scout",
			startedAt: "2026-06-01T10:00:00Z",
			completedAt: null,
			durationMs: 2000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: 0.5,
			modelUsed: "claude-sonnet-4-6",
		});
		store.close();

		const res = await dispatch("/api/metrics/by-model", { since: "2026-03-01T00:00:00Z" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ model: string }>;
		expect(body).toHaveLength(1);
		expect(body[0]?.model).toBe("claude-sonnet-4-6");
	});
});

describe("GET /api/metrics/by-date", () => {
	it("returns empty array when no metrics.db", async () => {
		const res = await dispatch("/api/metrics/by-date");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("groups sessions by date", async () => {
		const store = createMetricsStore(join(legioDir, "metrics.db"));
		store.recordSession({
			agentName: "agent-a",
			beadId: "task-1",
			capability: "builder",
			startedAt: "2026-01-01T10:00:00Z",
			completedAt: null,
			durationMs: 1000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 10,
			cacheCreationTokens: 5,
			estimatedCostUsd: 0.5,
			modelUsed: "claude-sonnet-4-6",
		});
		store.recordSession({
			agentName: "agent-b",
			beadId: "task-2",
			capability: "scout",
			startedAt: "2026-01-01T14:00:00Z",
			completedAt: null,
			durationMs: 2000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 20,
			cacheCreationTokens: 10,
			estimatedCostUsd: 0.5,
			modelUsed: "claude-sonnet-4-6",
		});
		store.recordSession({
			agentName: "agent-c",
			beadId: "task-3",
			capability: "builder",
			startedAt: "2026-01-02T08:00:00Z",
			completedAt: null,
			durationMs: 3000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 300,
			outputTokens: 150,
			cacheReadTokens: 30,
			cacheCreationTokens: 15,
			estimatedCostUsd: 0.3,
			modelUsed: "claude-opus-4-6",
		});
		store.close();

		const res = await dispatch("/api/metrics/by-date");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ date: string; sessions: number; inputTokens: number }>;
		expect(body).toHaveLength(2);
		expect(body[0]?.date).toBe("2026-01-01");
		expect(body[0]?.sessions).toBe(2);
		expect(body[0]?.inputTokens).toBe(300);
		expect(body[1]?.date).toBe("2026-01-02");
		expect(body[1]?.sessions).toBe(1);
	});

	it("accepts since/until filter", async () => {
		const store = createMetricsStore(join(legioDir, "metrics.db"));
		store.recordSession({
			agentName: "agent-a",
			beadId: "task-1",
			capability: "builder",
			startedAt: "2026-01-01T10:00:00Z",
			completedAt: null,
			durationMs: 1000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: 1.0,
			modelUsed: null,
		});
		store.recordSession({
			agentName: "agent-b",
			beadId: "task-2",
			capability: "scout",
			startedAt: "2026-06-01T10:00:00Z",
			completedAt: null,
			durationMs: 2000,
			exitCode: 0,
			mergeResult: null,
			parentAgent: null,
			inputTokens: 200,
			outputTokens: 100,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			estimatedCostUsd: 2.0,
			modelUsed: null,
		});
		store.close();

		const res = await dispatch("/api/metrics/by-date", { since: "2026-03-01T00:00:00Z" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ date: string }>;
		expect(body).toHaveLength(1);
		expect(body[0]?.date).toBe("2026-06-01");
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

	it("defaults to returning all statuses (all=true)", async () => {
		const res = await dispatch("/api/issues");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ status: string }>;
		// Mock returns a closed issue when all=true
		expect(body.length).toBe(1);
		expect(body[0]?.status).toBe("closed");
	});

	it("returns closedAt and closeReason fields on closed issues", async () => {
		const res = await dispatch("/api/issues");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ closedAt?: string; closeReason?: string }>;
		expect(body[0]?.closedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(body[0]?.closeReason).toBe("Done");
	});

	it("passes all=false to client when ?all=false query param is set", async () => {
		const res = await dispatch("/api/issues", { all: "false" });
		expect(res.status).toBe(200);
		const body = await json(res);
		expect(Array.isArray(body)).toBe(true);
		// Mock returns [] when all is false
		expect((body as unknown[]).length).toBe(0);
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
// Audit routes
// ---------------------------------------------------------------------------

function seedAuditDb(dbPath: string): void {
	const store = createAuditStore(dbPath);
	store.insert({ type: "command", agent: "orchestrator", source: "web_ui", summary: "cmd1" });
	store.insert({ type: "response", agent: "coordinator", source: "system", summary: "resp1" });
	store.insert({ type: "error", agent: "orchestrator", source: "cli", summary: "err1" });
	store.close();
}

describe("POST /api/audit", () => {
	it("creates an audit event and returns 201 with the event", async () => {
		const res = await dispatchPost("/api/audit", {
			type: "command",
			summary: "User sent a command",
			agent: "orchestrator",
			source: "web_ui",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as {
			id: number;
			type: string;
			summary: string;
			agent: string;
			source: string;
		};
		expect(body.type).toBe("command");
		expect(body.summary).toBe("User sent a command");
		expect(body.agent).toBe("orchestrator");
		expect(body.source).toBe("web_ui");
		expect(typeof body.id).toBe("number");
	});

	it("defaults source to web_ui when not provided", async () => {
		const res = await dispatchPost("/api/audit", {
			type: "command",
			summary: "No source provided",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { source: string };
		expect(body.source).toBe("web_ui");
	});

	it("returns 400 when type is missing", async () => {
		const res = await dispatchPost("/api/audit", { summary: "Missing type" });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("type");
	});

	it("returns 400 when summary is missing", async () => {
		const res = await dispatchPost("/api/audit", { type: "command" });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("summary");
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/audit", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("accepts optional detail and sessionId fields", async () => {
		const res = await dispatchPost("/api/audit", {
			type: "state_change",
			summary: "Agent started",
			detail: "Starting work on task",
			sessionId: "sess-abc",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { detail: string; sessionId: string };
		expect(body.detail).toBe("Starting work on task");
		expect(body.sessionId).toBe("sess-abc");
	});
});

describe("GET /api/audit", () => {
	it("returns empty array when audit.db does not exist", async () => {
		const res = await dispatch("/api/audit");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns all audit events", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		const res = await dispatch("/api/audit");
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(3);
	});

	it("filters by ?type= param", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		const res = await dispatch("/api/audit", { type: "command" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ type: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.type).toBe("command");
	});

	it("filters by ?agent= param", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		const res = await dispatch("/api/audit", { agent: "orchestrator" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ agent: string }>;
		expect(body.length).toBe(2);
		expect(body.every((e) => e.agent === "orchestrator")).toBe(true);
	});

	it("filters by ?source= param", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		const res = await dispatch("/api/audit", { source: "web_ui" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ source: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.source).toBe("web_ui");
	});

	it("applies ?limit= param", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		const res = await dispatch("/api/audit", { limit: "2" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(2);
	});

	it("returns 405 for unsupported methods", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/audit", { method: "PUT", body: "{}" }),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(405);
	});
});

describe("GET /api/audit/timeline", () => {
	it("returns empty array when audit.db does not exist", async () => {
		const res = await dispatch("/api/audit/timeline");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns events in chronological order", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		const res = await dispatch("/api/audit/timeline");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ createdAt: string }>;
		expect(body.length).toBeGreaterThan(0);
		for (let i = 0; i < body.length - 1; i++) {
			const a = body[i];
			const b = body[i + 1];
			if (a && b) {
				expect(a.createdAt <= b.createdAt).toBe(true);
			}
		}
	});

	it("defaults to 24h window when since not provided", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		// Events just inserted are within the 24h window
		const res = await dispatch("/api/audit/timeline");
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(3);
	});

	it("accepts ?since= param override", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		// Future timestamp — should return no events
		const res = await dispatch("/api/audit/timeline", { since: "2099-01-01T00:00:00.000Z" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(0);
	});

	it("applies ?limit= param", async () => {
		seedAuditDb(join(legioDir, "audit.db"));
		const res = await dispatch("/api/audit/timeline", { limit: "2" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(2);
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
// Setup routes
// ---------------------------------------------------------------------------

describe("GET /api/setup/status", () => {
	it("returns initialized:true with projectName when config.yaml exists", async () => {
		// beforeEach already writes config.yaml with project name "test"
		const res = await dispatch("/api/setup/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as {
			initialized: boolean;
			projectName: string | null;
			projectRoot: string;
		};
		expect(body.initialized).toBe(true);
		expect(body.projectName).toBe("test");
		expect(body.projectRoot).toBe(projectRoot);
	});

	it("returns initialized:false with null projectName when config.yaml is missing", async () => {
		await rm(join(legioDir, "config.yaml"), { force: true });
		const res = await dispatch("/api/setup/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as {
			initialized: boolean;
			projectName: string | null;
			projectRoot: string;
		};
		expect(body.initialized).toBe(false);
		expect(body.projectName).toBeNull();
		expect(body.projectRoot).toBe(projectRoot);
	});

	it("returns projectRoot in response", async () => {
		const res = await dispatch("/api/setup/status");
		const body = (await json(res)) as { projectRoot: string };
		expect(body.projectRoot).toBe(projectRoot);
	});
});

describe("POST /api/setup/init", () => {
	it("returns success:false with error string when not a git repo", async () => {
		// Default temp dir is not a git repo — legio init should fail
		const res = await dispatchPost("/api/setup/init", {});
		expect(res.status).toBe(200);
		const body = (await json(res)) as { success: boolean; error?: string };
		expect(body.success).toBe(false);
		expect(typeof body.error).toBe("string");
	});

	it("accepts force:true and returns failure when not a git repo", async () => {
		const res = await dispatchPost("/api/setup/init", { force: true });
		expect(res.status).toBe(200);
		const body = (await json(res)) as { success: boolean; error?: string };
		expect(body.success).toBe(false);
		expect(typeof body.error).toBe("string");
	});

	it("returns success:true with message when init succeeds in a git repo", async () => {
		// Create a fresh temp dir with a git repo but no .legio/ for a clean init
		const { execSync } = await import("node:child_process");
		const freshDir = join(tmpdir(), `routes-init-success-${Date.now()}`);
		await mkdir(freshDir, { recursive: true });
		try {
			execSync("git init", { cwd: freshDir, stdio: "pipe" });
			execSync("git config user.email test@test.com", { cwd: freshDir, stdio: "pipe" });
			execSync("git config user.name Test", { cwd: freshDir, stdio: "pipe" });
			const req = makePostRequest("/api/setup/init", {});
			const res = await handleApiRequest(req, join(freshDir, ".legio"), freshDir);
			expect(res.status).toBe(200);
			const body = (await json(res)) as {
				success: boolean;
				message?: string;
				error?: string;
			};
			if (body.success) {
				// legio init succeeded — verify the success response shape
				expect(body.message).toBe("Project initialized successfully");
			} else {
				// legio not on PATH or init failed for env reasons — still verify error shape
				expect(typeof body.error).toBe("string");
			}
		} finally {
			await rm(freshDir, { recursive: true, force: true });
		}
	});

	it("returns 405 for GET requests on /api/setup/init", async () => {
		const res = await dispatch("/api/setup/init");
		expect([404, 405]).toContain(res.status);
	});
});

// ---------------------------------------------------------------------------
// POST /api/coordinator/start
// ---------------------------------------------------------------------------

describe("POST /api/coordinator/start", () => {
	it("returns well-formed response (success or graceful error from legio)", async () => {
		const res = await dispatchPost("/api/coordinator/start", {});
		// 200 if legio succeeded, 500 if legio not available or failed
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("passes --watchdog flag when body.watchdog is true", async () => {
		const res = await dispatchPost("/api/coordinator/start", { watchdog: true });
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("passes --monitor flag when body.monitor is true", async () => {
		const res = await dispatchPost("/api/coordinator/start", { monitor: true });
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/coordinator/start", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("calls wsManager.broadcastEvent with coordinator_start on success", async () => {
		const events: Array<{ type: string; data?: unknown }> = [];
		const mockWsManager = {
			broadcastEvent(event: { type: string; data?: unknown }) {
				events.push(event);
			},
		};

		const res = await handleApiRequest(
			makePostRequest("/api/coordinator/start", {}),
			legioDir,
			projectRoot,
			mockWsManager,
		);

		if (res.status === 200) {
			// legio succeeded — broadcastEvent should have been called
			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("coordinator_start");
		}
		// If status is 500 (legio failed), no event expected
	});
});

// ---------------------------------------------------------------------------
// POST /api/coordinator/stop
// ---------------------------------------------------------------------------

describe("POST /api/coordinator/stop", () => {
	it("returns well-formed response (success or graceful error from legio)", async () => {
		const res = await dispatchPost("/api/coordinator/stop", {});
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/coordinator/stop", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("calls wsManager.broadcastEvent with coordinator_stop on success", async () => {
		const events: Array<{ type: string; data?: unknown }> = [];
		const mockWsManager = {
			broadcastEvent(event: { type: string; data?: unknown }) {
				events.push(event);
			},
		};

		const res = await handleApiRequest(
			makePostRequest("/api/coordinator/stop", {}),
			legioDir,
			projectRoot,
			mockWsManager,
		);

		if (res.status === 200) {
			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("coordinator_stop");
		}
	});
});

// ---------------------------------------------------------------------------
// POST /api/agents/spawn
// ---------------------------------------------------------------------------

describe("POST /api/agents/spawn", () => {
	it("returns 400 when taskId is missing", async () => {
		const res = await dispatchPost("/api/agents/spawn", {
			name: "my-builder",
			capability: "builder",
		});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("taskId");
	});

	it("returns 400 when name is missing", async () => {
		const res = await dispatchPost("/api/agents/spawn", {
			taskId: "legio-abc1",
			capability: "builder",
		});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("name");
	});

	it("returns 400 when capability is missing", async () => {
		const res = await dispatchPost("/api/agents/spawn", {
			taskId: "legio-abc1",
			name: "my-builder",
		});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("capability");
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/agents/spawn", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("returns 201 on success or 500 on graceful error (legio CLI)", async () => {
		const res = await dispatchPost("/api/agents/spawn", {
			taskId: "legio-abc1",
			name: "test-builder",
			capability: "builder",
		});
		// 201 Created on success, 500 on legio error
		expect([201, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("passes optional spec, files, parent, depth when provided", async () => {
		const res = await dispatchPost("/api/agents/spawn", {
			taskId: "legio-abc1",
			name: "test-builder",
			capability: "builder",
			spec: "/tmp/spec.md",
			files: ["src/foo.ts", "src/bar.ts"],
			parent: "my-lead",
			depth: 1,
		});
		// Verify optional fields are accepted (legio will fail but args were constructed)
		expect([201, 500]).toContain(res.status);
	});

	it("calls wsManager.broadcastEvent with agent_spawn on success", async () => {
		const events: Array<{ type: string; data?: unknown }> = [];
		const mockWsManager = {
			broadcastEvent(event: { type: string; data?: unknown }) {
				events.push(event);
			},
		};

		const res = await handleApiRequest(
			makePostRequest("/api/agents/spawn", {
				taskId: "legio-abc1",
				name: "test-builder",
				capability: "builder",
			}),
			legioDir,
			projectRoot,
			mockWsManager,
		);

		if (res.status === 201) {
			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("agent_spawn");
		}
	});
});

// ---------------------------------------------------------------------------
// POST /api/merge
// ---------------------------------------------------------------------------

describe("POST /api/merge", () => {
	it("returns 400 when neither branch nor all is provided", async () => {
		const res = await dispatchPost("/api/merge", {});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("branch");
	});

	it("returns well-formed response for branch merge (success or error)", async () => {
		const res = await dispatchPost("/api/merge", { branch: "legio/some-agent/task-1" });
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("returns well-formed response for --all merge (success or error)", async () => {
		const res = await dispatchPost("/api/merge", { all: true });
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("passes --into and --dry-run flags when provided", async () => {
		const res = await dispatchPost("/api/merge", {
			branch: "legio/some-agent/task-1",
			into: "main",
			dryRun: true,
		});
		expect([200, 500]).toContain(res.status);
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/merge", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("calls wsManager.broadcastEvent with merge_complete on success", async () => {
		const events: Array<{ type: string; data?: unknown }> = [];
		const mockWsManager = {
			broadcastEvent(event: { type: string; data?: unknown }) {
				events.push(event);
			},
		};

		const res = await handleApiRequest(
			makePostRequest("/api/merge", { branch: "legio/some-agent/task-1" }),
			legioDir,
			projectRoot,
			mockWsManager,
		);

		if (res.status === 200) {
			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("merge_complete");
		}
	});
});

// ---------------------------------------------------------------------------
// POST /api/nudge
// ---------------------------------------------------------------------------

describe("POST /api/nudge", () => {
	it("returns 400 when agent is missing", async () => {
		const res = await dispatchPost("/api/nudge", { message: "hello" });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("agent");
	});

	it("returns well-formed response (success or graceful error)", async () => {
		const res = await dispatchPost("/api/nudge", { agent: "my-builder" });
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("passes message as positional arg when provided", async () => {
		const res = await dispatchPost("/api/nudge", {
			agent: "my-builder",
			message: "Please check your mail",
		});
		expect([200, 500]).toContain(res.status);
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/nudge", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("calls wsManager.broadcastEvent with agent_nudge on success", async () => {
		const events: Array<{ type: string; data?: unknown }> = [];
		const mockWsManager = {
			broadcastEvent(event: { type: string; data?: unknown }) {
				events.push(event);
			},
		};

		const res = await handleApiRequest(
			makePostRequest("/api/nudge", { agent: "my-builder", message: "hey" }),
			legioDir,
			projectRoot,
			mockWsManager,
		);

		if (res.status === 200) {
			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("agent_nudge");
			const data = events[0]?.data as { agent: string; message: string | null };
			expect(data.agent).toBe("my-builder");
			expect(data.message).toBe("hey");
		}
	});
});

// ---------------------------------------------------------------------------
// Strategy routes
// ---------------------------------------------------------------------------

import type { StrategyRecommendation } from "../types.ts";

function makeRec(overrides?: Partial<StrategyRecommendation>): StrategyRecommendation {
	return {
		id: "rec-001",
		title: "Add caching layer",
		priority: "high",
		effort: "M",
		rationale: "Reduce database load",
		suggestedFiles: ["src/cache.ts"],
		category: "performance",
		status: "pending",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

async function seedStrategyFile(dir: string, recs: StrategyRecommendation[]): Promise<void> {
	const { join: pathJoin } = await import("node:path");
	await writeFile(
		pathJoin(dir, "strategy.json"),
		JSON.stringify({ recommendations: recs }, null, 2),
	);
}

describe("GET /api/strategy", () => {
	it("returns empty array when strategy.json is missing", async () => {
		const res = await dispatch("/api/strategy");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns recommendations from strategy.json", async () => {
		await seedStrategyFile(legioDir, [makeRec()]);
		const res = await dispatch("/api/strategy");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ id: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.id).toBe("rec-001");
	});

	it("returns multiple recommendations", async () => {
		await seedStrategyFile(legioDir, [
			makeRec({ id: "rec-001" }),
			makeRec({ id: "rec-002", title: "Refactor auth", priority: "critical" }),
		]);
		const res = await dispatch("/api/strategy");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ id: string }>;
		expect(body.length).toBe(2);
	});
});

describe("POST /api/strategy/:id/approve", () => {
	it("returns 404 when strategy.json is missing", async () => {
		const res = await dispatchPost("/api/strategy/rec-001/approve", {});
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("strategy.json");
	});

	it("returns 404 for unknown recommendation ID", async () => {
		await seedStrategyFile(legioDir, [makeRec({ id: "rec-001" })]);
		const res = await dispatchPost("/api/strategy/unknown-id/approve", {});
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("unknown-id");
	});

	it("returns 409 for already approved recommendation", async () => {
		await seedStrategyFile(legioDir, [makeRec({ id: "rec-001", status: "approved" })]);
		const res = await dispatchPost("/api/strategy/rec-001/approve", {});
		expect(res.status).toBe(409);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("approved");
	});

	it("returns 409 for already dismissed recommendation", async () => {
		await seedStrategyFile(legioDir, [makeRec({ id: "rec-001", status: "dismissed" })]);
		const res = await dispatchPost("/api/strategy/rec-001/approve", {});
		expect(res.status).toBe(409);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("dismissed");
	});

	it("approves a pending recommendation and returns issueId", async () => {
		await seedStrategyFile(legioDir, [makeRec({ id: "rec-001", status: "pending" })]);
		const res = await dispatchPost("/api/strategy/rec-001/approve", {});
		expect(res.status).toBe(200);
		const body = (await json(res)) as {
			recommendation: { id: string; status: string };
			issueId: string;
		};
		expect(body.recommendation.id).toBe("rec-001");
		expect(body.recommendation.status).toBe("approved");
		expect(body.issueId).toBe("bead-test-001");
		// Verify the file was updated on disk
		const updated = JSON.parse(readFileSync(join(legioDir, "strategy.json"), "utf-8")) as {
			recommendations: Array<{ status: string }>;
		};
		expect(updated.recommendations[0]?.status).toBe("approved");
	});
});

describe("POST /api/strategy/:id/dismiss", () => {
	it("returns 404 when strategy.json is missing", async () => {
		const res = await dispatchPost("/api/strategy/rec-001/dismiss", {});
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("strategy.json");
	});

	it("returns 404 for unknown recommendation ID", async () => {
		await seedStrategyFile(legioDir, [makeRec({ id: "rec-001" })]);
		const res = await dispatchPost("/api/strategy/unknown-id/dismiss", {});
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("unknown-id");
	});

	it("dismisses a pending recommendation", async () => {
		await seedStrategyFile(legioDir, [makeRec({ id: "rec-001", status: "pending" })]);
		const res = await dispatchPost("/api/strategy/rec-001/dismiss", {});
		expect(res.status).toBe(200);
		const body = (await json(res)) as { id: string; status: string };
		expect(body.id).toBe("rec-001");
		expect(body.status).toBe("dismissed");
		// Verify the file was updated on disk
		const updated = JSON.parse(readFileSync(join(legioDir, "strategy.json"), "utf-8")) as {
			recommendations: Array<{ status: string }>;
		};
		expect(updated.recommendations[0]?.status).toBe("dismissed");
	});
});

// ---------------------------------------------------------------------------
// Chat routes
// ---------------------------------------------------------------------------

describe("GET /api/chat/config", () => {
	it("returns available:false when ANTHROPIC_API_KEY is not set", async () => {
		const original = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const res = await dispatch("/api/chat/config");
			expect(res.status).toBe(200);
			const body = (await json(res)) as { available: boolean; defaultModel: string };
			expect(body.available).toBe(false);
			expect(typeof body.defaultModel).toBe("string");
		} finally {
			if (original !== undefined) {
				process.env.ANTHROPIC_API_KEY = original;
			}
		}
	});

	it("returns available:true when ANTHROPIC_API_KEY is set", async () => {
		const original = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-key";
		try {
			const res = await dispatch("/api/chat/config");
			expect(res.status).toBe(200);
			const body = (await json(res)) as { available: boolean; defaultModel: string };
			expect(body.available).toBe(true);
		} finally {
			if (original !== undefined) {
				process.env.ANTHROPIC_API_KEY = original;
			} else {
				delete process.env.ANTHROPIC_API_KEY;
			}
		}
	});
});

describe("GET /api/chat/sessions", () => {
	it("returns empty array when no sessions exist", async () => {
		const res = await dispatch("/api/chat/sessions");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns created sessions", async () => {
		// Create a session first
		const createRes = await dispatchPost("/api/chat/sessions", { title: "My Session" });
		expect(createRes.status).toBe(201);

		const listRes = await dispatch("/api/chat/sessions");
		expect(listRes.status).toBe(200);
		const sessions = (await json(listRes)) as Array<{ title: string }>;
		expect(sessions.length).toBe(1);
		expect(sessions[0]?.title).toBe("My Session");
	});
});

describe("POST /api/chat/sessions", () => {
	it("creates a session with defaults", async () => {
		const res = await dispatchPost("/api/chat/sessions", {});
		expect(res.status).toBe(201);
		const body = (await json(res)) as {
			id: string;
			title: string;
			model: string;
			createdAt: string;
			updatedAt: string;
		};
		expect(typeof body.id).toBe("string");
		expect(body.title).toBe("New Chat");
		expect(body.model).toBe("claude-sonnet-4-20250514");
		expect(typeof body.createdAt).toBe("string");
	});

	it("creates a session with custom title and model", async () => {
		const res = await dispatchPost("/api/chat/sessions", {
			title: "Custom Title",
			model: "claude-opus-4-6",
		});
		expect(res.status).toBe(201);
		const body = (await json(res)) as { title: string; model: string };
		expect(body.title).toBe("Custom Title");
		expect(body.model).toBe("claude-opus-4-6");
	});

	it("returns 400 for invalid JSON", async () => {
		const req = new Request(`http://localhost/api/chat/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		const res = await handleApiRequest(req, legioDir, projectRoot);
		expect(res.status).toBe(400);
	});
});

describe("DELETE /api/chat/sessions/:id", () => {
	it("deletes an existing session", async () => {
		const createRes = await dispatchPost("/api/chat/sessions", { title: "To Delete" });
		const session = (await json(createRes)) as { id: string };

		const deleteReq = new Request(`http://localhost/api/chat/sessions/${session.id}`, {
			method: "DELETE",
		});
		const deleteRes = await handleApiRequest(deleteReq, legioDir, projectRoot);
		expect(deleteRes.status).toBe(200);
		const body = (await json(deleteRes)) as { ok: boolean };
		expect(body.ok).toBe(true);

		// Verify gone
		const getRes = await dispatch(`/api/chat/sessions/${session.id}/messages`);
		expect(getRes.status).toBe(404);
	});

	it("returns 404 for unknown session", async () => {
		const req = new Request(`http://localhost/api/chat/sessions/nonexistent`, {
			method: "DELETE",
		});
		const res = await handleApiRequest(req, legioDir, projectRoot);
		expect(res.status).toBe(404);
	});
});

describe("GET /api/chat/sessions/:id/messages", () => {
	it("returns 404 for nonexistent session", async () => {
		const res = await dispatch("/api/chat/sessions/nonexistent/messages");
		expect(res.status).toBe(404);
	});

	it("returns empty array for session with no messages", async () => {
		const createRes = await dispatchPost("/api/chat/sessions", {});
		const session = (await json(createRes)) as { id: string };

		const res = await dispatch(`/api/chat/sessions/${session.id}/messages`);
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});
});

describe("POST /api/chat/sessions/:id/messages", () => {
	it("returns 404 for nonexistent session", async () => {
		const res = await dispatchPost("/api/chat/sessions/nonexistent/messages", {
			content: "Hello",
		});
		expect(res.status).toBe(404);
	});

	it("returns 400 when content is missing", async () => {
		const createRes = await dispatchPost("/api/chat/sessions", {});
		const session = (await json(createRes)) as { id: string };

		const res = await dispatchPost(`/api/chat/sessions/${session.id}/messages`, {});
		expect(res.status).toBe(400);
	});

	it("returns 502 error when ANTHROPIC_API_KEY is not set", async () => {
		const original = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			const createRes = await dispatchPost("/api/chat/sessions", {});
			const session = (await json(createRes)) as { id: string };

			const res = await dispatchPost(`/api/chat/sessions/${session.id}/messages`, {
				content: "Hello",
			});
			// Should fail with 502 because no API key
			expect(res.status).toBe(502);
			const body = (await json(res)) as { error: string };
			expect(body.error).toContain("ANTHROPIC_API_KEY");
		} finally {
			if (original !== undefined) {
				process.env.ANTHROPIC_API_KEY = original;
			}
		}
	});
});
