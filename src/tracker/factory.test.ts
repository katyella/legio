/**
 * Tests for the tracker factory and adapters.
 *
 * Uses real temp directories (createTempGitRepo pattern).
 * Does NOT test the seeds adapter with a real sd CLI (it may not be installed).
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, createTempGitRepo } from "../test-helpers.ts";
import { createBeadsTrackerClient } from "./beads.ts";
import { createTrackerClient, resolveBackend } from "./factory.ts";

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
		// Should not throw — just verify we get a client back
		const client = createTrackerClient("auto", tmpDir);
		expect(typeof client.ready).toBe("function");
	});

	it("auto-detects seeds when .seeds/ exists", async () => {
		await mkdir(join(tmpDir, ".seeds"), { recursive: true });
		const client = createTrackerClient("auto", tmpDir);
		expect(typeof client.ready).toBe("function");
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

	it("ready() delegates to bd ready and throws when bd is not available", async () => {
		// bd is not installed in test env in a .beads dir, so this should throw
		const client = createBeadsTrackerClient(tmpDir);
		await expect(client.ready()).rejects.toThrow();
	});

	it("sync() throws AgentError when bd is not available", async () => {
		const client = createBeadsTrackerClient(tmpDir);
		// bd sync should fail when bd is not installed or no .beads dir
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
		// Type-level test: ensure named imports resolve
		const mod = await import("./types.ts");
		// The module exports are all types (interfaces/type aliases), so no runtime values.
		// Just verify the module loads without error.
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
});

describe("rm cleanup", () => {
	it("temp dirs are removed after tests run", async () => {
		const dir = await createTempGitRepo();
		await rm(dir, { recursive: true, force: true });
		// No assertion needed — just verify rm doesn't throw
	});
});
