import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LifecycleError } from "../errors.ts";
import type { SessionCheckpoint } from "../types.ts";

const CHECKPOINT_FILENAME = "checkpoint.json";

/**
 * Save a session checkpoint to disk.
 *
 * Writes to `{agentsDir}/{checkpoint.agentName}/checkpoint.json`.
 * Creates the directory if it doesn't exist.
 */
export async function saveCheckpoint(
	agentsDir: string,
	checkpoint: SessionCheckpoint,
): Promise<void> {
	const filePath = join(agentsDir, checkpoint.agentName, CHECKPOINT_FILENAME);
	const dir = dirname(filePath);

	try {
		await mkdir(dir, { recursive: true });
	} catch (err) {
		throw new LifecycleError(`Failed to create checkpoint directory: ${dir}`, {
			agentName: checkpoint.agentName,
			sessionId: checkpoint.sessionId,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		await Bun.write(filePath, `${JSON.stringify(checkpoint, null, "\t")}\n`);
	} catch (err) {
		throw new LifecycleError(`Failed to write checkpoint: ${filePath}`, {
			agentName: checkpoint.agentName,
			sessionId: checkpoint.sessionId,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/**
 * Load a session checkpoint from disk.
 *
 * Reads from `{agentsDir}/{agentName}/checkpoint.json`.
 * Returns null if the file doesn't exist.
 */
export async function loadCheckpoint(
	agentsDir: string,
	agentName: string,
): Promise<SessionCheckpoint | null> {
	const filePath = join(agentsDir, agentName, CHECKPOINT_FILENAME);
	const file = Bun.file(filePath);
	const exists = await file.exists();

	if (!exists) {
		return null;
	}

	let text: string;
	try {
		text = await file.text();
	} catch (err) {
		throw new LifecycleError(`Failed to read checkpoint: ${filePath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}

	try {
		return JSON.parse(text) as SessionCheckpoint;
	} catch (err) {
		throw new LifecycleError(`Failed to parse checkpoint JSON: ${filePath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}

/**
 * Clear (delete) a session checkpoint from disk.
 *
 * Removes `{agentsDir}/{agentName}/checkpoint.json`.
 * No error if the file doesn't exist.
 */
export async function clearCheckpoint(agentsDir: string, agentName: string): Promise<void> {
	const filePath = join(agentsDir, agentName, CHECKPOINT_FILENAME);

	try {
		await unlink(filePath);
	} catch (err) {
		// ENOENT means file doesn't exist — that's fine
		if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw new LifecycleError(`Failed to clear checkpoint: ${filePath}`, {
			agentName,
			cause: err instanceof Error ? err : undefined,
		});
	}
}
