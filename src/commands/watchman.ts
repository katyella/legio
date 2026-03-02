/**
 * CLI command: legio watchman start/stop/status
 *
 * Unified daemon combining:
 *   - Health monitoring (watchdog): session health checks, zombie detection, recovery
 *   - Mail delivery (mailman): poll for unread mail, nudge agents
 *   - Beacon safety net: detect stuck beacons and send follow-up Enter
 *
 * PID file: .legio/watchman.pid
 */

import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { LegioError } from "../errors.ts";
import type { HealthCheck } from "../types.ts";
import { startDaemon } from "../watchman/daemon.ts";
import { isProcessRunning } from "../watchman/health.ts";

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Format a health check for display.
 */
function formatCheck(check: HealthCheck): string {
	const actionIcon =
		check.action === "terminate"
			? "💀"
			: check.action === "escalate"
				? "⚠️"
				: check.action === "investigate"
					? "🔍"
					: "✅";
	const pidLabel = check.pidAlive === null ? "n/a" : check.pidAlive ? "up" : "down";
	let line = `${actionIcon} ${check.agentName}: ${check.state} (tmux=${check.tmuxAlive ? "up" : "down"}, pid=${pidLabel})`;
	if (check.reconciliationNote) {
		line += ` [${check.reconciliationNote}]`;
	}
	return line;
}

/**
 * Read the PID from the watchman PID file.
 */
async function readPidFile(pidFilePath: string): Promise<number | null> {
	try {
		const text = await readFile(pidFilePath, "utf-8");
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) return null;
		return pid;
	} catch {
		return null;
	}
}

/**
 * Write a PID to the watchman PID file.
 */
async function writePidFile(pidFilePath: string, pid: number): Promise<void> {
	await writeFile(pidFilePath, `${pid}\n`);
}

/**
 * Remove the watchman PID file.
 */
async function removePidFile(pidFilePath: string): Promise<void> {
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone
	}
}

/**
 * Resolve the path to the legio binary for re-launching.
 */
async function resolveLegioBin(): Promise<string> {
	try {
		const result = await new Promise<{ exitCode: number; stdout: string }>((resolve) => {
			const proc = spawn("which", ["legio"], { stdio: ["ignore", "pipe", "pipe"] });
			const stdoutChunks: Buffer[] = [];
			proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
			proc.on("close", (code: number | null) => {
				resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks).toString("utf-8") });
			});
		});
		if (result.exitCode === 0) {
			const binPath = result.stdout.trim();
			if (binPath.length > 0) return binPath;
		}
	} catch {
		// which not available
	}
	const scriptPath = process.argv[1];
	if (scriptPath) return scriptPath;
	throw new LegioError("Cannot resolve legio binary path for background launch", "WATCHMAN_ERROR");
}

/** Handle `legio watchman start` */
async function handleStart(args: string[]): Promise<void> {
	const background = hasFlag(args, "--background");
	const intervalStr = getFlag(args, "--interval");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;
	const intervalMs = intervalStr
		? Number.parseInt(intervalStr, 10)
		: config.watchman.tier0IntervalMs;
	const pidFilePath = join(root, ".legio", "watchman.pid");

	if (background) {
		// Check if already running
		const existingPid = await readPidFile(pidFilePath);
		if (existingPid !== null && isProcessRunning(existingPid)) {
			process.stderr.write(
				`Error: Watchman already running (PID: ${existingPid}). ` +
					`Kill it first or remove ${pidFilePath}\n`,
			);
			process.exitCode = 1;
			return;
		}

		if (existingPid !== null) {
			await removePidFile(pidFilePath);
		}

		const childArgs: string[] = ["watchman", "start"];
		if (intervalStr) {
			childArgs.push("--interval", intervalStr);
		}

		const legioBin = await resolveLegioBin();
		const child = spawn(process.execPath, ["--import", "tsx", legioBin, ...childArgs], {
			cwd,
			stdio: "ignore",
			detached: true,
		});
		child.unref();

		const childPid = child.pid ?? 0;
		await writePidFile(pidFilePath, childPid);

		process.stdout.write(
			`Watchman started in background (PID: ${childPid}, interval: ${intervalMs}ms)\n`,
		);
		process.stdout.write(`PID file: ${pidFilePath}\n`);
		return;
	}

	// Foreground mode
	process.stdout.write(
		`Watchman running (health: ${intervalMs}ms, mail: ${config.watchman.mailIntervalMs}ms)\n`,
	);
	process.stdout.write("Press Ctrl+C to stop.\n\n");

	await writePidFile(pidFilePath, process.pid);

	const { stop } = startDaemon({
		root,
		intervalMs,
		zombieThresholdMs: config.watchman.zombieThresholdMs,
		mailIntervalMs: config.watchman.mailIntervalMs,
		reNudgeIntervalMs: config.watchman.reNudgeIntervalMs,
		warnAfterMs: config.watchman.warnAfterMs,
		beaconNudgeMs: config.watchman.beaconNudgeMs,
		onHealthCheck(check) {
			const timestamp = new Date().toISOString().slice(11, 19);
			process.stdout.write(`[${timestamp}] ${formatCheck(check)}\n`);
		},
		onNudge(agentName, nudgeCount) {
			const timestamp = new Date().toISOString().slice(11, 19);
			process.stdout.write(`[${timestamp}] 📬 Nudged ${agentName} (attempt ${nudgeCount})\n`);
		},
		onWarn(agentName, unreadSinceMs) {
			const timestamp = new Date().toISOString().slice(11, 19);
			const seconds = Math.round(unreadSinceMs / 1000);
			process.stdout.write(`[${timestamp}] ⚠️  ${agentName} has had unread mail for ${seconds}s\n`);
		},
	});

	process.on("SIGINT", () => {
		stop();
		removePidFile(pidFilePath).finally(() => {
			process.stdout.write("\nWatchman stopped.\n");
			process.exit(0);
		});
	});

	// Block forever
	await new Promise(() => {});
}

/** Handle `legio watchman stop` */
async function handleStop(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const pidFilePath = join(config.project.root, ".legio", "watchman.pid");

	const pid = await readPidFile(pidFilePath);

	if (pid === null) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ stopped: false, reason: "not running" })}\n`);
		} else {
			process.stdout.write("Watchman is not running (no PID file)\n");
		}
		return;
	}

	if (!isProcessRunning(pid)) {
		await removePidFile(pidFilePath);
		if (json) {
			process.stdout.write(
				`${JSON.stringify({ stopped: false, reason: "stale PID file cleaned" })}\n`,
			);
		} else {
			process.stdout.write("Watchman is not running (stale PID file cleaned)\n");
		}
		return;
	}

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Process may have just exited
	}

	await removePidFile(pidFilePath);

	if (json) {
		process.stdout.write(`${JSON.stringify({ stopped: true, pid })}\n`);
	} else {
		process.stdout.write(`Watchman stopped (PID: ${pid})\n`);
	}
}

/** Handle `legio watchman status` */
async function handleStatus(args: string[]): Promise<void> {
	const json = hasFlag(args, "--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const pidFilePath = join(config.project.root, ".legio", "watchman.pid");

	const pid = await readPidFile(pidFilePath);

	if (pid === null) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ running: false })}\n`);
		} else {
			process.stdout.write("Watchman: not running\n");
		}
		return;
	}

	const running = isProcessRunning(pid);

	if (!running) {
		await removePidFile(pidFilePath);
	}

	if (json) {
		process.stdout.write(`${JSON.stringify({ running, pid: running ? pid : null })}\n`);
	} else if (running) {
		process.stdout.write(`Watchman: running (PID: ${pid})\n`);
	} else {
		process.stdout.write("Watchman: not running (stale PID file cleaned)\n");
	}
}

const WATCHMAN_HELP = `legio watchman — Unified daemon (health + mail + beacon)

Usage: legio watchman <subcommand> [options]

Subcommands:
  start                Start the watchman daemon
    --background       Daemonize (run in background)
    --interval <ms>    Health check interval in milliseconds (default: from config)
  stop                 Stop the watchman daemon
    --json             JSON output
  status               Show watchman status
    --json             JSON output

Options:
  --help, -h           Show this help

The watchman daemon combines three capabilities:
  1. Health monitoring: session health checks, zombie detection, auto-recovery
  2. Mail delivery: polls for unread mail and nudges agents until they read it
  3. Beacon safety net: detects stuck beacons and sends follow-up Enter`;

export async function watchmanCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${WATCHMAN_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await handleStart(subArgs);
			break;
		case "stop":
			await handleStop(subArgs);
			break;
		case "status":
			await handleStatus(subArgs);
			break;
		default:
			process.stderr.write(
				`Unknown watchman subcommand: ${subcommand ?? "(none)"}. Use: start, stop, status\n`,
			);
			process.exitCode = 1;
	}
}
