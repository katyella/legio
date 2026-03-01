/**
 * Tracker factory with auto-detection.
 *
 * Detects which tracker backend is present in the project root and
 * returns the appropriate TrackerClient.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBeadsTrackerClient } from "./beads.ts";
import { createSeedsTrackerClient } from "./seeds.ts";
import type { TrackerBackend, TrackerClient } from "./types.ts";

// Re-export types for convenience
export type { TrackerBackend, TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Auto-detect which tracker backend to use.
 * Checks .seeds/ first, then .beads/. Defaults to seeds.
 *
 * @param cwd - Directory to search for tracker markers
 */
export function resolveBackend(cwd: string): "seeds" | "beads" {
	if (existsSync(join(cwd, ".seeds"))) return "seeds";
	if (existsSync(join(cwd, ".beads"))) return "beads";
	return "seeds"; // default
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
	}
}

/**
 * Return the CLI tool name for a resolved backend.
 * Used by the overlay generator to inject {{TRACKER_CLI}} into agent definitions.
 */
export function trackerCliName(backend: "seeds" | "beads"): string {
	return backend === "seeds" ? "sd" : "bd";
}

/**
 * Return the human-readable tracker name for a resolved backend.
 * Used by the overlay generator to inject {{TRACKER_NAME}} into agent definitions.
 */
export function trackerDisplayName(backend: "seeds" | "beads"): string {
	return backend === "seeds" ? "seeds" : "beads";
}
