/**
 * REST API route handlers for the legio web UI server.
 *
 * Single exported function `handleApiRequest` dispatches all /api/* routes
 * to the appropriate store. Each handler opens and closes its store within
 * the request — per-request store lifecycle with no shared state.
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutopilotInstance } from "../autopilot/daemon.ts";
import { createBeadsClient } from "../beads/client.ts";
import { gatherInspectData } from "../commands/inspect.ts";
import { gatherStatus } from "../commands/status.ts";
import { loadConfig } from "../config.ts";
import { createEventStore } from "../events/store.ts";
import { createMailStore } from "../mail/store.ts";
import { createMergeQueue } from "../merge/queue.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { createRunStore, createSessionStore } from "../sessions/store.ts";
import type { EventLevel, MailMessage, MergeEntry, RunStatus, StrategyFile } from "../types.ts";
import { MAIL_MESSAGE_TYPES } from "../types.ts";
import { sendKeys } from "../worktree/tmux.ts";
import { createAuditStore } from "./audit-store.ts";

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

/**
 * Match a URL path against a pattern with named params (e.g. `/api/agents/:name`).
 * Returns a Record of captured param values, or null if not matched.
 */
function matchRoute(path: string, pattern: string): Record<string, string> | null {
	const regexStr = pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)");
	const match = new RegExp(`^${regexStr}$`).exec(path);
	return match?.groups ?? null;
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function errorResponse(message: string, status = 500): Response {
	return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

/**
 * Load the orchestrator's registered tmux session name from orchestrator-tmux.json.
 * Written by `legio prime` at SessionStart when running inside tmux.
 */
async function loadOrchestratorTmuxSession(projectRoot: string): Promise<string | null> {
	const regPath = join(projectRoot, ".legio", "orchestrator-tmux.json");
	if (!(await fileExists(regPath))) {
		return null;
	}
	try {
		const text = await readFile(regPath, "utf-8");
		const reg = JSON.parse(text) as { tmuxSession?: string };
		return reg.tmuxSession ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolve the tmux session name for an agent.
 *
 * For regular agents, looks up the SessionStore.
 * For "coordinator" or "orchestrator", falls back to orchestrator-tmux.json.
 */
async function resolveTerminalSession(
	legioDir: string,
	projectRoot: string,
	agentName: string,
): Promise<string | null> {
	const dbPath = join(legioDir, "sessions.db");
	if (await fileExists(dbPath)) {
		const { store } = openSessionStore(legioDir);
		try {
			const session = store.getByName(agentName);
			if (session && session.state !== "zombie" && session.state !== "completed") {
				return session.tmuxSession;
			}
		} finally {
			store.close();
		}
	}

	// Fallback for coordinator/orchestrator: check orchestrator-tmux.json
	if (agentName === "coordinator" || agentName === "orchestrator") {
		return await loadOrchestratorTmuxSession(projectRoot);
	}

	return null;
}

/**
 * Capture the output of a tmux pane.
 *
 * @param sessionName - Tmux session name
 * @param lines - Number of history lines to capture
 * @returns Captured pane output, or null if capture failed
 */
async function captureTmuxPane(sessionName: string, lines: number): Promise<string | null> {
	return new Promise((resolve) => {
		const proc = spawn("tmux", ["capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		proc.stdout.on("data", (chunk: Buffer) => {
			out += chunk;
		});
		proc.on("close", (code: number | null) => {
			resolve(code === 0 ? out.trim() : null);
		});
	});
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleApiRequest(
	request: Request,
	legioDir: string,
	projectRoot: string,
	autopilot?: AutopilotInstance | null,
	wsManager?: { broadcastEvent(event: { type: string; data?: unknown }): void } | null,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// -------------------------------------------------------------------------
	// POST /api/mail/send
	// -------------------------------------------------------------------------

	if (request.method === "POST" && path === "/api/mail/send") {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return errorResponse("Invalid JSON body", 400);
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return errorResponse("Request body must be a JSON object", 400);
		}
		const obj = body as Record<string, unknown>;

		if (typeof obj.from !== "string" || !obj.from) {
			return errorResponse("Missing required field: from", 400);
		}
		if (typeof obj.to !== "string" || !obj.to) {
			return errorResponse("Missing required field: to", 400);
		}
		if (typeof obj.subject !== "string" || !obj.subject) {
			return errorResponse("Missing required field: subject", 400);
		}
		if (typeof obj.body !== "string") {
			return errorResponse("Missing required field: body", 400);
		}

		const typeRaw = typeof obj.type === "string" ? obj.type : "status";
		const mailType: MailMessage["type"] = (MAIL_MESSAGE_TYPES as readonly string[]).includes(
			typeRaw,
		)
			? (typeRaw as MailMessage["type"])
			: "status";

		const priorityRaw = typeof obj.priority === "string" ? obj.priority : "normal";
		const validPriorities: readonly string[] = ["low", "normal", "high", "urgent"];
		const priority: MailMessage["priority"] = validPriorities.includes(priorityRaw)
			? (priorityRaw as MailMessage["priority"])
			: "normal";

		const threadId = typeof obj.threadId === "string" ? obj.threadId : null;

		const dbPath = join(legioDir, "mail.db");
		const store = createMailStore(dbPath);
		try {
			const message = store.insert({
				id: "",
				from: obj.from,
				to: obj.to,
				subject: obj.subject,
				body: obj.body,
				type: mailType,
				priority,
				threadId,
			});
			wsManager?.broadcastEvent({ type: "mail_new", data: message });
			return jsonResponse(message, 201);
		} catch (err) {
			return errorResponse(
				`Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			store.close();
		}
	}

	// -------------------------------------------------------------------------
	// POST /api/terminal/send
	// -------------------------------------------------------------------------

	if (request.method === "POST" && path === "/api/terminal/send") {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return errorResponse("Invalid JSON body", 400);
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return errorResponse("Request body must be a JSON object", 400);
		}
		const obj = body as Record<string, unknown>;

		if (typeof obj.text !== "string" || obj.text.trim().length === 0) {
			return errorResponse("Missing or empty required field: text", 400);
		}

		const agentName = typeof obj.agent === "string" && obj.agent ? obj.agent : "coordinator";

		const tmuxSession = await resolveTerminalSession(legioDir, projectRoot, agentName);
		if (!tmuxSession) {
			return errorResponse(`Cannot resolve tmux session for agent "${agentName}"`, 404);
		}

		try {
			await sendKeys(tmuxSession, obj.text);
			// Follow-up Enter after a short delay to ensure Claude Code's TUI submits.
			// Same pattern as nudge.ts line 168-169.
			await new Promise((resolve) => setTimeout(resolve, 500));
			await sendKeys(tmuxSession, "");
		} catch (err) {
			return errorResponse(
				`Failed to send keys: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		return jsonResponse({ ok: true });
	}

	// -------------------------------------------------------------------------
	// Autopilot — POST routes (before the GET-only guard)
	// -------------------------------------------------------------------------

	if (path === "/api/autopilot/start" && request.method === "POST") {
		if (!autopilot) {
			return errorResponse("Autopilot not available", 404);
		}
		autopilot.start();
		return jsonResponse(autopilot.getState());
	}

	if (path === "/api/autopilot/stop" && request.method === "POST") {
		if (!autopilot) {
			return errorResponse("Autopilot not available", 404);
		}
		autopilot.stop();
		return jsonResponse(autopilot.getState());
	}

	// -------------------------------------------------------------------------
	// Audit — POST route (before the GET-only guard)
	// -------------------------------------------------------------------------

	if (request.method === "POST" && path === "/api/audit") {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return errorResponse("Invalid JSON body", 400);
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return errorResponse("Request body must be a JSON object", 400);
		}
		const obj = body as Record<string, unknown>;

		if (typeof obj.type !== "string" || !obj.type) {
			return errorResponse("Missing required field: type", 400);
		}
		if (typeof obj.summary !== "string" || !obj.summary) {
			return errorResponse("Missing required field: summary", 400);
		}

		const source = typeof obj.source === "string" ? obj.source : "web_ui";
		const agent = typeof obj.agent === "string" ? obj.agent : null;
		const detail = typeof obj.detail === "string" ? obj.detail : null;
		const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : null;

		const auditDbPath = join(legioDir, "audit.db");
		const store = createAuditStore(auditDbPath);
		try {
			const id = store.insert({
				type: obj.type,
				agent,
				source,
				summary: obj.summary,
				detail,
				sessionId,
			});
			// Fetch the inserted event back from the database to return the full record
			const created = store.getAll().find((e) => e.id === id);
			return jsonResponse(created ?? { id }, 201);
		} catch (err) {
			return errorResponse(
				`Failed to record audit event: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			store.close();
		}
	}

	// -------------------------------------------------------------------------
	// Setup — POST route (before the GET-only guard)
	// -------------------------------------------------------------------------

	if (request.method === "POST" && path === "/api/setup/init") {
		let force = false;
		try {
			const body = await request.json();
			if (typeof body === "object" && body !== null && !Array.isArray(body)) {
				const obj = body as Record<string, unknown>;
				force = obj.force === true;
			}
		} catch {
			// ignore — force defaults to false
		}

		return new Promise<Response>((resolve) => {
			const args = force ? ["init", "--force"] : ["init"];
			const proc = spawn("legio", args, {
				cwd: projectRoot,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk;
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk;
			});
			proc.on("close", (code: number | null) => {
				if (code === 0) {
					resolve(jsonResponse({ success: true, message: "Project initialized successfully" }));
				} else {
					const raw = stderr.trim() || stdout.trim() || "Init failed";
					const errorText = raw.split("\n")[0] ?? "Init failed";
					resolve(jsonResponse({ success: false, error: errorText }));
				}
			});
			proc.on("error", (err: Error) => {
				resolve(jsonResponse({ success: false, error: err.message }));
			});
		});
	}

	// -------------------------------------------------------------------------
	// Strategy — POST routes (before the GET-only guard)
	// -------------------------------------------------------------------------

	{
		const params = matchRoute(path, "/api/strategy/:id/approve");
		if (request.method === "POST" && params) {
			const { id } = params;
			if (!id) return errorResponse("Missing recommendation ID", 400);

			const strategyPath = join(legioDir, "strategy.json");
			if (!(await fileExists(strategyPath))) {
				return errorResponse("No strategy.json found", 404);
			}

			try {
				const raw = await readFile(strategyPath, "utf-8");
				const data = JSON.parse(raw) as StrategyFile;
				const rec = data.recommendations.find((r) => r.id === id);
				if (!rec) return errorResponse(`Recommendation not found: ${id}`, 404);
				if (rec.status !== "pending") {
					return errorResponse(`Recommendation already ${rec.status}`, 409);
				}

				const client = createBeadsClient(projectRoot);
				const priorityNum =
					rec.priority === "critical"
						? 0
						: rec.priority === "high"
							? 1
							: rec.priority === "medium"
								? 2
								: 3;
				const issueId = await client.create(rec.title, {
					description: rec.rationale,
					priority: priorityNum,
				});

				rec.status = "approved";
				await writeFile(strategyPath, JSON.stringify(data, null, 2));

				return jsonResponse({ recommendation: rec, issueId });
			} catch (err) {
				return errorResponse(
					`Failed to approve recommendation: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	{
		const params = matchRoute(path, "/api/strategy/:id/dismiss");
		if (request.method === "POST" && params) {
			const { id } = params;
			if (!id) return errorResponse("Missing recommendation ID", 400);

			const strategyPath = join(legioDir, "strategy.json");
			if (!(await fileExists(strategyPath))) {
				return errorResponse("No strategy.json found", 404);
			}

			try {
				const raw = await readFile(strategyPath, "utf-8");
				const data = JSON.parse(raw) as StrategyFile;
				const rec = data.recommendations.find((r) => r.id === id);
				if (!rec) return errorResponse(`Recommendation not found: ${id}`, 404);
				if (rec.status !== "pending") {
					return errorResponse(`Recommendation already ${rec.status}`, 409);
				}

				rec.status = "dismissed";
				await writeFile(strategyPath, JSON.stringify(data, null, 2));

				return jsonResponse(rec);
			} catch (err) {
				return errorResponse(
					`Failed to dismiss recommendation: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	// Only handle GET requests for all other routes
	if (request.method !== "GET") {
		return errorResponse("Method not allowed", 405);
	}

	// -------------------------------------------------------------------------
	// Core
	// -------------------------------------------------------------------------

	if (path === "/api/health") {
		return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
	}

	if (path === "/api/setup/status") {
		const configPath = join(legioDir, "config.yaml");
		const initialized = await fileExists(configPath);
		let projectName: string | null = null;
		if (initialized) {
			try {
				const config = await loadConfig(projectRoot);
				projectName = config.project.name;
			} catch {
				// ignore — return initialized: true with null name
			}
		}
		return jsonResponse({ initialized, projectName, projectRoot });
	}

	if (path === "/api/status") {
		try {
			const data = await gatherStatus(projectRoot, "orchestrator", true);
			return jsonResponse(data);
		} catch (err) {
			return errorResponse(
				`Failed to gather status: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (path === "/api/coordinator/status") {
		const tmuxSession = await resolveTerminalSession(legioDir, projectRoot, "coordinator");
		return jsonResponse({
			state: tmuxSession ? "running" : "stopped",
			tmuxSession: tmuxSession ?? undefined,
		});
	}

	if (path === "/api/config") {
		try {
			const config = await loadConfig(projectRoot);
			return jsonResponse(config);
		} catch (err) {
			return errorResponse(
				`Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// -------------------------------------------------------------------------
	// Agents — specific routes before parameterized
	// -------------------------------------------------------------------------

	if (path === "/api/agents") {
		const dbPath = join(legioDir, "sessions.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const { store } = openSessionStore(legioDir);
		try {
			return jsonResponse(store.getAll());
		} finally {
			store.close();
		}
	}

	if (path === "/api/agents/active") {
		const dbPath = join(legioDir, "sessions.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const { store } = openSessionStore(legioDir);
		try {
			return jsonResponse(store.getActive());
		} finally {
			store.close();
		}
	}

	// /api/agents/:name/inspect
	{
		const params = matchRoute(path, "/api/agents/:name/inspect");
		if (params) {
			const { name } = params;
			if (!name) return errorResponse("Missing agent name", 400);
			try {
				const data = await gatherInspectData(projectRoot, name, { noTmux: true });
				return jsonResponse(data);
			} catch {
				return errorResponse(`Agent not found: ${name}`, 404);
			}
		}
	}

	// /api/agents/:name/events
	{
		const params = matchRoute(path, "/api/agents/:name/events");
		if (params) {
			const { name } = params;
			if (!name) return errorResponse("Missing agent name", 400);
			const dbPath = join(legioDir, "events.db");
			if (!(await fileExists(dbPath))) {
				return jsonResponse([]);
			}
			const since = url.searchParams.get("since") ?? undefined;
			const until = url.searchParams.get("until") ?? undefined;
			const limitStr = url.searchParams.get("limit");
			const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
			const levelParam = url.searchParams.get("level");
			const level = levelParam ? (levelParam as EventLevel) : undefined;
			const store = createEventStore(dbPath);
			try {
				return jsonResponse(store.getByAgent(name, { since, until, limit, level }));
			} finally {
				store.close();
			}
		}
	}

	// /api/agents/:name
	{
		const params = matchRoute(path, "/api/agents/:name");
		if (params) {
			const { name } = params;
			if (!name) return errorResponse("Missing agent name", 400);
			const dbPath = join(legioDir, "sessions.db");
			if (!(await fileExists(dbPath))) {
				return errorResponse(`Agent not found: ${name}`, 404);
			}
			const { store } = openSessionStore(legioDir);
			try {
				const session = store.getByName(name);
				if (!session) return errorResponse(`Agent not found: ${name}`, 404);
				return jsonResponse(session);
			} finally {
				store.close();
			}
		}
	}

	// -------------------------------------------------------------------------
	// Mail — specific routes before parameterized
	// -------------------------------------------------------------------------

	if (path === "/api/mail") {
		const dbPath = join(legioDir, "mail.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const from = url.searchParams.get("from") ?? undefined;
		const to = url.searchParams.get("to") ?? undefined;
		const unreadStr = url.searchParams.get("unread");
		const unread = unreadStr !== null ? unreadStr === "true" : undefined;
		const store = createMailStore(dbPath);
		try {
			return jsonResponse(store.getAll({ from, to, unread }));
		} finally {
			store.close();
		}
	}

	if (path === "/api/mail/unread") {
		const agent = url.searchParams.get("agent");
		if (!agent) return errorResponse("Missing required query param: agent", 400);
		const dbPath = join(legioDir, "mail.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const store = createMailStore(dbPath);
		try {
			return jsonResponse(store.getUnread(agent));
		} finally {
			store.close();
		}
	}

	if (path === "/api/mail/conversations") {
		const dbPath = join(legioDir, "mail.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const agentFilter = url.searchParams.get("agent") ?? undefined;
		const store = createMailStore(dbPath);
		try {
			const messages = store.getAll();

			// Group messages by normalized agent pair (sorted alphabetically)
			const groups = new Map<string, { participants: [string, string]; messages: MailMessage[] }>();
			for (const msg of messages) {
				const sorted = [msg.from, msg.to].sort();
				const a = sorted[0];
				const b = sorted[1];
				if (!a || !b) continue;
				const pair: [string, string] = [a, b];
				const key = `${a}:${b}`;
				let group = groups.get(key);
				if (!group) {
					group = { participants: pair, messages: [] };
					groups.set(key, group);
				}
				group.messages.push(msg);
			}

			// Build conversation objects
			const conversations: Array<{
				participants: [string, string];
				lastMessage: MailMessage;
				messageCount: number;
				unreadCount: number;
			}> = [];
			for (const { participants, messages: msgs } of groups.values()) {
				if (agentFilter && !participants.includes(agentFilter)) {
					continue;
				}
				const sorted = [...msgs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
				const lastMessage = sorted[0];
				if (!lastMessage) continue;
				conversations.push({
					participants,
					lastMessage,
					messageCount: msgs.length,
					unreadCount: msgs.filter((m) => !m.read).length,
				});
			}

			// Sort conversations by most recent message first
			conversations.sort((a, b) => b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt));
			return jsonResponse(conversations);
		} finally {
			store.close();
		}
	}

	// /api/mail/thread/:threadId — before /api/mail/:id
	{
		const params = matchRoute(path, "/api/mail/thread/:threadId");
		if (params) {
			const { threadId } = params;
			if (!threadId) return errorResponse("Missing thread ID", 400);
			const dbPath = join(legioDir, "mail.db");
			if (!(await fileExists(dbPath))) {
				return jsonResponse([]);
			}
			const store = createMailStore(dbPath);
			try {
				return jsonResponse(store.getByThread(threadId));
			} finally {
				store.close();
			}
		}
	}

	// /api/mail/:id
	{
		const params = matchRoute(path, "/api/mail/:id");
		if (params) {
			const { id } = params;
			if (!id) return errorResponse("Missing message ID", 400);
			const dbPath = join(legioDir, "mail.db");
			if (!(await fileExists(dbPath))) {
				return errorResponse(`Message not found: ${id}`, 404);
			}
			const store = createMailStore(dbPath);
			try {
				const message = store.getById(id);
				if (!message) return errorResponse(`Message not found: ${id}`, 404);
				return jsonResponse(message);
			} finally {
				store.close();
			}
		}
	}

	// -------------------------------------------------------------------------
	// Events — specific routes before parameterized
	// -------------------------------------------------------------------------

	if (path === "/api/events") {
		const since = url.searchParams.get("since");
		if (!since) return errorResponse("Missing required query param: since", 400);
		const dbPath = join(legioDir, "events.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const until = url.searchParams.get("until") ?? undefined;
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
		const levelParam = url.searchParams.get("level");
		const level = levelParam ? (levelParam as EventLevel) : undefined;
		const store = createEventStore(dbPath);
		try {
			return jsonResponse(store.getTimeline({ since, until, limit, level }));
		} finally {
			store.close();
		}
	}

	if (path === "/api/events/errors") {
		const dbPath = join(legioDir, "events.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const since = url.searchParams.get("since") ?? undefined;
		const until = url.searchParams.get("until") ?? undefined;
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
		const store = createEventStore(dbPath);
		try {
			return jsonResponse(store.getErrors({ since, until, limit }));
		} finally {
			store.close();
		}
	}

	if (path === "/api/events/tools") {
		const dbPath = join(legioDir, "events.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const agentName = url.searchParams.get("agent") ?? undefined;
		const since = url.searchParams.get("since") ?? undefined;
		const store = createEventStore(dbPath);
		try {
			return jsonResponse(store.getToolStats({ agentName, since }));
		} finally {
			store.close();
		}
	}

	// -------------------------------------------------------------------------
	// Metrics — specific routes before parameterized
	// -------------------------------------------------------------------------

	if (path === "/api/metrics") {
		const dbPath = join(legioDir, "metrics.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? Number.parseInt(limitStr, 10) : 100;
		const store = createMetricsStore(dbPath);
		try {
			return jsonResponse(store.getRecentSessions(limit));
		} finally {
			store.close();
		}
	}

	if (path === "/api/metrics/snapshots") {
		const dbPath = join(legioDir, "metrics.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const store = createMetricsStore(dbPath);
		try {
			return jsonResponse(store.getLatestSnapshots());
		} finally {
			store.close();
		}
	}

	// -------------------------------------------------------------------------
	// Runs — specific routes before parameterized
	// -------------------------------------------------------------------------

	if (path === "/api/runs") {
		const dbPath = join(legioDir, "sessions.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
		const statusParam = url.searchParams.get("status");
		const status = statusParam as RunStatus | undefined;
		const store = createRunStore(dbPath);
		try {
			return jsonResponse(store.listRuns({ limit, status: status ?? undefined }));
		} finally {
			store.close();
		}
	}

	if (path === "/api/runs/active") {
		const dbPath = join(legioDir, "sessions.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse(null);
		}
		const store = createRunStore(dbPath);
		try {
			return jsonResponse(store.getActiveRun());
		} finally {
			store.close();
		}
	}

	// /api/runs/:id
	{
		const params = matchRoute(path, "/api/runs/:id");
		if (params) {
			const { id } = params;
			if (!id) return errorResponse("Missing run ID", 400);
			const dbPath = join(legioDir, "sessions.db");
			if (!(await fileExists(dbPath))) {
				return errorResponse(`Run not found: ${id}`, 404);
			}
			const runStore = createRunStore(dbPath);
			const sessionStore = createSessionStore(dbPath);
			try {
				const run = runStore.getRun(id);
				if (!run) return errorResponse(`Run not found: ${id}`, 404);
				const agents = sessionStore.getByRun(id);
				return jsonResponse({ run, agents });
			} finally {
				runStore.close();
				sessionStore.close();
			}
		}
	}

	// -------------------------------------------------------------------------
	// Merge Queue
	// -------------------------------------------------------------------------

	if (path === "/api/merge-queue") {
		const dbPath = join(legioDir, "merge-queue.db");
		if (!(await fileExists(dbPath))) {
			return jsonResponse([]);
		}
		const statusParam = url.searchParams.get("status");
		const queue = createMergeQueue(dbPath);
		try {
			const status = statusParam ? (statusParam as MergeEntry["status"]) : undefined;
			return jsonResponse(queue.list(status));
		} finally {
			queue.close();
		}
	}

	// -------------------------------------------------------------------------
	// Issues (beads)
	// -------------------------------------------------------------------------

	if (path === "/api/issues") {
		const statusParam = url.searchParams.get("status") ?? undefined;
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
		try {
			const client = createBeadsClient(projectRoot);
			const issues = await client.list({ status: statusParam, limit });
			return jsonResponse(issues);
		} catch {
			return jsonResponse([]);
		}
	}

	if (path === "/api/issues/ready") {
		try {
			const client = createBeadsClient(projectRoot);
			const issues = await client.ready();
			return jsonResponse(issues);
		} catch {
			return jsonResponse([]);
		}
	}

	// /api/issues/:id
	{
		const params = matchRoute(path, "/api/issues/:id");
		if (params) {
			const { id } = params;
			if (!id) return errorResponse("Missing issue ID", 400);
			try {
				const client = createBeadsClient(projectRoot);
				const issue = await client.show(id);
				return jsonResponse(issue);
			} catch {
				return errorResponse(`Issue not found: ${id}`, 404);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Terminal
	// -------------------------------------------------------------------------

	if (path === "/api/terminal/capture") {
		const agentName = url.searchParams.get("agent") ?? "coordinator";
		const linesStr = url.searchParams.get("lines");
		const lines = linesStr ? Math.max(1, Number.parseInt(linesStr, 10)) : 100;

		const tmuxSession = await resolveTerminalSession(legioDir, projectRoot, agentName);
		if (!tmuxSession) {
			return errorResponse(`Cannot resolve tmux session for agent "${agentName}"`, 404);
		}

		const output = await captureTmuxPane(tmuxSession, lines);
		if (output === null) {
			return errorResponse(`Failed to capture tmux pane for session "${tmuxSession}"`);
		}

		return jsonResponse({
			output,
			agent: agentName,
			timestamp: new Date().toISOString(),
		});
	}

	// -------------------------------------------------------------------------
	// Autopilot — GET route
	// -------------------------------------------------------------------------

	if (path === "/api/autopilot/status") {
		if (!autopilot) {
			return errorResponse("Autopilot not available", 404);
		}
		return jsonResponse(autopilot.getState());
	}

	// -------------------------------------------------------------------------
	// Audit
	// -------------------------------------------------------------------------

	if (path === "/api/audit/timeline") {
		const auditDbPath = join(legioDir, "audit.db");
		if (!(await fileExists(auditDbPath))) {
			return jsonResponse([]);
		}
		const sinceParam = url.searchParams.get("since");
		// Default since to 24h ago if not provided
		const since = sinceParam ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const until = url.searchParams.get("until") ?? undefined;
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
		const store = createAuditStore(auditDbPath);
		try {
			return jsonResponse(store.getTimeline({ since, until, limit }));
		} finally {
			store.close();
		}
	}

	if (path === "/api/audit") {
		const auditDbPath = join(legioDir, "audit.db");
		if (!(await fileExists(auditDbPath))) {
			return jsonResponse([]);
		}
		const since = url.searchParams.get("since") ?? undefined;
		const until = url.searchParams.get("until") ?? undefined;
		const agent = url.searchParams.get("agent") ?? undefined;
		const type = url.searchParams.get("type") ?? undefined;
		const source = url.searchParams.get("source") ?? undefined;
		const limitStr = url.searchParams.get("limit");
		const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
		const store = createAuditStore(auditDbPath);
		try {
			return jsonResponse(store.getAll({ since, until, agent, type, source, limit }));
		} finally {
			store.close();
		}
	}

	// -------------------------------------------------------------------------
	// Strategy
	// -------------------------------------------------------------------------

	if (path === "/api/strategy") {
		const strategyPath = join(legioDir, "strategy.json");
		if (!(await fileExists(strategyPath))) {
			return jsonResponse([]);
		}
		try {
			const raw = await readFile(strategyPath, "utf-8");
			const data = JSON.parse(raw) as StrategyFile;
			return jsonResponse(data.recommendations ?? []);
		} catch (err) {
			return errorResponse(
				`Failed to read strategy.json: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// -------------------------------------------------------------------------
	// Catch-all for unmatched /api/* paths
	// -------------------------------------------------------------------------

	return errorResponse("Not found", 404);
}
