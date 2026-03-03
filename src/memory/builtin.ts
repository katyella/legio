/**
 * Builtin SQLite backend for the memory system.
 *
 * Zero-dependency expertise/memory storage backed by a local SQLite database.
 * Uses better-sqlite3 with WAL mode for concurrent access from multiple agents.
 * DB lives at `.legio/memory.db`.
 *
 * Pattern follows src/tracker/builtin.ts (WAL mode, prepared statements, dispose).
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { inferDomainsFromFiles } from "./domain-map.ts";
import type { MemoryClient, MemoryRecord } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
	id TEXT PRIMARY KEY,
	domain TEXT NOT NULL,
	type TEXT NOT NULL,
	content TEXT NOT NULL,
	classification TEXT NOT NULL DEFAULT 'tactical',
	tags TEXT,
	evidence_commit TEXT,
	evidence_bead TEXT,
	recorded_at TEXT NOT NULL,
	updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_records_domain ON records(domain);
CREATE INDEX IF NOT EXISTS idx_records_recorded_at ON records(recorded_at);
CREATE INDEX IF NOT EXISTS idx_records_type ON records(type);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
	content, domain, tags,
	content='records',
	content_rowid='rowid'
);

-- Triggers to keep FTS in sync with records table
CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
	INSERT INTO records_fts(rowid, content, domain, tags)
	VALUES (new.rowid, new.content, new.domain, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
	INSERT INTO records_fts(records_fts, rowid, content, domain, tags)
	VALUES ('delete', old.rowid, old.content, old.domain, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
	INSERT INTO records_fts(records_fts, rowid, content, domain, tags)
	VALUES ('delete', old.rowid, old.content, old.domain, old.tags);
	INSERT INTO records_fts(rowid, content, domain, tags)
	VALUES (new.rowid, new.content, new.domain, new.tags);
END;
`;

/** Generate a memory record ID: "mem-" + first 8 chars of a UUID. */
function generateRecordId(): string {
	return `mem-${randomUUID().slice(0, 8)}`;
}

/** Row shape as stored in SQLite. */
interface RecordRow {
	id: string;
	domain: string;
	type: string;
	content: string;
	classification: string;
	tags: string | null;
	evidence_commit: string | null;
	evidence_bead: string | null;
	recorded_at: string;
	updated_at: string | null;
}

/** Convert a SQLite row to a MemoryRecord. */
function rowToRecord(row: RecordRow): MemoryRecord {
	return {
		id: row.id,
		domain: row.domain,
		type: row.type,
		content: row.content,
		classification: row.classification,
		tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
		evidenceCommit: row.evidence_commit ?? undefined,
		evidenceBead: row.evidence_bead ?? undefined,
		recordedAt: row.recorded_at,
		updatedAt: row.updated_at ?? undefined,
	};
}

/** Format a relative time string (e.g., "2h ago", "3d ago"). */
function formatRelativeTime(isoDate: string): string {
	const diffMs = Date.now() - new Date(isoDate).getTime();
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export interface BuiltinMemoryClient extends MemoryClient {
	/** Close the database connection. Call when done with the client. */
	dispose(): void;
}

/**
 * Create a MemoryClient backed by a local SQLite database.
 *
 * @param dbPath - Path to the SQLite database file (e.g., `.legio/memory.db`)
 */
export function createBuiltinMemoryClient(dbPath: string): BuiltinMemoryClient {
	const db = new Database(dbPath);
	db.pragma("journal_mode=WAL");
	db.pragma("busy_timeout=5000");
	db.exec(SCHEMA);
	db.exec(FTS_SCHEMA);

	const insertStmt = db.prepare(
		`INSERT INTO records (id, domain, type, content, classification, tags, evidence_commit, evidence_bead, recorded_at, updated_at)
		 VALUES (@id, @domain, @type, @content, @classification, @tags, @evidence_commit, @evidence_bead, @recorded_at, @updated_at)`,
	);

	const getByIdStmt = db.prepare("SELECT * FROM records WHERE id = ?");

	return {
		async prime(options) {
			let sql = "SELECT * FROM records";
			const conditions: string[] = [];
			const params: unknown[] = [];

			if (options?.domains && options.domains.length > 0) {
				const placeholders = options.domains.map(() => "?").join(", ");
				conditions.push(`domain IN (${placeholders})`);
				params.push(...options.domains);
			}

			if (conditions.length > 0) {
				sql += ` WHERE ${conditions.join(" AND ")}`;
			}
			sql += " ORDER BY domain ASC, recorded_at DESC";

			if (options?.budget !== undefined) {
				sql += " LIMIT ?";
				params.push(options.budget);
			}

			const rows = db.prepare(sql).all(...params) as RecordRow[];

			if (rows.length === 0) {
				return "No expertise records found.";
			}

			// Group by domain
			const byDomain = new Map<string, RecordRow[]>();
			for (const row of rows) {
				const existing = byDomain.get(row.domain) ?? [];
				existing.push(row);
				byDomain.set(row.domain, existing);
			}

			// Format as markdown sections
			const sections: string[] = ["# Project Expertise (via legio memory)\n"];

			for (const [domain, domainRows] of byDomain) {
				const lastUpdated = domainRows[0]?.recorded_at;
				const relTime = lastUpdated ? formatRelativeTime(lastUpdated) : "unknown";
				sections.push(`## ${domain} (${domainRows.length} records, updated ${relTime})`);
				for (const row of domainRows) {
					const summary =
						row.content.length > 100 ? `${row.content.slice(0, 100)}...` : row.content;
					sections.push(`- [${row.type}] ${summary} (${row.id})`);
				}
				sections.push("");
			}

			return sections.join("\n");
		},

		async record(domain, options) {
			const id = generateRecordId();
			const now = new Date().toISOString();
			insertStmt.run({
				id,
				domain,
				type: options.type,
				content: options.description,
				classification: options.classification ?? "tactical",
				tags: options.tags ? JSON.stringify(options.tags) : null,
				evidence_commit: options.evidenceCommit ?? null,
				evidence_bead: options.evidenceBead ?? null,
				recorded_at: now,
				updated_at: null,
			});
			return id;
		},

		async search(query) {
			const rows = db
				.prepare(
					`SELECT r.* FROM records r
					 JOIN records_fts fts ON r.rowid = fts.rowid
					 WHERE records_fts MATCH ?
					 ORDER BY rank
					 LIMIT 50`,
				)
				.all(query) as RecordRow[];

			if (rows.length === 0) {
				return `No records matching "${query}".`;
			}

			const lines: string[] = [`Search results for "${query}" (${rows.length} matches):\n`];
			for (const row of rows) {
				const summary = row.content.length > 120 ? `${row.content.slice(0, 120)}...` : row.content;
				lines.push(`[${row.domain}/${row.type}] ${summary} (${row.id})`);
			}
			return lines.join("\n");
		},

		async query(domain) {
			let sql = "SELECT * FROM records";
			const params: unknown[] = [];
			if (domain) {
				sql += " WHERE domain = ?";
				params.push(domain);
			}
			sql += " ORDER BY recorded_at DESC LIMIT 100";

			const rows = db.prepare(sql).all(...params) as RecordRow[];

			if (rows.length === 0) {
				return domain ? `No records in domain "${domain}".` : "No records found.";
			}

			const lines: string[] = [];
			for (const row of rows) {
				const summary = row.content.length > 120 ? `${row.content.slice(0, 120)}...` : row.content;
				lines.push(`[${row.domain}/${row.type}] ${summary} (${row.id})`);
			}
			return lines.join("\n");
		},

		async status() {
			const rows = db
				.prepare(
					`SELECT domain, COUNT(*) as record_count, MAX(recorded_at) as last_updated
					 FROM records GROUP BY domain ORDER BY domain ASC`,
				)
				.all() as Array<{ domain: string; record_count: number; last_updated: string }>;

			return rows.map((r) => ({
				name: r.domain,
				recordCount: r.record_count,
				lastUpdated: r.last_updated,
			}));
		},

		async list(options) {
			let sql = "SELECT * FROM records";
			const conditions: string[] = [];
			const params: unknown[] = [];

			if (options?.domain) {
				conditions.push("domain = ?");
				params.push(options.domain);
			}
			if (options?.type) {
				conditions.push("type = ?");
				params.push(options.type);
			}
			if (options?.since) {
				conditions.push("recorded_at >= ?");
				params.push(options.since);
			}

			if (conditions.length > 0) {
				sql += ` WHERE ${conditions.join(" AND ")}`;
			}
			sql += " ORDER BY recorded_at DESC";

			if (options?.limit !== undefined) {
				sql += " LIMIT ?";
				params.push(options.limit);
			}

			const rows = db.prepare(sql).all(...params) as RecordRow[];
			return rows.map(rowToRecord);
		},

		async show(id) {
			const row = getByIdStmt.get(id) as RecordRow | undefined;
			if (!row) {
				throw new Error(`Record not found: ${id}`);
			}
			return rowToRecord(row);
		},

		async delete(id) {
			const row = getByIdStmt.get(id) as RecordRow | undefined;
			if (!row) {
				throw new Error(`Record not found: ${id}`);
			}
			db.prepare("DELETE FROM records WHERE id = ?").run(id);
		},

		async prune(options) {
			const dryRun = options?.dryRun ?? false;
			const sql = "SELECT COUNT(*) as count FROM records WHERE 1=1";
			const deleteSql = "DELETE FROM records WHERE 1=1";
			const conditions: string[] = [];
			const params: unknown[] = [];

			if (options?.olderThanDays !== undefined) {
				const cutoff = new Date(
					Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000,
				).toISOString();
				conditions.push("recorded_at < ?");
				params.push(cutoff);
			}
			if (options?.domain) {
				conditions.push("domain = ?");
				params.push(options.domain);
			}

			const conditionStr = conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "";

			const countRow = db.prepare(`${sql}${conditionStr}`).get(...params) as {
				count: number;
			};

			if (!dryRun && countRow.count > 0) {
				db.prepare(`${deleteSql}${conditionStr}`).run(...params);
			}

			return { pruned: countRow.count, dryRun };
		},

		suggestDomains(files) {
			return inferDomainsFromFiles(files);
		},

		dispose() {
			db.close();
		},
	};
}
