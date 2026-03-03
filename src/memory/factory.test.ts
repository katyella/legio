/**
 * Tests for the memory backend factory.
 *
 * Uses real temp directories to test auto-detection — no mocks.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryClient, resolveMemoryBackend } from "./factory.ts";

describe("resolveMemoryBackend", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "legio-mem-factory-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns 'builtin' when no .mulch/ directory exists", () => {
		expect(resolveMemoryBackend(tmpDir)).toBe("builtin");
	});

	it("returns 'mulch' when .mulch/ directory exists", async () => {
		await mkdir(join(tmpDir, ".mulch"));
		expect(resolveMemoryBackend(tmpDir)).toBe("mulch");
	});
});

describe("createMemoryClient", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "legio-mem-factory-"));
		// Create .legio/ so the builtin backend can create memory.db
		await mkdir(join(tmpDir, ".legio"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("creates a builtin client when backend is 'builtin'", async () => {
		const client = createMemoryClient("builtin", tmpDir);
		expect(client).toBeDefined();
		expect(client.dispose).toBeDefined();

		// Should be able to record and read back
		const id = await client.record("test", {
			type: "convention",
			description: "test record",
		});
		expect(id).toMatch(/^mem-/);

		const record = await client.show(id);
		expect(record.domain).toBe("test");

		client.dispose?.();
	});

	it("creates a builtin client for 'auto' when no .mulch/ exists", async () => {
		const client = createMemoryClient("auto", tmpDir);
		expect(client).toBeDefined();
		expect(client.dispose).toBeDefined();

		// Verify it works (builtin backend creates the DB on demand)
		const stats = await client.status();
		expect(stats).toEqual([]);

		client.dispose?.();
	});
});
