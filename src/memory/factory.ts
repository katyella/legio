/**
 * Memory backend factory with auto-detection.
 *
 * Detects which memory backend is present in the project root and
 * returns the appropriate MemoryClient.
 *
 * Pattern follows src/tracker/factory.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBuiltinMemoryClient } from "./builtin.ts";
import { createMulchMemoryClient } from "./mulch.ts";
import type { MemoryBackend, MemoryClient } from "./types.ts";

// Re-export types for convenience
export type { DomainStats, MemoryBackend, MemoryClient, MemoryRecord } from "./types.ts";

/**
 * Auto-detect which memory backend to use.
 * Checks for .mulch/ directory. Defaults to builtin.
 *
 * @param cwd - Directory to search for backend markers
 */
export function resolveMemoryBackend(cwd: string): "mulch" | "builtin" {
	if (existsSync(join(cwd, ".mulch"))) return "mulch";
	return "builtin";
}

/**
 * Create a MemoryClient for the given backend.
 *
 * @param backend - The backend to use ("auto" detects from filesystem)
 * @param cwd - Working directory for CLI commands and backend detection
 */
export function createMemoryClient(backend: MemoryBackend, cwd: string): MemoryClient {
	const resolved = backend === "auto" ? resolveMemoryBackend(cwd) : backend;
	switch (resolved) {
		case "mulch":
			return createMulchMemoryClient(cwd);
		case "builtin":
			return createBuiltinMemoryClient(join(cwd, ".legio", "memory.db"));
	}
}
