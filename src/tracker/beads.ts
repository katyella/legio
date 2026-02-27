/**
 * Beads adapter for the tracker abstraction layer.
 *
 * Wraps src/beads/client.ts to implement TrackerClient using the bd CLI.
 */

import { spawn } from "node:child_process";
import { createBeadsClient } from "../beads/client.ts";
import { AgentError } from "../errors.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Run a shell command and capture output.
 */
async function runCommand(
	cmd: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const [command, ...args] = cmd;
	if (!command) throw new Error("Empty command");
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
		proc.stdout.on("data", (data: Buffer) => chunks.stdout.push(data));
		proc.stderr.on("data", (data: Buffer) => chunks.stderr.push(data));
		proc.on("error", reject);
		proc.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(chunks.stdout).toString(),
				stderr: Buffer.concat(chunks.stderr).toString(),
				exitCode: code ?? 1,
			});
		});
	});
}

/**
 * Create a TrackerClient backed by the beads (bd) CLI.
 *
 * Delegates to createBeadsClient for all operations; adds sync() support
 * by spawning `bd sync` directly.
 *
 * @param cwd - Working directory where bd commands should run
 */
export function createBeadsTrackerClient(cwd: string): TrackerClient {
	const beads = createBeadsClient(cwd);

	return {
		async ready(options): Promise<TrackerIssue[]> {
			return beads.ready(options);
		},

		async show(id): Promise<TrackerIssue> {
			return beads.show(id);
		},

		async create(title, options): Promise<string> {
			return beads.create(title, options);
		},

		async claim(id): Promise<void> {
			return beads.claim(id);
		},

		async close(id, reason): Promise<void> {
			return beads.close(id, reason);
		},

		async list(options): Promise<TrackerIssue[]> {
			return beads.list(options);
		},

		async sync(): Promise<void> {
			const { exitCode, stderr } = await runCommand(["bd", "sync"], cwd);
			if (exitCode !== 0) {
				throw new AgentError(`bd sync failed (exit ${exitCode}): ${stderr.trim()}`);
			}
		},
	};
}
