import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LifecycleError } from "../errors.ts";
import type { SessionCheckpoint, SessionHandoff } from "../types.ts";
import { clearCheckpoint, loadCheckpoint, saveCheckpoint } from "./checkpoint.ts";

const HANDOFFS_FILENAME = "handoffs.json";

/**
 * Load handoffs array from disk.
 * Returns an empty array if the file doesn't exist.
 */
async function loadHandoffs(agentsDir: string, agentName: string): Promise<SessionHandoff[]> {
	const filePath = join(agentsDir, agentName, HANDOFFS_FILENAME);
	const file = Bun.file(filePath);
	const exists = await file.exists();

	if (!exists) {
		return [];
	}

	try {
		const text = await file.text();
		return JSON.parse(text) as SessionHandoff[];
	} catch (err) {
		throw new LifecycleError(`Failed to read handoffs: ${filePath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/**
 * Write handoffs array to disk.
 */
async function writeHandoffs(
	agentsDir: string,
	agentName: string,
	handoffs: SessionHandoff[],
): Promise<void> {
	const filePath = join(agentsDir, agentName, HANDOFFS_FILENAME);
	const dir = dirname(filePath);

	try {
		await mkdir(dir, { recursive: true });
	} catch (err) {
		throw new LifecycleError(`Failed to create handoffs directory: ${dir}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		await Bun.write(filePath, `${JSON.stringify(handoffs, null, "\t")}\n`);
	} catch (err) {
		throw new LifecycleError(`Failed to write handoffs: ${filePath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/**
 * Initiate a session handoff.
 *
 * 1. Builds a SessionCheckpoint from options
 * 2. Saves the checkpoint to disk
 * 3. Builds a SessionHandoff record
 * 4. Appends to handoffs.json
 * 5. Returns the handoff
 */
export async function initiateHandoff(options: {
	agentsDir: string;
	agentName: string;
	sessionId: string;
	beadId: string;
	reason: SessionHandoff["reason"];
	progressSummary: string;
	pendingWork: string;
	currentBranch: string;
	filesModified: string[];
	mulchDomains: string[];
}): Promise<SessionHandoff> {
	const checkpoint: SessionCheckpoint = {
		agentName: options.agentName,
		beadId: options.beadId,
		sessionId: options.sessionId,
		timestamp: new Date().toISOString(),
		progressSummary: options.progressSummary,
		filesModified: options.filesModified,
		currentBranch: options.currentBranch,
		pendingWork: options.pendingWork,
		mulchDomains: options.mulchDomains,
	};

	await saveCheckpoint(options.agentsDir, checkpoint);

	const handoff: SessionHandoff = {
		fromSessionId: options.sessionId,
		toSessionId: null,
		checkpoint,
		reason: options.reason,
		handoffAt: new Date().toISOString(),
	};

	const handoffs = await loadHandoffs(options.agentsDir, options.agentName);
	handoffs.push(handoff);
	await writeHandoffs(options.agentsDir, options.agentName, handoffs);

	return handoff;
}

/**
 * Resume from a pending handoff.
 *
 * Finds the most recent handoff where `toSessionId` is null,
 * loads the associated checkpoint, and returns both.
 * Returns null if no pending handoff exists.
 */
export async function resumeFromHandoff(options: {
	agentsDir: string;
	agentName: string;
}): Promise<{ checkpoint: SessionCheckpoint; handoff: SessionHandoff } | null> {
	const handoffs = await loadHandoffs(options.agentsDir, options.agentName);

	// Find most recent pending handoff (search from end)
	let pendingHandoff: SessionHandoff | undefined;
	for (let i = handoffs.length - 1; i >= 0; i--) {
		const h = handoffs[i];
		if (h !== undefined && h.toSessionId === null) {
			pendingHandoff = h;
			break;
		}
	}

	if (pendingHandoff === undefined) {
		return null;
	}

	const checkpoint = await loadCheckpoint(options.agentsDir, options.agentName);
	if (checkpoint === null) {
		return null;
	}

	return { checkpoint, handoff: pendingHandoff };
}

/**
 * Complete a pending handoff.
 *
 * 1. Loads handoffs.json
 * 2. Finds the most recent handoff with toSessionId === null
 * 3. Sets toSessionId to the new session ID
 * 4. Writes back handoffs.json
 * 5. Clears the checkpoint
 */
export async function completeHandoff(options: {
	agentsDir: string;
	agentName: string;
	newSessionId: string;
}): Promise<void> {
	const handoffs = await loadHandoffs(options.agentsDir, options.agentName);

	// Find most recent pending handoff (search from end)
	let found = false;
	for (let i = handoffs.length - 1; i >= 0; i--) {
		const h = handoffs[i];
		if (h !== undefined && h.toSessionId === null) {
			h.toSessionId = options.newSessionId;
			found = true;
			break;
		}
	}

	if (!found) {
		throw new LifecycleError("No pending handoff to complete", {
			agentName: options.agentName,
		});
	}

	await writeHandoffs(options.agentsDir, options.agentName, handoffs);
	await clearCheckpoint(options.agentsDir, options.agentName);
}
