/**
 * SQLite-backed chat store for the raw Claude chat feature.
 *
 * Persists chat sessions and messages. Follows the same pattern as audit-store.ts:
 * better-sqlite3 synchronous API, WAL mode, per-request open/close lifecycle.
 */

import Database from "better-sqlite3";
import type { ChatMessage, ChatRole, ChatSession } from "../types.ts";

/** Row shape as stored in SQLite (snake_case columns). */
interface ChatSessionRow {
	id: string;
	title: string;
	model: string;
	created_at: string;
	updated_at: string;
}

interface ChatMessageRow {
	id: string;
	session_id: string;
	role: string;
	content: string;
	created_at: string;
}

export interface ChatStore {
	createSession(opts?: { title?: string; model?: string }): ChatSession;
	getSession(id: string): ChatSession | null;
	listSessions(): ChatSession[];
	deleteSession(id: string): boolean;
	addMessage(sessionId: string, role: ChatRole, content: string): ChatMessage;
	getMessages(sessionId: string): ChatMessage[];
	close(): void;
}

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Chat',
  model TEXT NOT NULL DEFAULT '${DEFAULT_MODEL}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)`;

function rowToSession(row: ChatSessionRow): ChatSession {
	return {
		id: row.id,
		title: row.title,
		model: row.model,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function rowToMessage(row: ChatMessageRow): ChatMessage {
	return {
		id: row.id,
		sessionId: row.session_id,
		role: row.role as ChatRole,
		content: row.content,
		createdAt: row.created_at,
	};
}

/**
 * Create a new ChatStore backed by a SQLite database at the given path.
 *
 * Initializes with WAL mode and a 5-second busy timeout.
 * Creates tables and indexes if they do not already exist.
 */
export function createChatStore(dbPath: string): ChatStore {
	const db = new Database(dbPath);

	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA foreign_keys = ON");

	db.exec(CREATE_SESSIONS_TABLE);
	db.exec(CREATE_MESSAGES_TABLE);
	db.exec(CREATE_INDEX);

	return {
		createSession(opts?: { title?: string; model?: string }): ChatSession {
			const id = crypto.randomUUID();
			const title = opts?.title ?? "New Chat";
			const model = opts?.model ?? DEFAULT_MODEL;
			db.prepare(`
				INSERT INTO chat_sessions (id, title, model)
				VALUES ($id, $title, $model)
			`).run({ id, title, model });
			const row = db
				.prepare("SELECT * FROM chat_sessions WHERE id = $id")
				.get({ id }) as ChatSessionRow;
			return rowToSession(row);
		},

		getSession(id: string): ChatSession | null {
			const row = db
				.prepare("SELECT * FROM chat_sessions WHERE id = $id")
				.get({ id }) as ChatSessionRow | undefined;
			return row ? rowToSession(row) : null;
		},

		listSessions(): ChatSession[] {
			const rows = db
				.prepare("SELECT * FROM chat_sessions ORDER BY created_at DESC")
				.all() as ChatSessionRow[];
			return rows.map(rowToSession);
		},

		deleteSession(id: string): boolean {
			const result = db.prepare("DELETE FROM chat_sessions WHERE id = $id").run({ id });
			return result.changes > 0;
		},

		addMessage(sessionId: string, role: ChatRole, content: string): ChatMessage {
			const id = crypto.randomUUID();
			db.prepare(`
				INSERT INTO chat_messages (id, session_id, role, content)
				VALUES ($id, $session_id, $role, $content)
			`).run({ id, session_id: sessionId, role, content });
			// Update session updated_at timestamp
			db.prepare(`
				UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = $id
			`).run({ id: sessionId });
			const row = db
				.prepare("SELECT * FROM chat_messages WHERE id = $id")
				.get({ id }) as ChatMessageRow;
			return rowToMessage(row);
		},

		getMessages(sessionId: string): ChatMessage[] {
			const rows = db
				.prepare(
					"SELECT * FROM chat_messages WHERE session_id = $session_id ORDER BY created_at ASC",
				)
				.all({ session_id: sessionId }) as ChatMessageRow[];
			return rows.map(rowToMessage);
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
