/**
 * CLI command: legio down
 *
 * Single command to cleanly stop the full legio stack:
 * 1. Stop coordinator (if running) via legio coordinator stop
 *    This also stops the watchdog and monitor agents.
 * 2. Stop gateway (if running) via legio gateway stop
 * 3. Stop server (if running) via legio server stop
 *
 * Running legio down when nothing is running prints "Nothing to stop".
 */

import { spawn } from "node:child_process";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
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

/** Dependency injection interface for testing. */
export interface DownDeps {
	_runCommand?: (
		cmd: string[],
		opts?: { cwd?: string },
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	_projectRoot?: string;
}

const DOWN_HELP = `legio down — Stop the full legio stack

Usage: legio down [options]

Options:
  --json         JSON output
  --help, -h     Show this help

legio down stops the coordinator (including watchdog and monitor), the
gateway agent, and the server. Running legio down when nothing is running
is a safe no-op.`;

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
	const projectRoot = deps._projectRoot ?? process.cwd();

	let coordinatorStopped = false;
	let gatewayStopped = false;
	let serverStopped = false;

	// 1. Stop coordinator (if running) — also stops watchdog + monitor
	const coordStop = await run(["legio", "coordinator", "stop"], { cwd: projectRoot });
	if (coordStop.exitCode === 0) {
		coordinatorStopped = true;
		if (!json && coordStop.stdout) process.stdout.write(coordStop.stdout);
	}
	// Non-zero exit means coordinator was not running — that's fine, not an error.

	// 2. Stop gateway (if running) — non-fatal if not running
	const gatewayStop = await run(["legio", "gateway", "stop"], { cwd: projectRoot });
	if (gatewayStop.exitCode === 0) {
		gatewayStopped = true;
		if (!json && gatewayStop.stdout) process.stdout.write(gatewayStop.stdout);
	}
	// Non-zero exit means gateway was not running — that's fine, not an error.

	// 3. Stop server — delegate all PID checking to `legio server stop`
	const serverStop = await run(["legio", "server", "stop"], { cwd: projectRoot });
	if (serverStop.exitCode === 0 && !serverStop.stdout.includes("not running")) {
		serverStopped = true;
		if (!json && serverStop.stdout) process.stdout.write(serverStop.stdout);
	}

	const nothingToStop = !coordinatorStopped && !gatewayStopped && !serverStopped;

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ coordinatorStopped, gatewayStopped, serverStopped, nothingToStop })}\n`,
		);
	} else if (nothingToStop) {
		process.stdout.write("Nothing to stop\n");
	} else {
		process.stdout.write("Legio stack stopped\n");
	}
}
