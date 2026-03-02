/**
 * Tracker factory with auto-detection.
 *
 * Detects which tracker backend is present in the project root and
 * returns the appropriate TrackerClient.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBeadsTrackerClient } from "./beads.ts";
import { createBuiltinTrackerClient } from "./builtin.ts";
import { createSeedsTrackerClient } from "./seeds.ts";
import type { TrackerBackend, TrackerClient } from "./types.ts";

// Re-export types for convenience
export type { TrackerBackend, TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Auto-detect which tracker backend to use.
 * Checks .seeds/ first, then .beads/. Defaults to builtin.
 *
 * @param cwd - Directory to search for tracker markers
 */
export function resolveBackend(cwd: string): "seeds" | "beads" | "builtin" {
	if (existsSync(join(cwd, ".seeds"))) return "seeds";
	if (existsSync(join(cwd, ".beads"))) return "beads";
	return "builtin"; // default — zero-dependency SQLite backend
}

/**
 * Create a TrackerClient for the given backend.
 *
 * @param backend - The backend to use ("auto" detects from filesystem)
 * @param cwd - Working directory for CLI commands and backend detection
 */
export function createTrackerClient(backend: TrackerBackend, cwd: string): TrackerClient {
	const resolved = backend === "auto" ? resolveBackend(cwd) : backend;
	switch (resolved) {
		case "seeds":
			return createSeedsTrackerClient(cwd);
		case "beads":
			return createBeadsTrackerClient(cwd);
		case "builtin":
			return createBuiltinTrackerClient(join(cwd, ".legio", "tasks.db"));
	}
}
