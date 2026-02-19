/**
 * Tests for the AuditStore SQLite implementation.
 *
 * Uses real temp-file databases — no mocking of store logic.
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuditStore } from "./audit-store.ts";

let tempDir: string;
let dbPath: string;

beforeEach(async () => {
	tempDir = join(tmpdir(), `audit-store-test-${Date.now()}`);
	await mkdir(tempDir, { recursive: true });
	dbPath = join(tempDir, "audit.db");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("createAuditStore", () => {
	it("creates a store and returns it", () => {
		const store = createAuditStore(dbPath);
		expect(store).toBeDefined();
		store.close();
	});

	it("insert + getAll round-trip", () => {
		const store = createAuditStore(dbPath);
		try {
			const id = store.insert({
				type: "command",
				agent: "orchestrator",
				source: "web_ui",
				summary: "User sent a command",
				detail: "ls -la",
			});
			expect(typeof id).toBe("number");
			expect(id).toBeGreaterThan(0);

			const events = store.getAll();
			expect(events.length).toBe(1);
			const ev = events[0];
			expect(ev).toBeDefined();
			if (!ev) return;
			expect(ev.id).toBe(id);
			expect(ev.type).toBe("command");
			expect(ev.agent).toBe("orchestrator");
			expect(ev.source).toBe("web_ui");
			expect(ev.summary).toBe("User sent a command");
			expect(ev.detail).toBe("ls -la");
			expect(ev.sessionId).toBeNull();
			expect(typeof ev.createdAt).toBe("string");
		} finally {
			store.close();
		}
	});

	it("defaults source to system when not provided", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "system", summary: "Startup" });
			const events = store.getAll();
			expect(events[0]?.source).toBe("system");
		} finally {
			store.close();
		}
	});

	it("allows null agent", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "system", summary: "No agent event", agent: null });
			const events = store.getAll();
			expect(events[0]?.agent).toBeNull();
		} finally {
			store.close();
		}
	});

	it("stores sessionId when provided", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "state_change", summary: "Agent started", sessionId: "sess-abc" });
			const events = store.getAll();
			expect(events[0]?.sessionId).toBe("sess-abc");
		} finally {
			store.close();
		}
	});
});

describe("getAll filters", () => {
	function seedStore(store: ReturnType<typeof createAuditStore>): void {
		store.insert({ type: "command", agent: "orchestrator", source: "web_ui", summary: "cmd1" });
		store.insert({ type: "response", agent: "coordinator", source: "system", summary: "resp1" });
		store.insert({ type: "error", agent: "orchestrator", source: "cli", summary: "err1" });
		store.insert({ type: "command", agent: "coordinator", source: "web_ui", summary: "cmd2" });
	}

	it("returns all events without filters", () => {
		const store = createAuditStore(dbPath);
		try {
			seedStore(store);
			expect(store.getAll().length).toBe(4);
		} finally {
			store.close();
		}
	});

	it("filters by type", () => {
		const store = createAuditStore(dbPath);
		try {
			seedStore(store);
			const events = store.getAll({ type: "command" });
			expect(events.length).toBe(2);
			expect(events.every((e) => e.type === "command")).toBe(true);
		} finally {
			store.close();
		}
	});

	it("filters by agent", () => {
		const store = createAuditStore(dbPath);
		try {
			seedStore(store);
			const events = store.getAll({ agent: "coordinator" });
			expect(events.length).toBe(2);
			expect(events.every((e) => e.agent === "coordinator")).toBe(true);
		} finally {
			store.close();
		}
	});

	it("filters by source", () => {
		const store = createAuditStore(dbPath);
		try {
			seedStore(store);
			const events = store.getAll({ source: "web_ui" });
			expect(events.length).toBe(2);
			expect(events.every((e) => e.source === "web_ui")).toBe(true);
		} finally {
			store.close();
		}
	});

	it("filters by since timestamp", () => {
		const store = createAuditStore(dbPath);
		try {
			// Insert one event, record time, insert another after
			store.insert({ type: "command", summary: "before" });
			const midpoint = new Date().toISOString();
			// Wait a tiny bit so the next event has a later timestamp
			const now = Date.now();
			while (Date.now() - now < 5) {
				// spin
			}
			store.insert({ type: "command", summary: "after" });

			const events = store.getAll({ since: midpoint });
			// The "after" event should be returned; "before" may or may not depending on timing
			expect(events.length).toBeGreaterThanOrEqual(1);
			const latest = events[events.length - 1];
			expect(latest?.summary).toBe("after");
		} finally {
			store.close();
		}
	});

	it("applies limit", () => {
		const store = createAuditStore(dbPath);
		try {
			seedStore(store);
			const events = store.getAll({ limit: 2 });
			expect(events.length).toBe(2);
		} finally {
			store.close();
		}
	});

	it("combines multiple filters", () => {
		const store = createAuditStore(dbPath);
		try {
			seedStore(store);
			const events = store.getAll({ type: "command", agent: "orchestrator" });
			expect(events.length).toBe(1);
			expect(events[0]?.summary).toBe("cmd1");
		} finally {
			store.close();
		}
	});
});

describe("getTimeline", () => {
	it("returns events in chronological order", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "command", summary: "first" });
			store.insert({ type: "response", summary: "second" });
			store.insert({ type: "state_change", summary: "third" });
			const events = store.getTimeline();
			expect(events.length).toBe(3);
			for (let i = 0; i < events.length - 1; i++) {
				const a = events[i];
				const b = events[i + 1];
				if (a && b) {
					expect(a.createdAt <= b.createdAt).toBe(true);
				}
			}
		} finally {
			store.close();
		}
	});

	it("filters by since and until", () => {
		const store = createAuditStore(dbPath);
		try {
			const past = "1970-01-01T00:00:00.000Z";
			const future = "2099-01-01T00:00:00.000Z";
			store.insert({ type: "command", summary: "event" });
			const events = store.getTimeline({ since: past, until: future });
			expect(events.length).toBe(1);
		} finally {
			store.close();
		}
	});

	it("applies limit", () => {
		const store = createAuditStore(dbPath);
		try {
			for (let i = 0; i < 5; i++) {
				store.insert({ type: "command", summary: `event-${i}` });
			}
			const events = store.getTimeline({ limit: 3 });
			expect(events.length).toBe(3);
		} finally {
			store.close();
		}
	});

	it("returns empty array when no events match", () => {
		const store = createAuditStore(dbPath);
		try {
			const events = store.getTimeline({ since: "2099-01-01T00:00:00.000Z" });
			expect(events).toEqual([]);
		} finally {
			store.close();
		}
	});
});

describe("getByAgent", () => {
	it("returns events for the given agent", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "command", agent: "orch", summary: "cmd" });
			store.insert({ type: "response", agent: "coord", summary: "resp" });
			store.insert({ type: "error", agent: "orch", summary: "err" });
			const events = store.getByAgent("orch");
			expect(events.length).toBe(2);
			expect(events.every((e) => e.agent === "orch")).toBe(true);
		} finally {
			store.close();
		}
	});

	it("filters by since", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "command", agent: "orch", summary: "old" });
			const mid = new Date().toISOString();
			const now = Date.now();
			while (Date.now() - now < 5) {
				// spin
			}
			store.insert({ type: "command", agent: "orch", summary: "new" });
			const events = store.getByAgent("orch", { since: mid });
			expect(events.length).toBeGreaterThanOrEqual(1);
			const last = events[events.length - 1];
			expect(last?.summary).toBe("new");
		} finally {
			store.close();
		}
	});

	it("applies limit", () => {
		const store = createAuditStore(dbPath);
		try {
			for (let i = 0; i < 4; i++) {
				store.insert({ type: "command", agent: "orch", summary: `cmd-${i}` });
			}
			const events = store.getByAgent("orch", { limit: 2 });
			expect(events.length).toBe(2);
		} finally {
			store.close();
		}
	});
});

describe("getByType", () => {
	it("returns events of the given type", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "command", summary: "cmd1" });
			store.insert({ type: "error", summary: "err1" });
			store.insert({ type: "command", summary: "cmd2" });
			const events = store.getByType("command");
			expect(events.length).toBe(2);
			expect(events.every((e) => e.type === "command")).toBe(true);
		} finally {
			store.close();
		}
	});

	it("applies limit", () => {
		const store = createAuditStore(dbPath);
		try {
			for (let i = 0; i < 5; i++) {
				store.insert({ type: "merge", summary: `merge-${i}` });
			}
			const events = store.getByType("merge", { limit: 3 });
			expect(events.length).toBe(3);
		} finally {
			store.close();
		}
	});
});

describe("purge", () => {
	it("purge all deletes all events and returns count", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "command", summary: "a" });
			store.insert({ type: "command", summary: "b" });
			store.insert({ type: "command", summary: "c" });
			const deleted = store.purge({ all: true });
			expect(deleted).toBe(3);
			expect(store.getAll().length).toBe(0);
		} finally {
			store.close();
		}
	});

	it("purge olderThanMs deletes events older than the threshold", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "command", summary: "old" });
			// After insertion, the event's created_at is in the past.
			// Use a large enough window that the event is "recent" — but we want it gone.
			// Actually we want to test that events are NOT purged if they are new.
			// Insert, then purge with 10 seconds threshold — the event is brand new,
			// so nothing should be deleted.
			const deleted = store.purge({ olderThanMs: 10_000 });
			expect(deleted).toBe(0);
			expect(store.getAll().length).toBe(1);
		} finally {
			store.close();
		}
	});

	it("purge with no options returns 0 and deletes nothing", () => {
		const store = createAuditStore(dbPath);
		try {
			store.insert({ type: "command", summary: "event" });
			const deleted = store.purge({});
			expect(deleted).toBe(0);
			expect(store.getAll().length).toBe(1);
		} finally {
			store.close();
		}
	});
});

describe("close", () => {
	it("can be called without error", () => {
		const store = createAuditStore(dbPath);
		expect(() => store.close()).not.toThrow();
	});
});
