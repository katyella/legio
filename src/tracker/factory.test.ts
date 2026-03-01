/**
 * Tests for the tracker factory, adapters, and normalizeIssue logic.
 *
 * Uses real temp directories (createTempGitRepo pattern).
 * Does NOT test the seeds/beads adapters with real CLIs (they may not be installed).
 * DOES test normalizeIssue which is pure logic requiring no CLI.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { createBeadsTrackerClient } from "./beads.ts";
import { createTrackerClient, resolveBackend } from "./factory.ts";
import { normalizeIssue } from "./seeds.ts";

describe("resolveBackend", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await createTempGitRepo();
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	it("returns 'seeds' when .seeds/ directory exists", async () => {
		await mkdir(join(tmpDir, ".seeds"), { recursive: true });
		expect(resolveBackend(tmpDir)).toBe("seeds");
	});

	it("returns 'beads' when .beads/ directory exists (no .seeds/)", async () => {
		await mkdir(join(tmpDir, ".beads"), { recursive: true });
		expect(resolveBackend(tmpDir)).toBe("beads");
	});

	it("prefers .seeds/ over .beads/ when both exist", async () => {
		await mkdir(join(tmpDir, ".seeds"), { recursive: true });
		await mkdir(join(tmpDir, ".beads"), { recursive: true });
		expect(resolveBackend(tmpDir)).toBe("seeds");
	});

	it("defaults to 'seeds' when neither directory exists", () => {
		expect(resolveBackend(tmpDir)).toBe("seeds");
	});
});

describe("createTrackerClient", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await createTempGitRepo();
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	it("returns a TrackerClient object for 'beads' backend", () => {
		const client = createTrackerClient("beads", tmpDir);
		expect(typeof client.ready).toBe("function");
		expect(typeof client.show).toBe("function");
		expect(typeof client.create).toBe("function");
		expect(typeof client.claim).toBe("function");
		expect(typeof client.close).toBe("function");
		expect(typeof client.list).toBe("function");
		expect(typeof client.sync).toBe("function");
	});

	it("returns a TrackerClient object for 'seeds' backend", () => {
		const client = createTrackerClient("seeds", tmpDir);
		expect(typeof client.ready).toBe("function");
		expect(typeof client.show).toBe("function");
		expect(typeof client.create).toBe("function");
		expect(typeof client.claim).toBe("function");
		expect(typeof client.close).toBe("function");
		expect(typeof client.list).toBe("function");
		expect(typeof client.sync).toBe("function");
	});

	it("returns a TrackerClient object for 'auto' backend (no marker dirs)", () => {
		const client = createTrackerClient("auto", tmpDir);
		expect(typeof client.ready).toBe("function");
	});

	it("auto-detects beads when .beads/ exists", async () => {
		await mkdir(join(tmpDir, ".beads"), { recursive: true });
		const client = createTrackerClient("auto", tmpDir);
		expect(typeof client.ready).toBe("function");
	});

	it("auto-detects seeds when .seeds/ exists", async () => {
		await mkdir(join(tmpDir, ".seeds"), { recursive: true });
		const client = createTrackerClient("auto", tmpDir);
		expect(typeof client.ready).toBe("function");
	});
});

describe("normalizeIssue", () => {
	it("maps snake_case fields to camelCase", () => {
		const result = normalizeIssue({
			id: "test-1",
			title: "Test issue",
			status: "open",
			priority: 2,
			issue_type: "task",
			owner: "alice",
			blocked_by: ["test-0"],
			closed_at: "2026-01-01T00:00:00Z",
			close_reason: "done",
			created_at: "2025-12-01T00:00:00Z",
		});

		expect(result.id).toBe("test-1");
		expect(result.title).toBe("Test issue");
		expect(result.status).toBe("open");
		expect(result.priority).toBe(2);
		expect(result.type).toBe("task");
		expect(result.assignee).toBe("alice");
		expect(result.blockedBy).toEqual(["test-0"]);
		expect(result.closedAt).toBe("2026-01-01T00:00:00Z");
		expect(result.closeReason).toBe("done");
		expect(result.createdAt).toBe("2025-12-01T00:00:00Z");
	});

	it("prefers issue_type over type", () => {
		const result = normalizeIssue({
			id: "t-1",
			title: "T",
			status: "open",
			priority: 1,
			issue_type: "bug",
			type: "task",
		});
		expect(result.type).toBe("bug");
	});

	it("falls back to type when issue_type is absent", () => {
		const result = normalizeIssue({
			id: "t-1",
			title: "T",
			status: "open",
			priority: 1,
			type: "feature",
		});
		expect(result.type).toBe("feature");
	});

	it("defaults type to 'unknown' when both are absent", () => {
		const result = normalizeIssue({
			id: "t-1",
			title: "T",
			status: "open",
			priority: 1,
		});
		expect(result.type).toBe("unknown");
	});

	it("prefers owner over assignee", () => {
		const result = normalizeIssue({
			id: "t-1",
			title: "T",
			status: "open",
			priority: 1,
			owner: "bob",
			assignee: "alice",
		});
		expect(result.assignee).toBe("bob");
	});

	it("falls back to assignee when owner is absent", () => {
		const result = normalizeIssue({
			id: "t-1",
			title: "T",
			status: "open",
			priority: 1,
			assignee: "alice",
		});
		expect(result.assignee).toBe("alice");
	});

	it("prefers blocked_by over blockedBy", () => {
		const result = normalizeIssue({
			id: "t-1",
			title: "T",
			status: "open",
			priority: 1,
			blocked_by: ["a"],
			blockedBy: ["b"],
		});
		expect(result.blockedBy).toEqual(["a"]);
	});

	it("handles minimal input with only required fields", () => {
		const result = normalizeIssue({
			id: "t-1",
			title: "Minimal",
			status: "open",
			priority: 3,
		});
		expect(result.id).toBe("t-1");
		expect(result.type).toBe("unknown");
		expect(result.assignee).toBeUndefined();
		expect(result.blockedBy).toBeUndefined();
		expect(result.closedAt).toBeUndefined();
		expect(result.closeReason).toBeUndefined();
		expect(result.createdAt).toBeUndefined();
		expect(result.description).toBeUndefined();
		expect(result.blocks).toBeUndefined();
	});
});

describe("createBeadsTrackerClient", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await createTempGitRepo();
	});

	afterEach(async () => {
		await cleanupTempDir(tmpDir);
	});

	it("returns an object implementing TrackerClient interface", () => {
		const client = createBeadsTrackerClient(tmpDir);
		expect(typeof client.ready).toBe("function");
		expect(typeof client.show).toBe("function");
		expect(typeof client.create).toBe("function");
		expect(typeof client.claim).toBe("function");
		expect(typeof client.close).toBe("function");
		expect(typeof client.list).toBe("function");
		expect(typeof client.sync).toBe("function");
	});

	it("ready() throws when bd is not available", async () => {
		const client = createBeadsTrackerClient(tmpDir);
		await expect(client.ready()).rejects.toThrow();
	});

	it("sync() throws when bd is not available", async () => {
		const client = createBeadsTrackerClient(tmpDir);
		await expect(client.sync()).rejects.toThrow();
	});

	it("show() throws when bd is not available", async () => {
		const client = createBeadsTrackerClient(tmpDir);
		await expect(client.show("test-id")).rejects.toThrow();
	});

	it("list() throws when bd is not available", async () => {
		const client = createBeadsTrackerClient(tmpDir);
		await expect(client.list()).rejects.toThrow();
	});
});

describe("tracker module exports", () => {
	it("types.ts exports TrackerIssue, TrackerBackend, TrackerClient", async () => {
		const mod = await import("./types.ts");
		expect(mod).toBeDefined();
	});

	it("factory.ts exports resolveBackend and createTrackerClient", async () => {
		const mod = await import("./factory.ts");
		expect(typeof mod.resolveBackend).toBe("function");
		expect(typeof mod.createTrackerClient).toBe("function");
	});

	it("beads.ts exports createBeadsTrackerClient", async () => {
		const mod = await import("./beads.ts");
		expect(typeof mod.createBeadsTrackerClient).toBe("function");
	});

	it("seeds.ts exports createSeedsTrackerClient", async () => {
		const mod = await import("./seeds.ts");
		expect(typeof mod.createSeedsTrackerClient).toBe("function");
	});

	it("exec.ts exports runTrackerCommand", async () => {
		const mod = await import("./exec.ts");
		expect(typeof mod.runTrackerCommand).toBe("function");
	});
});
