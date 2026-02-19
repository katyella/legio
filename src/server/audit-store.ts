/**
 * SQLite-backed audit trail store for the legio web UI.
 *
 * Records orchestration events: commands sent via UI, coordinator responses,
 * state transitions, merge events, errors, and system-level events.
 * Uses better-sqlite3 for synchronous database access.
 * WAL mode enables concurrent reads from multiple processes.
 */

import Database from "better-sqlite3";

/** Row shape as stored in SQLite (snake_case columns). */
interface AuditRow {
	id: number;
	type: string;
	agent: string | null;
	source: string;
	summary: string;
	detail: string | null;
	session_id: string | null;
	created_at: string;
}

export interface AuditEvent {
	id: number;
	type: string;
	agent: string | null;
	source: string;
	summary: string;
	detail: string | null;
	sessionId: string | null;
	createdAt: string;
}

export interface InsertAuditEvent {
	type: string;
	agent?: string | null;
	source?: string;
	summary: string;
	detail?: string | null;
	sessionId?: string | null;
}

export interface AuditQueryOptions {
	since?: string;
	until?: string;
	agent?: string;
	type?: string;
	source?: string;
	limit?: number;
}

export interface AuditStore {
	insert(event: InsertAuditEvent): number;
	getAll(opts?: AuditQueryOptions): AuditEvent[];
	getTimeline(opts?: { since?: string; until?: string; limit?: number }): AuditEvent[];
	getByAgent(agent: string, opts?: { since?: string; limit?: number }): AuditEvent[];
	getByType(type: string, opts?: { since?: string; limit?: number }): AuditEvent[];
	purge(opts: { all?: boolean; olderThanMs?: number }): number;
	close(): void;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  agent TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  summary TEXT NOT NULL,
  detail TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now'))
)`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_audit_type_time ON audit_events(type, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_agent_time ON audit_events(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_source ON audit_events(source)`;

/** Convert a database row (snake_case) to an AuditEvent object (camelCase). */
function rowToAuditEvent(row: AuditRow): AuditEvent {
	return {
		id: row.id,
		type: row.type,
		agent: row.agent,
		source: row.source,
		summary: row.summary,
		detail: row.detail,
		sessionId: row.session_id,
		createdAt: row.created_at,
	};
}

/**
 * Create a new AuditStore backed by a SQLite database at the given path.
 *
 * Initializes the database with WAL mode and a 5-second busy timeout.
 * Creates the audit_events table and indexes if they do not already exist.
 */
export function createAuditStore(dbPath: string): AuditStore {
	const db = new Database(dbPath);

	// Configure for concurrent access from multiple processes.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");

	// Create schema
	db.exec(CREATE_TABLE);
	db.exec(CREATE_INDEXES);

	// Prepare the insert statement
	const insertStmt = db.prepare(`
		INSERT INTO audit_events
			(type, agent, source, summary, detail, session_id)
		VALUES
			($type, $agent, $source, $summary, $detail, $session_id)
		RETURNING id
	`);

	return {
		insert(event: InsertAuditEvent): number {
			const row = insertStmt.get({
				type: event.type,
				agent: event.agent ?? null,
				source: event.source ?? "system",
				summary: event.summary,
				detail: event.detail ?? null,
				session_id: event.sessionId ?? null,
			}) as { id: number } | undefined;
			if (!row) {
				return 0;
			}
			return row.id;
		},

		getAll(opts?: AuditQueryOptions): AuditEvent[] {
			const conditions: string[] = [];
			const params: Record<string, string | number> = {};

			if (opts?.since !== undefined) {
				conditions.push("created_at >= $since");
				params.since = opts.since;
			}
			if (opts?.until !== undefined) {
				conditions.push("created_at <= $until");
				params.until = opts.until;
			}
			if (opts?.agent !== undefined) {
				conditions.push("agent = $agent");
				params.agent = opts.agent;
			}
			if (opts?.type !== undefined) {
				conditions.push("type = $type");
				params.type = opts.type;
			}
			if (opts?.source !== undefined) {
				conditions.push("source = $source");
				params.source = opts.source;
			}

			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const limitClause = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : "";
			const query = `SELECT * FROM audit_events ${whereClause} ORDER BY created_at ASC ${limitClause}`;

			const rows = db.prepare(query).all(params) as AuditRow[];
			return rows.map(rowToAuditEvent);
		},

		getTimeline(opts?: { since?: string; until?: string; limit?: number }): AuditEvent[] {
			const conditions: string[] = [];
			const params: Record<string, string | number> = {};

			if (opts?.since !== undefined) {
				conditions.push("created_at >= $since");
				params.since = opts.since;
			}
			if (opts?.until !== undefined) {
				conditions.push("created_at <= $until");
				params.until = opts.until;
			}

			const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
			const limitClause = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : "";
			const query = `SELECT * FROM audit_events ${whereClause} ORDER BY created_at ASC ${limitClause}`;

			const rows = db.prepare(query).all(params) as AuditRow[];
			return rows.map(rowToAuditEvent);
		},

		getByAgent(agent: string, opts?: { since?: string; limit?: number }): AuditEvent[] {
			const conditions: string[] = ["agent = $agent"];
			const params: Record<string, string | number> = { agent };

			if (opts?.since !== undefined) {
				conditions.push("created_at >= $since");
				params.since = opts.since;
			}

			const whereClause = `WHERE ${conditions.join(" AND ")}`;
			const limitClause = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : "";
			const query = `SELECT * FROM audit_events ${whereClause} ORDER BY created_at ASC ${limitClause}`;

			const rows = db.prepare(query).all(params) as AuditRow[];
			return rows.map(rowToAuditEvent);
		},

		getByType(type: string, opts?: { since?: string; limit?: number }): AuditEvent[] {
			const conditions: string[] = ["type = $type"];
			const params: Record<string, string | number> = { type };

			if (opts?.since !== undefined) {
				conditions.push("created_at >= $since");
				params.since = opts.since;
			}

			const whereClause = `WHERE ${conditions.join(" AND ")}`;
			const limitClause = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : "";
			const query = `SELECT * FROM audit_events ${whereClause} ORDER BY created_at ASC ${limitClause}`;

			const rows = db.prepare(query).all(params) as AuditRow[];
			return rows.map(rowToAuditEvent);
		},

		purge(opts: { all?: boolean; olderThanMs?: number }): number {
			if (opts.all) {
				const countRow = db.prepare("SELECT COUNT(*) as cnt FROM audit_events").get() as
					| { cnt: number }
					| undefined;
				const count = countRow?.cnt ?? 0;
				db.prepare("DELETE FROM audit_events").run();
				return count;
			}

			if (opts.olderThanMs !== undefined) {
				const cutoff = new Date(Date.now() - opts.olderThanMs).toISOString();
				const countRow = db
					.prepare("SELECT COUNT(*) as cnt FROM audit_events WHERE created_at < $cutoff")
					.get({ cutoff }) as { cnt: number } | undefined;
				const count = countRow?.cnt ?? 0;
				db.prepare("DELETE FROM audit_events WHERE created_at < $cutoff").run({ cutoff });
				return count;
			}

			return 0;
		},

		close(): void {
			try {
				db.exec("PRAGMA wal_checkpoint(PASSIVE)");
			} catch {
				// Best effort — checkpoint failure is non-fatal
			}
			db.close();
		},
	};
}
