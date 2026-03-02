/**
 * Builtin SQLite adapter for the tracker abstraction layer.
 *
 * Zero-dependency task tracking backed by a local SQLite database.
 * No external CLI tools required — uses better-sqlite3 directly.
 * DB lives at `.legio/tasks.db`.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { TrackerClient, TrackerIssue } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open',
	priority INTEGER NOT NULL DEFAULT 2,
	type TEXT NOT NULL DEFAULT 'task',
	assignee TEXT,
	description TEXT,
	blocks TEXT,
	blocked_by TEXT,
	close_reason TEXT,
	created_at TEXT NOT NULL,
	closed_at TEXT
);
`;

/** Generate a task ID: "task-" + first 8 chars of a UUID. */
function generateTaskId(): string {
	return `task-${randomUUID().slice(0, 8)}`;
}

/** Row shape as stored in SQLite. */
interface TaskRow {
	id: string;
	title: string;
	status: string;
	priority: number;
	type: string;
	assignee: string | null;
	description: string | null;
	blocks: string | null;
	blocked_by: string | null;
	close_reason: string | null;
	created_at: string;
	closed_at: string | null;
}

/** Convert a SQLite row to a TrackerIssue. */
function rowToIssue(row: TaskRow): TrackerIssue {
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		priority: row.priority,
		type: row.type,
		assignee: row.assignee ?? undefined,
		description: row.description ?? undefined,
		blocks: row.blocks ? (JSON.parse(row.blocks) as string[]) : undefined,
		blockedBy: row.blocked_by ? (JSON.parse(row.blocked_by) as string[]) : undefined,
		closeReason: row.close_reason ?? undefined,
		createdAt: row.created_at,
		closedAt: row.closed_at ?? undefined,
	};
}

export interface BuiltinTrackerClient extends TrackerClient {
	/** Close the database connection. Call when done with the client. */
	dispose(): void;
}

/**
 * Create a TrackerClient backed by a local SQLite database.
 *
 * @param dbPath - Path to the SQLite database file (e.g., `.legio/tasks.db`)
 */
export function createBuiltinTrackerClient(dbPath: string): BuiltinTrackerClient {
	const db = new Database(dbPath);
	db.pragma("journal_mode=WAL");
	db.pragma("busy_timeout=5000");
	db.exec(SCHEMA);

	const insertStmt = db.prepare(
		`INSERT INTO tasks (id, title, status, priority, type, assignee, description, blocks, blocked_by, close_reason, created_at, closed_at)
		 VALUES (@id, @title, @status, @priority, @type, @assignee, @description, @blocks, @blocked_by, @close_reason, @created_at, @closed_at)`,
	);

	const getByIdStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");

	return {
		async ready(): Promise<TrackerIssue[]> {
			const rows = db
				.prepare(
					"SELECT * FROM tasks WHERE status = 'open' AND (blocked_by IS NULL OR blocked_by = '[]') ORDER BY priority ASC, created_at ASC",
				)
				.all() as TaskRow[];
			return rows.map(rowToIssue);
		},

		async show(id): Promise<TrackerIssue> {
			const row = getByIdStmt.get(id) as TaskRow | undefined;
			if (!row) {
				throw new Error(`Task not found: ${id}`);
			}
			return rowToIssue(row);
		},

		async create(title, options): Promise<string> {
			const id = generateTaskId();
			const now = new Date().toISOString();
			insertStmt.run({
				id,
				title,
				status: "open",
				priority: options?.priority ?? 2,
				type: options?.type ?? "task",
				assignee: null,
				description: options?.description ?? null,
				blocks: null,
				blocked_by: null,
				close_reason: null,
				created_at: now,
				closed_at: null,
			});
			return id;
		},

		async claim(id): Promise<void> {
			const row = getByIdStmt.get(id) as TaskRow | undefined;
			if (!row) {
				throw new Error(`Task not found: ${id}`);
			}
			db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(id);
		},

		async close(id, reason): Promise<void> {
			const row = getByIdStmt.get(id) as TaskRow | undefined;
			if (!row) {
				throw new Error(`Task not found: ${id}`);
			}
			const now = new Date().toISOString();
			db.prepare(
				"UPDATE tasks SET status = 'closed', close_reason = ?, closed_at = ? WHERE id = ?",
			).run(reason ?? null, now, id);
		},

		async list(options): Promise<TrackerIssue[]> {
			let sql = "SELECT * FROM tasks";
			const conditions: string[] = [];
			const params: unknown[] = [];

			if (options?.status) {
				conditions.push("status = ?");
				params.push(options.status);
			} else if (!options?.all) {
				// Default: exclude closed
				conditions.push("status != 'closed'");
			}

			if (conditions.length > 0) {
				sql += ` WHERE ${conditions.join(" AND ")}`;
			}
			sql += " ORDER BY priority ASC, created_at ASC";

			if (options?.limit !== undefined) {
				sql += " LIMIT ?";
				params.push(options.limit);
			}

			const rows = db.prepare(sql).all(...params) as TaskRow[];
			return rows.map(rowToIssue);
		},

		async sync(): Promise<void> {
			// No-op for builtin backend — no external state to sync
		},

		dispose(): void {
			db.close();
		},
	};
}
