/**
 * Pending nudge marker utilities for inter-agent mail delivery.
 *
 * Instead of sending tmux keys (which corrupt tool I/O), auto-nudge writes
 * a JSON marker file per agent. The `mail check --inject` flow reads and
 * clears these markers, prepending a priority banner to the injected output.
 *
 * Extracted from src/commands/mail.ts for shared use by the watchman daemon.
 */

import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Shape of a pending nudge marker file. */
export interface PendingNudge {
	from: string;
	reason: string;
	subject: string;
	messageId: string;
	createdAt: string;
}

/** Directory where pending nudge markers are stored. */
export function pendingNudgeDir(cwd: string): string {
	return join(cwd, ".legio", "pending-nudges");
}

/**
 * Write a pending nudge marker for an agent.
 *
 * Creates `.legio/pending-nudges/{agent}.json` so that the next
 * `mail check --inject` call surfaces a priority banner for this message.
 * Overwrites any existing marker (only the latest nudge matters).
 */
export async function writePendingNudge(
	cwd: string,
	agentName: string,
	nudge: Omit<PendingNudge, "createdAt">,
): Promise<void> {
	const dir = pendingNudgeDir(cwd);
	await mkdir(dir, { recursive: true });

	const marker: PendingNudge = {
		...nudge,
		createdAt: new Date().toISOString(),
	};
	const filePath = join(dir, `${agentName}.json`);
	const tmpPath = `${filePath}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(marker, null, "\t")}\n`);
	await rename(tmpPath, filePath);
}

/**
 * Read and clear pending nudge markers for an agent.
 *
 * Returns the pending nudge (if any) and removes the marker file.
 * Called by `mail check --inject` to prepend a priority banner.
 */
export async function readAndClearPendingNudge(
	cwd: string,
	agentName: string,
): Promise<PendingNudge | null> {
	const filePath = join(pendingNudgeDir(cwd), `${agentName}.json`);
	try {
		await access(filePath);
	} catch {
		return null;
	}
	try {
		const text = await readFile(filePath, "utf-8");
		const nudge = JSON.parse(text) as PendingNudge;
		await unlink(filePath);
		return nudge;
	} catch {
		// Corrupt or race condition — clear it and move on
		try {
			await unlink(filePath);
		} catch {
			// Already gone
		}
		return null;
	}
}

/**
 * Check if a pending nudge marker exists for an agent.
 */
export async function pendingNudgeExists(cwd: string, agentName: string): Promise<boolean> {
	const filePath = join(pendingNudgeDir(cwd), `${agentName}.json`);
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if an agent is idle (not actively executing a tool).
 *
 * An agent is considered idle when `.legio/agent-busy/{agentName}` does NOT exist
 * or when the marker is stale (older than 5 minutes, indicating a crashed agent).
 * The busy marker contains an ISO timestamp written by hooks during active tool execution.
 * Idle agents can receive a direct tmux nudge; busy agents only get the pending marker.
 */
export async function isAgentIdle(cwd: string, agentName: string): Promise<boolean> {
	const busyPath = join(cwd, ".legio", "agent-busy", agentName);
	try {
		const timestamp = await readFile(busyPath, "utf-8");
		const age = Date.now() - new Date(timestamp.trim()).getTime();
		if (age > 5 * 60 * 1000) {
			// Stale marker from crashed agent — clean up
			await unlink(busyPath).catch(() => {});
			return true;
		}
		return false; // busy marker present and fresh — agent is actively working
	} catch {
		return true; // no busy marker — agent is idle
	}
}
