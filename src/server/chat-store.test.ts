/**
 * Tests for ChatStore.
 *
 * Uses real better-sqlite3 with in-memory database. No mocking.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChatStore } from "./chat-store.ts";
import type { ChatStore } from "./chat-store.ts";

describe("ChatStore", () => {
	let store: ChatStore;

	beforeEach(() => {
		store = createChatStore(":memory:");
	});

	afterEach(() => {
		store.close();
	});

	// -------------------------------------------------------------------------
	// Sessions
	// -------------------------------------------------------------------------

	describe("createSession", () => {
		it("creates a session with default title and model", () => {
			const session = store.createSession();
			expect(session.id).toBeDefined();
			expect(session.title).toBe("New Chat");
			expect(session.model).toBe("claude-sonnet-4-20250514");
			expect(session.createdAt).toBeDefined();
			expect(session.updatedAt).toBeDefined();
		});

		it("creates a session with custom title and model", () => {
			const session = store.createSession({ title: "My Chat", model: "claude-opus-4-6" });
			expect(session.title).toBe("My Chat");
			expect(session.model).toBe("claude-opus-4-6");
		});

		it("generates unique IDs for each session", () => {
			const a = store.createSession();
			const b = store.createSession();
			expect(a.id).not.toBe(b.id);
		});
	});

	describe("getSession", () => {
		it("returns the session by ID", () => {
			const created = store.createSession({ title: "Test" });
			const fetched = store.getSession(created.id);
			expect(fetched).not.toBeNull();
			expect(fetched?.id).toBe(created.id);
			expect(fetched?.title).toBe("Test");
		});

		it("returns null for unknown ID", () => {
			expect(store.getSession("nonexistent")).toBeNull();
		});
	});

	describe("listSessions", () => {
		it("returns empty array when no sessions", () => {
			expect(store.listSessions()).toEqual([]);
		});

		it("returns sessions in newest-first order", async () => {
			const a = store.createSession({ title: "First" });
			// SQLite datetime('now') has 1-second precision — wait for the clock to tick
			await new Promise((r) => setTimeout(r, 1100));
			const b = store.createSession({ title: "Second" });
			const sessions = store.listSessions();
			expect(sessions).toHaveLength(2);
			expect(sessions[0]?.id).toBe(b.id);
			expect(sessions[1]?.id).toBe(a.id);
		});
	});

	describe("deleteSession", () => {
		it("deletes an existing session and returns true", () => {
			const session = store.createSession();
			expect(store.deleteSession(session.id)).toBe(true);
			expect(store.getSession(session.id)).toBeNull();
		});

		it("returns false for unknown session", () => {
			expect(store.deleteSession("nonexistent")).toBe(false);
		});

		it("cascades to delete messages", () => {
			const session = store.createSession();
			store.addMessage(session.id, "user", "Hello");
			store.addMessage(session.id, "assistant", "Hi");
			store.deleteSession(session.id);
			// Messages should be gone (cascade)
			const messages = store.getMessages(session.id);
			expect(messages).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// Messages
	// -------------------------------------------------------------------------

	describe("addMessage", () => {
		it("adds a user message and returns it", () => {
			const session = store.createSession();
			const msg = store.addMessage(session.id, "user", "Hello Claude");
			expect(msg.id).toBeDefined();
			expect(msg.sessionId).toBe(session.id);
			expect(msg.role).toBe("user");
			expect(msg.content).toBe("Hello Claude");
			expect(msg.createdAt).toBeDefined();
		});

		it("adds an assistant message", () => {
			const session = store.createSession();
			const msg = store.addMessage(session.id, "assistant", "Hello!");
			expect(msg.role).toBe("assistant");
		});

		it("updates session updatedAt when message is added", async () => {
			const session = store.createSession();
			const originalUpdatedAt = session.updatedAt;
			await new Promise((r) => setTimeout(r, 1100)); // SQLite datetime precision is 1s
			store.addMessage(session.id, "user", "Hey");
			const updated = store.getSession(session.id);
			expect(updated?.updatedAt).not.toBe(originalUpdatedAt);
		});
	});

	describe("getMessages", () => {
		it("returns empty array for session with no messages", () => {
			const session = store.createSession();
			expect(store.getMessages(session.id)).toEqual([]);
		});

		it("returns messages in chronological order", async () => {
			const session = store.createSession();
			store.addMessage(session.id, "user", "First");
			await new Promise((r) => setTimeout(r, 5));
			store.addMessage(session.id, "assistant", "Second");
			const messages = store.getMessages(session.id);
			expect(messages).toHaveLength(2);
			expect(messages[0]?.role).toBe("user");
			expect(messages[0]?.content).toBe("First");
			expect(messages[1]?.role).toBe("assistant");
			expect(messages[1]?.content).toBe("Second");
		});

		it("returns empty array for nonexistent session", () => {
			expect(store.getMessages("nonexistent")).toEqual([]);
		});

		it("only returns messages for the correct session", () => {
			const s1 = store.createSession();
			const s2 = store.createSession();
			store.addMessage(s1.id, "user", "For session 1");
			store.addMessage(s2.id, "user", "For session 2");
			const s1Messages = store.getMessages(s1.id);
			expect(s1Messages).toHaveLength(1);
			expect(s1Messages[0]?.content).toBe("For session 1");
		});
	});
});
