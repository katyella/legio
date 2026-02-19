/**
 * CLI command: legio watch [--interval <ms>] [--background]
 *
 * Starts the Tier 0 mechanical watchdog daemon. Foreground mode shows real-time status.
 * Background mode spawns a detached process via Bun.spawn and writes a PID file.
 * Interval configurable, default 30000ms.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { LegioError } from "../errors.ts";
import type { HealthCheck } from "../types.ts";
import { startDaemon } from "../watchdog/daemon.ts";
import { isProcessRunning } from "../watchdog/health.ts";

/**
 * Parse a named flag value from args.
 */
function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
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

// isProcessRunning is imported from ../watchdog/health.ts (ZFC shared utility)

/**
 * Read the PID from the watchdog PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
async function readPidFile(pidFilePath: string): Promise<number | null> {
	const file = Bun.file(pidFilePath);
	const exists = await file.exists();
	if (!exists) {
		return null;
	}

	try {
		const text = await file.text();
		const pid = Number.parseInt(text.trim(), 10);
		if (Number.isNaN(pid) || pid <= 0) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

/**
 * Write a PID to the watchdog PID file.
 */
async function writePidFile(pidFilePath: string, pid: number): Promise<void> {
	await Bun.write(pidFilePath, `${pid}\n`);
}

/**
 * Remove the watchdog PID file.
 */
async function removePidFile(pidFilePath: string): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(pidFilePath);
	} catch {
		// File may already be gone — not an error
	}
}

/**
 * Resolve the path to the legio binary for re-launching.
 * Uses `which legio` first, then falls back to process.argv.
 */
async function resolveLegioBin(): Promise<string> {
	try {
		const proc = Bun.spawn(["which", "legio"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const binPath = (await new Response(proc.stdout).text()).trim();
			if (binPath.length > 0) {
				return binPath;
			}
		}
	} catch {
		// which not available or legio not on PATH
	}

	// Fallback: use the script that's currently running (process.argv[1])
	const scriptPath = process.argv[1];
	if (scriptPath) {
		return scriptPath;
	}

	throw new LegioError(
		"Cannot resolve legio binary path for background launch",
		"WATCH_ERROR",
	);
}

/**
 * Entry point for `legio watch [--interval <ms>] [--background]`.
 */
const WATCH_HELP = `legio watch — Start Tier 0 mechanical watchdog daemon

Usage: legio watch [--interval <ms>] [--background]

Tier numbering:
  Tier 0  Mechanical daemon (heartbeat, tmux/pid liveness) — this command
  Tier 1  Triage agent (ephemeral AI analysis of stalled agents)
  Tier 2  Monitor agent (continuous patrol — not yet implemented)
  Tier 3  Supervisor monitors (per-project)

Options:
  --interval <ms>    Health check interval in milliseconds (default: from config)
  --background       Daemonize (run in background)
  --help, -h         Show this help`;

export async function watchCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${WATCH_HELP}\n`);
		return;
	}

	const intervalStr = getFlag(args, "--interval");
	const background = hasFlag(args, "--background");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);

	const intervalMs = intervalStr
		? Number.parseInt(intervalStr, 10)
		: config.watchdog.tier0IntervalMs;

	const staleThresholdMs = config.watchdog.staleThresholdMs;
	const zombieThresholdMs = config.watchdog.zombieThresholdMs;
	const pidFilePath = join(config.project.root, ".legio", "watchdog.pid");

	if (background) {
		// Check if a watchdog is already running
		const existingPid = await readPidFile(pidFilePath);
		if (existingPid !== null && isProcessRunning(existingPid)) {
			process.stderr.write(
				`Error: Watchdog already running (PID: ${existingPid}). ` +
					`Kill it first or remove ${pidFilePath}\n`,
			);
			process.exitCode = 1;
			return;
		}

		// Clean up stale PID file if process is no longer running
		if (existingPid !== null) {
			await removePidFile(pidFilePath);
		}

		// Build the args for the child process, forwarding --interval but not --background
		const childArgs: string[] = ["watch"];
		if (intervalStr) {
			childArgs.push("--interval", intervalStr);
		}

		// Resolve the legio binary path
		const legioBin = await resolveLegioBin();

		// Spawn a detached background process running `legio watch` (without --background)
		const child = Bun.spawn(["bun", "run", legioBin, ...childArgs], {
			cwd,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});

		// Unref the child so the parent can exit without waiting for it
		child.unref();

		const childPid = child.pid;

		// Write PID file for later cleanup
		await writePidFile(pidFilePath, childPid);

		process.stdout.write(
			`Watchdog started in background (PID: ${childPid}, interval: ${intervalMs}ms)\n`,
		);
		process.stdout.write(`PID file: ${pidFilePath}\n`);
		return;
	}

	// Foreground mode: show real-time health checks
	process.stdout.write(`Watchdog running (interval: ${intervalMs}ms)\n`);
	process.stdout.write("Press Ctrl+C to stop.\n\n");

	// Write PID file so `--background` check and external tools can find us
	await writePidFile(pidFilePath, process.pid);

	const { stop } = startDaemon({
		root: config.project.root,
		intervalMs,
		staleThresholdMs,
		zombieThresholdMs,
		nudgeIntervalMs: config.watchdog.nudgeIntervalMs,
		tier1Enabled: config.watchdog.tier1Enabled,
		onHealthCheck(check) {
			const timestamp = new Date().toISOString().slice(11, 19);
			process.stdout.write(`[${timestamp}] ${formatCheck(check)}\n`);
		},
	});

	// Keep running until interrupted
	process.on("SIGINT", () => {
		stop();
		// Clean up PID file on graceful shutdown
		removePidFile(pidFilePath).finally(() => {
			process.stdout.write("\nWatchdog stopped.\n");
			process.exit(0);
		});
	});

	// Block forever
	await new Promise(() => {});
}
