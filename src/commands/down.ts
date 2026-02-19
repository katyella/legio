/**
 * CLI command: legio down
 *
 * Single command to cleanly stop the full legio stack:
 * 1. Stop coordinator (if running) via legio coordinator stop
 *    This also stops the watchdog and monitor agents.
 * 2. Stop server (if running) via legio server stop
 *
 * Running legio down when nothing is running prints "Nothing to stop".
 */

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isProcessRunning } from "../watchdog/health.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Run an external command and collect stdout/stderr + exit code.
 */
async function runCommand(
	cmd: string[],
	opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const [command, ...args] = cmd;
	if (!command) {
		return { stdout: "", stderr: "Empty command", exitCode: 1 };
	}
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: opts?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		proc.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString(),
				exitCode: code ?? 1,
			});
		});
	});
}

/**
 * Read a PID from a PID file (first line). Returns null if not found or invalid.
 */
async function readPidFromFile(path: string): Promise<number | null> {
	try {
		const text = await readFile(path, "utf-8");
		const firstLine = text.trim().split("\n")[0] ?? "";
		const pid = Number.parseInt(firstLine, 10);
		if (Number.isNaN(pid) || pid <= 0) return null;
		return pid;
	} catch {
		return null;
	}
}

/** Dependency injection interface for testing. */
export interface DownDeps {
	_runCommand?: (
		cmd: string[],
		opts?: { cwd?: string },
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	_fileExists?: (path: string) => Promise<boolean>;
	_readPid?: (path: string) => Promise<number | null>;
	_isProcessRunning?: (pid: number) => boolean;
	_projectRoot?: string;
}

const DOWN_HELP = `legio down — Stop the full legio stack

Usage: legio down [options]

Options:
  --json         JSON output
  --help, -h     Show this help

legio down stops the coordinator (including watchdog and monitor) and the
server. Running legio down when nothing is running is a safe no-op.`;

/**
 * Entry point for \`legio down [options]\`.
 *
 * @param args - CLI arguments after "down"
 * @param deps - Optional dependency injection for testing
 */
export async function downCommand(args: string[], deps: DownDeps = {}): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${DOWN_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const run = deps._runCommand ?? runCommand;
	const fileExistsFn = deps._fileExists ?? fileExists;
	const readPidFn = deps._readPid ?? readPidFromFile;
	const isRunningFn = deps._isProcessRunning ?? isProcessRunning;
	const projectRoot = deps._projectRoot ?? process.cwd();

	let coordinatorStopped = false;
	let serverStopped = false;

	// 1. Stop coordinator (if running) — also stops watchdog + monitor
	const coordStop = await run(["legio", "coordinator", "stop"], { cwd: projectRoot });
	if (coordStop.exitCode === 0) {
		coordinatorStopped = true;
		if (!json && coordStop.stdout) process.stdout.write(coordStop.stdout);
	}
	// Non-zero exit means coordinator was not running — that's fine, not an error.

	// 2. Check server PID and stop if running
	const pidFile = join(projectRoot, ".legio", "server.pid");
	const pidFileExists = await fileExistsFn(pidFile);

	if (pidFileExists) {
		const pid = await readPidFn(pidFile);
		const serverRunning = pid !== null && isRunningFn(pid);
		if (serverRunning) {
			const serverStop = await run(["legio", "server", "stop"], { cwd: projectRoot });
			if (serverStop.exitCode === 0) {
				serverStopped = true;
				if (!json && serverStop.stdout) process.stdout.write(serverStop.stdout);
			}
		}
	}

	const nothingToStop = !coordinatorStopped && !serverStopped;

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ coordinatorStopped, serverStopped, nothingToStop })}\n`,
		);
	} else if (nothingToStop) {
		process.stdout.write("Nothing to stop\n");
	} else {
		process.stdout.write("Legio stack stopped\n");
	}
}
