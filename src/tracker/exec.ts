/**
 * Shared subprocess execution for tracker adapters.
 */

import { spawn } from "node:child_process";
import { AgentError } from "../errors.ts";

/**
 * Run a CLI command and capture its output.
 *
 * @param cmd - Command and arguments array (e.g., ["bd", "sync"])
 * @param cwd - Working directory for the subprocess
 * @param context - Human-readable context for error messages (e.g., "bd sync")
 */
export async function runTrackerCommand(
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
		proc.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") {
				reject(new AgentError(`CLI tool "${command}" not found. Is it installed and on PATH?`));
			} else {
				reject(err);
			}
		});
		proc.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(chunks.stdout).toString(),
				stderr: Buffer.concat(chunks.stderr).toString(),
				exitCode: code ?? 1,
			});
		});
	});
}
