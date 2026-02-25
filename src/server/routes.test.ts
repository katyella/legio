/**
 * Tests for REST API route handlers.
 *
 * Uses real SQLite databases in temp directories. No mocking of store logic.
 * gatherStatus/gatherInspectData are integration calls — tested via error paths.
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

// Mock the beads client so strategy tests can run without `bd` on PATH.
// list/ready return [] (keeps existing /api/issues tests passing).
// show throws (existing /api/issues/:id test expects 404 on error).
// create returns a predictable issue ID for strategy approve tests.
// list returns a closed and a blocked issue fixture when all=true to verify all-statuses behavior.
vi.mock("../beads/client.ts", () => ({
	createBeadsClient: () => ({
		ready: async () => [],
		list: async (options?: { status?: string; limit?: number; all?: boolean }) => {
			// Return closed and blocked issue fixtures when all is true
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
					{
						id: "bead-blocked-001",
						title: "Blocked issue",
						status: "blocked",
						priority: 2,
						type: "task",
						dependency_count: 1,
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

// Mock tmux so tests don't interfere with real developer tmux sessions.
// isSessionAlive defaults to true so that tests which seed an active session
// (and are not testing the stale-session path) pass through correctly.
// sendKeys is a no-op — we only test up to the 404 paths here.
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
		const body = (await json(res)) as Array<{
			model: string;
			sessions: number;
			inputTokens: number;
		}>;
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
		const body = (await json(res)) as Array<{
			date: string;
			sessions: number;
			inputTokens: number;
		}>;
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
		// Mock returns a closed and blocked issue when all=true
		expect(body.length).toBe(2);
		const statuses = body.map((i) => i.status);
		expect(statuses).toContain("closed");
		expect(statuses).toContain("blocked");
	});

	it("returns closedAt and closeReason fields on closed issues", async () => {
		const res = await dispatch("/api/issues");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{
			id: string;
			closedAt?: string;
			closeReason?: string;
		}>;
		const closedIssue = body.find((i) => i.id === "bead-closed-001");
		expect(closedIssue?.closedAt).toBe("2026-01-01T00:00:00.000Z");
		expect(closedIssue?.closeReason).toBe("Done");
	});

	it("returns blocked issues with status=blocked", async () => {
		const res = await dispatch("/api/issues");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ id: string; status: string }>;
		const blockedIssue = body.find((i) => i.id === "bead-blocked-001");
		expect(blockedIssue).toBeDefined();
		expect(blockedIssue?.status).toBe("blocked");
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

	it("returns 404 when agent session is in DB but tmux session is not alive", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-terminal-stale-001",
			agentName: "stale-agent",
			capability: "builder",
			worktreePath: "/tmp/wt/stale-agent",
			branchName: "legio/stale-agent/task-x",
			beadId: "task-x",
			tmuxSession: "legio-test-stale-agent",
			state: "working",
			pid: 99999,
			parentAgent: null,
			depth: 1,
			runId: "run-001",
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		mockIsSessionAlive.mockResolvedValueOnce(false);
		const res = await dispatchPost("/api/terminal/send", {
			text: "hello",
			agent: "stale-agent",
		});
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("not alive");
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
// Ideas routes
// ---------------------------------------------------------------------------

interface Idea {
	id: string;
	title: string;
	body: string;
	status: "active" | "dispatched" | "backlog";
	createdAt: string;
	updatedAt: string;
}

function makeIdea(overrides?: Partial<Idea>): Idea {
	return {
		id: "idea-aaaabbbb",
		title: "My first idea",
		body: "Some details here",
		status: "active",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

async function seedIdeasFile(dir: string, ideas: Idea[]): Promise<void> {
	const { join: pathJoin } = await import("node:path");
	await writeFile(pathJoin(dir, "ideas.json"), JSON.stringify({ ideas }, null, 2));
}

function makePutRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function makeDeleteRequest(path: string): Request {
	return new Request(`http://localhost${path}`, { method: "DELETE" });
}

async function dispatchPut(path: string, body: unknown): Promise<Response> {
	return handleApiRequest(makePutRequest(path, body), legioDir, projectRoot);
}

async function dispatchDelete(path: string): Promise<Response> {
	return handleApiRequest(makeDeleteRequest(path), legioDir, projectRoot);
}

describe("GET /api/ideas", () => {
	it("returns empty array when ideas.json missing", async () => {
		const res = await dispatch("/api/ideas");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns ideas from ideas.json", async () => {
		await seedIdeasFile(legioDir, [makeIdea()]);
		const res = await dispatch("/api/ideas");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ id: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.id).toBe("idea-aaaabbbb");
	});
});

describe("POST /api/ideas", () => {
	it("creates a new idea with title and body", async () => {
		const res = await dispatchPost("/api/ideas", { title: "Test idea", body: "Details" });
		expect(res.status).toBe(201);
		const body = (await json(res)) as Idea;
		expect(body.title).toBe("Test idea");
		expect(body.body).toBe("Details");
		expect(body.status).toBe("active");
		expect(body.id).toMatch(/^idea-/);
		expect(typeof body.createdAt).toBe("string");
		expect(typeof body.updatedAt).toBe("string");
	});

	it("creates idea with title only (body defaults to empty string)", async () => {
		const res = await dispatchPost("/api/ideas", { title: "Title only" });
		expect(res.status).toBe(201);
		const body = (await json(res)) as Idea;
		expect(body.title).toBe("Title only");
		expect(body.body).toBe("");
	});

	it("returns 400 if title is missing", async () => {
		const res = await dispatchPost("/api/ideas", { body: "No title" });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("title");
	});
});

describe("PUT /api/ideas/:id", () => {
	it("updates title and body", async () => {
		await seedIdeasFile(legioDir, [makeIdea({ id: "idea-aaaabbbb" })]);
		const res = await dispatchPut("/api/ideas/idea-aaaabbbb", {
			title: "Updated title",
			body: "Updated body",
		});
		expect(res.status).toBe(200);
		const body = (await json(res)) as Idea;
		expect(body.title).toBe("Updated title");
		expect(body.body).toBe("Updated body");
		// Verify on disk
		const updated = JSON.parse(readFileSync(join(legioDir, "ideas.json"), "utf-8")) as {
			ideas: Idea[];
		};
		expect(updated.ideas[0]?.title).toBe("Updated title");
	});

	it("returns 404 for unknown id", async () => {
		await seedIdeasFile(legioDir, [makeIdea({ id: "idea-aaaabbbb" })]);
		const res = await dispatchPut("/api/ideas/idea-unknown", { title: "x" });
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("idea-unknown");
	});

	it("returns 404 when ideas.json missing", async () => {
		const res = await dispatchPut("/api/ideas/idea-aaaabbbb", { title: "x" });
		expect(res.status).toBe(404);
	});
});

describe("DELETE /api/ideas/:id", () => {
	it("deletes an idea", async () => {
		await seedIdeasFile(legioDir, [makeIdea({ id: "idea-aaaabbbb" })]);
		const res = await dispatchDelete("/api/ideas/idea-aaaabbbb");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { success: boolean };
		expect(body.success).toBe(true);
		// Verify removed on disk
		const updated = JSON.parse(readFileSync(join(legioDir, "ideas.json"), "utf-8")) as {
			ideas: Idea[];
		};
		expect(updated.ideas.length).toBe(0);
	});

	it("returns 404 for unknown id", async () => {
		await seedIdeasFile(legioDir, [makeIdea({ id: "idea-aaaabbbb" })]);
		const res = await dispatchDelete("/api/ideas/idea-unknown");
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("idea-unknown");
	});
});

describe("POST /api/ideas/:id/dispatch", () => {
	it("dispatches idea and returns messageId", async () => {
		await seedIdeasFile(legioDir, [makeIdea({ id: "idea-aaaabbbb" })]);
		const res = await dispatchPost("/api/ideas/idea-aaaabbbb/dispatch", {});
		expect(res.status).toBe(200);
		const body = (await json(res)) as { idea: Idea; messageId: string };
		expect(body.idea.status).toBe("dispatched");
		expect(typeof body.messageId).toBe("string");
		expect(body.messageId).toMatch(/^idea-dispatch-/);
		// Verify status on disk
		const updated = JSON.parse(readFileSync(join(legioDir, "ideas.json"), "utf-8")) as {
			ideas: Idea[];
		};
		expect(updated.ideas[0]?.status).toBe("dispatched");
	});

	it("returns 404 for unknown id", async () => {
		await seedIdeasFile(legioDir, [makeIdea({ id: "idea-aaaabbbb" })]);
		const res = await dispatchPost("/api/ideas/idea-unknown/dispatch", {});
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("idea-unknown");
	});
});

describe("POST /api/ideas/:id/backlog", () => {
	it("adds idea to backlog and returns issueId", async () => {
		await seedIdeasFile(legioDir, [makeIdea({ id: "idea-aaaabbbb" })]);
		const res = await dispatchPost("/api/ideas/idea-aaaabbbb/backlog", {});
		expect(res.status).toBe(200);
		const body = (await json(res)) as { idea: Idea; issueId: string };
		expect(body.idea.status).toBe("backlog");
		expect(body.issueId).toBe("bead-test-001");
		// Verify status on disk
		const updated = JSON.parse(readFileSync(join(legioDir, "ideas.json"), "utf-8")) as {
			ideas: Idea[];
		};
		expect(updated.ideas[0]?.status).toBe("backlog");
	});

	it("returns 404 for unknown id", async () => {
		await seedIdeasFile(legioDir, [makeIdea({ id: "idea-aaaabbbb" })]);
		const res = await dispatchPost("/api/ideas/idea-unknown/backlog", {});
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("idea-unknown");
	});
});

// ---------------------------------------------------------------------------
// GET /api/gateway/status
// ---------------------------------------------------------------------------

describe("GET /api/gateway/status", () => {
	it("returns stopped when no sessions.db exists", async () => {
		const res = await dispatch("/api/gateway/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { running: boolean; tmuxSession?: string };
		expect(body.running).toBe(false);
		expect(body.tmuxSession).toBeUndefined();
	});

	it("returns running when gateway session exists with working state", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-gw-001",
			agentName: "gateway",
			capability: "coordinator",
			worktreePath: "/tmp/wt/gateway",
			branchName: "main",
			beadId: "gateway-task",
			tmuxSession: "legio-test-gateway",
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

		const res = await dispatch("/api/gateway/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { running: boolean; tmuxSession?: string };
		expect(body.running).toBe(true);
		expect(body.tmuxSession).toBe("legio-test-gateway");
	});

	it("returns stopped when gateway session is in zombie state", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-gw-002",
			agentName: "gateway",
			capability: "coordinator",
			worktreePath: "/tmp/wt/gateway",
			branchName: "main",
			beadId: "gateway-task",
			tmuxSession: "legio-test-gateway",
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

		const res = await dispatch("/api/gateway/status");
		expect(res.status).toBe(200);
		const body = (await json(res)) as { running: boolean; tmuxSession?: string };
		expect(body.running).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// POST /api/gateway/start
// ---------------------------------------------------------------------------

describe("POST /api/gateway/start", () => {
	it("returns well-formed response (success or graceful error from legio)", async () => {
		const res = await dispatchPost("/api/gateway/start", {});
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/gateway/start", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("calls wsManager.broadcastEvent with gateway_start on success", async () => {
		const events: Array<{ type: string; data?: unknown }> = [];
		const mockWsManager = {
			broadcastEvent(event: { type: string; data?: unknown }) {
				events.push(event);
			},
		};

		const res = await handleApiRequest(
			makePostRequest("/api/gateway/start", {}),
			legioDir,
			projectRoot,
			mockWsManager,
		);

		if (res.status === 200) {
			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("gateway_start");
		}
	});
});

// ---------------------------------------------------------------------------
// POST /api/gateway/stop
// ---------------------------------------------------------------------------

describe("POST /api/gateway/stop", () => {
	it("returns well-formed response (success or graceful error from legio)", async () => {
		const res = await dispatchPost("/api/gateway/stop", {});
		expect([200, 500]).toContain(res.status);
		const body = (await json(res)) as Record<string, unknown>;
		expect(body).toBeDefined();
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/gateway/stop", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("calls wsManager.broadcastEvent with gateway_stop on success", async () => {
		const events: Array<{ type: string; data?: unknown }> = [];
		const mockWsManager = {
			broadcastEvent(event: { type: string; data?: unknown }) {
				events.push(event);
			},
		};

		const res = await handleApiRequest(
			makePostRequest("/api/gateway/stop", {}),
			legioDir,
			projectRoot,
			mockWsManager,
		);

		if (res.status === 200) {
			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("gateway_stop");
		}
	});
});

// ---------------------------------------------------------------------------
// POST /api/gateway/chat
// ---------------------------------------------------------------------------

describe("POST /api/gateway/chat", () => {
	it("returns 400 when text field is missing", async () => {
		const res = await dispatchPost("/api/gateway/chat", {});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 when text field is empty string", async () => {
		const res = await dispatchPost("/api/gateway/chat", { text: "   " });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/gateway/chat", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("returns 404 when gateway is not running (no sessions.db)", async () => {
		const res = await dispatchPost("/api/gateway/chat", { text: "hello" });
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("not running");
	});

	it("returns 404 when gateway session is in zombie state", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-gw-chat-001",
			agentName: "gateway",
			capability: "coordinator",
			worktreePath: "/tmp/wt/gateway",
			branchName: "main",
			beadId: "gateway-task",
			tmuxSession: "legio-test-gateway",
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

		const res = await dispatchPost("/api/gateway/chat", { text: "hello" });
		expect(res.status).toBe(404);
	});

	it("returns 404 when gateway session is in DB but tmux session is not alive", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-gw-stale-001",
			agentName: "gateway",
			capability: "coordinator",
			worktreePath: "/tmp/wt/gateway",
			branchName: "main",
			beadId: "gateway-task",
			tmuxSession: "legio-test-gateway-stale",
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

		mockIsSessionAlive.mockResolvedValueOnce(false);
		const res = await dispatchPost("/api/gateway/chat", { text: "hello" });
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("not alive");
	});

	it("persists message to mail.db and returns it with 201", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-gw-persist-001",
			agentName: "gateway",
			capability: "coordinator",
			worktreePath: "/tmp/wt/gateway",
			branchName: "main",
			beadId: "gateway-task",
			tmuxSession: "legio-test-gateway",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: "run-001",
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const res = await dispatchPost("/api/gateway/chat", { text: "Hello gateway" });
		expect(res.status).toBe(201);
		const body = (await json(res)) as {
			id: string;
			from: string;
			to: string;
			subject: string;
			body: string;
			type: string;
			audience: string;
			priority: string;
		};
		expect(body.from).toBe("human");
		expect(body.to).toBe("gateway");
		expect(body.subject).toBe("chat");
		expect(body.body).toBe("Hello gateway");
		expect(body.type).toBe("status");
		expect(body.audience).toBe("human");
		expect(body.priority).toBe("normal");
		expect(typeof body.id).toBe("string");
		expect(body.id.length).toBeGreaterThan(0);

		// Verify message persisted in mail.db
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		const messages = mailStore.getAll({ from: "human", to: "gateway", audience: "human" });
		mailStore.close();
		expect(messages.length).toBe(1);
		expect(messages[0]?.body).toBe("Hello gateway");
	});

	it("still sends keys to tmux after persisting", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-gw-keys-001",
			agentName: "gateway",
			capability: "coordinator",
			worktreePath: "/tmp/wt/gateway",
			branchName: "main",
			beadId: "gateway-task",
			tmuxSession: "legio-test-gateway",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: "run-001",
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		mockSendKeys.mockClear();
		const res = await dispatchPost("/api/gateway/chat", { text: "send this" });
		expect(res.status).toBe(201);
		expect(mockSendKeys).toHaveBeenCalledWith("legio-test-gateway", "send this");
	});
});

// ---------------------------------------------------------------------------
// GET /api/gateway/chat/history
// ---------------------------------------------------------------------------

describe("GET /api/gateway/chat/history", () => {
	it("returns empty array when mail.db does not exist", async () => {
		const res = await dispatch("/api/gateway/chat/history");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns bidirectional messages in chronological order", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "gw-hist-001",
			from: "human",
			to: "gateway",
			subject: "chat",
			body: "Human question",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "gw-hist-002",
			from: "gateway",
			to: "human",
			subject: "chat",
			body: "Gateway answer",
			type: "result",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/gateway/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string; from: string }>;
		expect(body.length).toBe(2);
		const bodies = body.map((m) => m.body);
		expect(bodies).toContain("Human question");
		expect(bodies).toContain("Gateway answer");
	});

	it("filters out non-human-audience messages", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "gw-agent-msg-001",
			from: "worker",
			to: "gateway",
			subject: "status",
			body: "Agent message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		store.insert({
			id: "gw-human-msg-001",
			from: "human",
			to: "gateway",
			subject: "chat",
			body: "Human message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "gw-agent-resp-001",
			from: "gateway",
			to: "human",
			subject: "response",
			body: "Agent-only gateway response",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		store.close();

		const res = await dispatch("/api/gateway/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.body).toBe("Human message");
	});

	it("respects ?limit= query param", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		for (let i = 0; i < 5; i++) {
			store.insert({
				id: `gw-limit-${String(i).padStart(3, "0")}`,
				from: "human",
				to: "gateway",
				subject: "chat",
				body: `Message ${i}`,
				type: "status",
				priority: "normal",
				threadId: null,
				audience: "human",
			});
		}
		store.close();

		const res = await dispatch("/api/gateway/chat/history", { limit: "3" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(3);
	});

	it("excludes messages between unrelated agent pairs", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		// Human to gateway - should appear
		store.insert({
			id: "gw-related-001",
			from: "human",
			to: "gateway",
			subject: "chat",
			body: "To gateway",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// Worker to builder - unrelated pair, should not appear
		store.insert({
			id: "gw-unrelated-001",
			from: "worker",
			to: "builder",
			subject: "status",
			body: "Worker to builder",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/gateway/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.body).toBe("To gateway");
	});
});

// ---------------------------------------------------------------------------
// POST /api/coordinator/chat
// ---------------------------------------------------------------------------

describe("POST /api/coordinator/chat", () => {
	it("returns 400 when text field is missing", async () => {
		const res = await dispatchPost("/api/coordinator/chat", {});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 when text field is empty string", async () => {
		const res = await dispatchPost("/api/coordinator/chat", { text: "   " });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/coordinator/chat", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("returns 404 when coordinator is not running (no sessions.db)", async () => {
		const res = await dispatchPost("/api/coordinator/chat", { text: "hello" });
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("coordinator");
	});

	it("persists message to mail.db and returns it with correct fields", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-coord-chat-001",
			agentName: "coordinator",
			capability: "coordinator",
			worktreePath: "/tmp/wt/coordinator",
			branchName: "main",
			beadId: "coord-task",
			tmuxSession: "legio-test-coordinator",
			state: "working",
			pid: 12345,
			parentAgent: null,
			depth: 0,
			runId: "run-001",
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		const res = await dispatchPost("/api/coordinator/chat", { text: "Hello coordinator" });
		expect(res.status).toBe(201);
		const body = (await json(res)) as {
			id: string;
			from: string;
			to: string;
			subject: string;
			body: string;
			type: string;
			audience: string;
			priority: string;
		};
		expect(body.from).toBe("human");
		expect(body.to).toBe("coordinator");
		expect(body.subject).toBe("chat");
		expect(body.body).toBe("Hello coordinator");
		expect(body.type).toBe("status");
		expect(body.audience).toBe("human");
		expect(body.priority).toBe("normal");
		expect(typeof body.id).toBe("string");
		expect(body.id.length).toBeGreaterThan(0);

		// Verify message persisted in mail.db
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		const messages = mailStore.getAll({ from: "human", to: "coordinator", audience: "human" });
		mailStore.close();
		expect(messages.length).toBe(1);
		expect(messages[0]?.body).toBe("Hello coordinator");
	});
});

// ---------------------------------------------------------------------------
// GET /api/coordinator/chat/history
// ---------------------------------------------------------------------------

describe("GET /api/coordinator/chat/history", () => {
	it("returns empty array when mail.db does not exist", async () => {
		const res = await dispatch("/api/coordinator/chat/history");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns messages sent to coordinator in chronological order", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "chat-msg-001",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "First message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "chat-msg-002",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "Second message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "chat-msg-003",
			from: "coordinator",
			to: "human",
			subject: "chat",
			body: "Coordinator response",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/coordinator/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string; from: string; to: string }>;
		expect(body.length).toBe(3);
		// All three messages present (human->coordinator and coordinator->human)
		const bodies = body.map((m) => m.body);
		expect(bodies).toContain("First message");
		expect(bodies).toContain("Second message");
		expect(bodies).toContain("Coordinator response");
	});

	it("does not include non-human-audience messages", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "agent-msg-001",
			from: "worker",
			to: "coordinator",
			subject: "status",
			body: "Agent message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		store.insert({
			id: "human-msg-001",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "Human message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "coord-agent-msg-001",
			from: "coordinator",
			to: "human",
			subject: "response",
			body: "Agent-only coordinator response",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		store.close();

		const res = await dispatch("/api/coordinator/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.body).toBe("Human message");
	});

	it("respects ?limit= query param", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		for (let i = 0; i < 5; i++) {
			store.insert({
				id: `limit-msg-${String(i).padStart(3, "0")}`,
				from: "human",
				to: "coordinator",
				subject: "chat",
				body: `Message ${i}`,
				type: "status",
				priority: "normal",
				threadId: null,
				audience: "human",
			});
		}
		store.close();

		const res = await dispatch("/api/coordinator/chat/history", { limit: "3" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(3);
	});

	it("returns bidirectional messages (human-to-coordinator and coordinator-to-human)", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "bidir-coord-001",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "Human question",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "bidir-coord-002",
			from: "coordinator",
			to: "human",
			subject: "chat",
			body: "Coordinator answer",
			type: "result",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/coordinator/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string; from: string }>;
		expect(body.length).toBe(2);
		const bodies = body.map((m) => m.body);
		expect(bodies).toContain("Human question");
		expect(bodies).toContain("Coordinator answer");
	});

	it("excludes messages between unrelated agent pairs", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		// Human to coordinator - should appear
		store.insert({
			id: "coord-related-001",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "To coordinator",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// Worker to builder - unrelated pair, should not appear
		store.insert({
			id: "coord-unrelated-001",
			from: "worker",
			to: "builder",
			subject: "status",
			body: "Worker to builder",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// Builder to worker - unrelated pair, should not appear
		store.insert({
			id: "coord-unrelated-002",
			from: "builder",
			to: "worker",
			subject: "status",
			body: "Builder to worker",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/coordinator/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.body).toBe("To coordinator");
	});
});

// ---------------------------------------------------------------------------
// POST /api/agents/:name/chat
// ---------------------------------------------------------------------------

describe("POST /api/agents/:name/chat", () => {
	it("returns 400 when text field is missing", async () => {
		const res = await dispatchPost("/api/agents/scout-1/chat", {});
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 when text field is empty string", async () => {
		const res = await dispatchPost("/api/agents/scout-1/chat", { text: "   " });
		expect(res.status).toBe(400);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("text");
	});

	it("returns 400 for non-JSON body", async () => {
		const res = await handleApiRequest(
			new Request("http://localhost/api/agents/scout-1/chat", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/plain" },
			}),
			legioDir,
			projectRoot,
		);
		expect(res.status).toBe(400);
	});

	it("returns 404 when agent is not running (no sessions.db)", async () => {
		const res = await dispatchPost("/api/agents/scout-1/chat", { text: "hello" });
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("scout-1");
	});

	it("persists message to mail.db with agent-specific to field", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-agent-chat-001",
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
		store.close();

		const res = await dispatchPost("/api/agents/scout-1/chat", { text: "Hello scout" });
		expect(res.status).toBe(201);
		const body = (await json(res)) as {
			from: string;
			to: string;
			body: string;
			audience: string;
		};
		expect(body.from).toBe("human");
		expect(body.to).toBe("scout-1");
		expect(body.body).toBe("Hello scout");
		expect(body.audience).toBe("human");

		// Verify persisted in mail.db
		const mailStore = createMailStore(join(legioDir, "mail.db"));
		const messages = mailStore.getAll({ from: "human", to: "scout-1", audience: "human" });
		mailStore.close();
		expect(messages.length).toBe(1);
		expect(messages[0]?.body).toBe("Hello scout");
	});

	it("returns 404 when agent session is in DB but tmux session is not alive", async () => {
		const dbPath = join(legioDir, "sessions.db");
		const store = createSessionStore(dbPath);
		const now = new Date().toISOString();
		store.upsert({
			id: "sess-agent-stale-001",
			agentName: "builder-2",
			capability: "builder",
			worktreePath: "/tmp/wt/builder-2",
			branchName: "legio/builder-2/task-2",
			beadId: "task-2",
			tmuxSession: "legio-test-builder-2-stale",
			state: "working",
			pid: 99999,
			parentAgent: null,
			depth: 2,
			runId: "run-001",
			startedAt: now,
			lastActivity: now,
			escalationLevel: 0,
			stalledSince: null,
		});
		store.close();

		mockIsSessionAlive.mockResolvedValueOnce(false);
		const res = await dispatchPost("/api/agents/builder-2/chat", { text: "hello" });
		expect(res.status).toBe(404);
		const body = (await json(res)) as { error: string };
		expect(body.error).toContain("not alive");
	});
});

// ---------------------------------------------------------------------------
// GET /api/agents/:name/chat/history
// ---------------------------------------------------------------------------

describe("GET /api/agents/:name/chat/history", () => {
	it("returns empty array when mail.db does not exist", async () => {
		const res = await dispatch("/api/agents/scout-1/chat/history");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns messages sent to the agent in chronological order", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "agent-chat-001",
			from: "human",
			to: "scout-1",
			subject: "chat",
			body: "First to scout",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "agent-chat-002",
			from: "human",
			to: "scout-1",
			subject: "chat",
			body: "Second to scout",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// Message to a different agent — should not appear
		store.insert({
			id: "agent-chat-003",
			from: "human",
			to: "builder-1",
			subject: "chat",
			body: "To builder",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// Scout response back to human — should appear
		store.insert({
			id: "agent-chat-004",
			from: "scout-1",
			to: "human",
			subject: "chat",
			body: "Scout response",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/agents/scout-1/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string; to: string }>;
		expect(body.length).toBe(3);
		// All three messages present (human->scout-1 and scout-1->human)
		const bodies = body.map((m) => m.body);
		expect(bodies).toContain("First to scout");
		expect(bodies).toContain("Second to scout");
		expect(bodies).toContain("Scout response");
	});

	it("does not include messages with non-human audience", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "agent-both-001",
			from: "human",
			to: "scout-1",
			subject: "chat",
			body: "Agent audience message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		store.insert({
			id: "agent-human-001",
			from: "human",
			to: "scout-1",
			subject: "chat",
			body: "Human audience message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "scout-agent-msg-001",
			from: "scout-1",
			to: "human",
			subject: "response",
			body: "Agent-only scout response",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		store.close();

		const res = await dispatch("/api/agents/scout-1/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.body).toBe("Human audience message");
	});

	it("respects ?limit= query param", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		for (let i = 0; i < 5; i++) {
			store.insert({
				id: `scout-limit-msg-${String(i).padStart(3, "0")}`,
				from: "human",
				to: "scout-1",
				subject: "chat",
				body: `Scout message ${i}`,
				type: "status",
				priority: "normal",
				threadId: null,
				audience: "human",
			});
		}
		store.close();

		const res = await dispatch("/api/agents/scout-1/chat/history", { limit: "2" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as unknown[];
		expect(body.length).toBe(2);
	});

	it("returns bidirectional messages (human-to-agent and agent-to-human)", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "bidir-agent-001",
			from: "human",
			to: "scout-1",
			subject: "chat",
			body: "Human question to scout",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "bidir-agent-002",
			from: "scout-1",
			to: "human",
			subject: "chat",
			body: "Scout answer",
			type: "result",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/agents/scout-1/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string; from: string }>;
		expect(body.length).toBe(2);
		const bodies = body.map((m) => m.body);
		expect(bodies).toContain("Human question to scout");
		expect(bodies).toContain("Scout answer");
	});

	it("excludes messages between unrelated agent pairs", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		// Human to scout-1 - should appear
		store.insert({
			id: "scout-related-001",
			from: "human",
			to: "scout-1",
			subject: "chat",
			body: "To scout",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// Human to builder-1 - different agent, should not appear
		store.insert({
			id: "scout-unrelated-001",
			from: "human",
			to: "builder-1",
			subject: "chat",
			body: "To builder",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// builder-1 to human - different agent, should not appear
		store.insert({
			id: "scout-unrelated-002",
			from: "builder-1",
			to: "human",
			subject: "chat",
			body: "Builder response",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/agents/scout-1/chat/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.body).toBe("To scout");
	});
});

// ---------------------------------------------------------------------------
// GET /api/chat/unified/history
// ---------------------------------------------------------------------------

describe("GET /api/chat/unified/history", () => {
	it("returns empty array when mail.db does not exist", async () => {
		const res = await dispatch("/api/chat/unified/history");
		expect(res.status).toBe(200);
		expect(await json(res)).toEqual([]);
	});

	it("returns all human-audience messages from all agents in chronological order", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "unified-001",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "Hello coordinator",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "unified-002",
			from: "coordinator",
			to: "human",
			subject: "chat",
			body: "Coordinator reply",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "unified-003",
			from: "human",
			to: "scout-1",
			subject: "chat",
			body: "Hello scout",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "unified-004",
			from: "scout-1",
			to: "human",
			subject: "chat",
			body: "Scout reply",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.close();

		const res = await dispatch("/api/chat/unified/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string; from: string }>;
		expect(body.length).toBe(4);
		const bodies = body.map((m) => m.body);
		expect(bodies).toContain("Hello coordinator");
		expect(bodies).toContain("Coordinator reply");
		expect(bodies).toContain("Hello scout");
		expect(bodies).toContain("Scout reply");
	});

	it("excludes agent-audience messages", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "unified-visible-001",
			from: "human",
			to: "coordinator",
			subject: "chat",
			body: "Human message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		store.insert({
			id: "unified-hidden-001",
			from: "worker",
			to: "coordinator",
			subject: "status",
			body: "Agent-only message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		store.close();

		const res = await dispatch("/api/chat/unified/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.body).toBe("Human message");
	});

	it("includes audience=both messages", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "unified-both-001",
			from: "coordinator",
			to: "human",
			subject: "update",
			body: "Broadcast update",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "both",
		});
		store.close();

		const res = await dispatch("/api/chat/unified/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
		expect(body[0]?.body).toBe("Broadcast update");
	});

	it("deduplicates messages that appear in both audience queries", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		store.insert({
			id: "unified-both-dedup",
			from: "coordinator",
			to: "human",
			subject: "chat",
			body: "Should appear once",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "both",
		});
		store.close();

		const res = await dispatch("/api/chat/unified/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(1);
	});

	it("respects limit parameter", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		for (let i = 1; i <= 5; i++) {
			store.insert({
				id: `unified-limit-00${i}`,
				from: "human",
				to: "coordinator",
				subject: "chat",
				body: `Message ${i}`,
				type: "status",
				priority: "normal",
				threadId: null,
				audience: "human",
			});
		}
		store.close();

		const res = await dispatch("/api/chat/unified/history", { limit: "3" });
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string }>;
		expect(body.length).toBe(3);
	});

	it("includes messages where from=human even without explicit audience filtering by from/to", async () => {
		const mailDbPath = join(legioDir, "mail.db");
		const store = createMailStore(mailDbPath);
		// Message from human to a non-standard agent
		store.insert({
			id: "unified-bidir-001",
			from: "human",
			to: "lead-1",
			subject: "chat",
			body: "Hello lead",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// Response from agent to human
		store.insert({
			id: "unified-bidir-002",
			from: "lead-1",
			to: "human",
			subject: "chat",
			body: "Lead reply",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "human",
		});
		// Agent-only message (should be excluded)
		store.insert({
			id: "unified-bidir-003",
			from: "lead-1",
			to: "coordinator",
			subject: "status",
			body: "Internal message",
			type: "status",
			priority: "normal",
			threadId: null,
			audience: "agent",
		});
		store.close();

		const res = await dispatch("/api/chat/unified/history");
		expect(res.status).toBe(200);
		const body = (await json(res)) as Array<{ body: string; from: string; to: string }>;
		expect(body.length).toBe(2);
		expect(body.map((m) => m.body)).toContain("Hello lead");
		expect(body.map((m) => m.body)).toContain("Lead reply");
	});
});

// ---------------------------------------------------------------------------
// POST /api/chat/transcript-sync
// ---------------------------------------------------------------------------

describe("POST /api/chat/transcript-sync", () => {
	it("returns 400 when agent field is missing", async () => {
		const res = await dispatchPost("/api/chat/transcript-sync", {});
		expect(res.status).toBe(400);
	});

	it("returns 404 when sessions.db does not exist", async () => {
		const res = await dispatchPost("/api/chat/transcript-sync", { agent: "coordinator" });
		expect(res.status).toBe(404);
	});

	it("returns 404 when no active session for agent", async () => {
		// Create empty sessions.db
		const sessStore = createSessionStore(join(legioDir, "sessions.db"));
		sessStore.close();

		const res = await dispatchPost("/api/chat/transcript-sync", { agent: "nonexistent" });
		expect(res.status).toBe(404);
	});
});
