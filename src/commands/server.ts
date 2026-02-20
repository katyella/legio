/**
 * CLI command: legio server <subcommand>
 *
 * Starts the local web UI server for project monitoring.
 * The actual server implementation lives in src/server/index.ts.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { isProcessRunning } from "../watchdog/health.ts";

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/** Dependency injection for testing. Uses real implementations when omitted. */
export interface ServerDeps {
	_isProcessRunning?: (pid: number) => boolean;
	_spawn?: (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number; unref: () => void };
	_sleep?: (ms: number) => Promise<void>;
}

const SERVER_HELP = `legio server <subcommand>

Subcommands:
  start               Start the local web UI server
  stop                Stop the daemon server
  status              Show daemon server status

Options (start):
  --port <n>          Port to listen on (default: 4173)
  --host <addr>       Bind address (default: 127.0.0.1)
  --open              Auto-open browser after server starts
  --daemon            Run server as a background daemon

Options (status):
  --json              JSON output

  --help, -h          Show this help
`;

/**
 * Check if a file exists at the given path.
 */
async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Returns the path to the server PID file.
 */
function serverPidPath(projectRoot: string): string {
	return join(projectRoot, ".legio", "server.pid");
}

/**
 * Read the PID from the server PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export async function readServerPid(projectRoot: string): Promise<number | null> {
	const pidPath = serverPidPath(projectRoot);
	if (!(await fileExists(pidPath))) {
		return null;
	}
	try {
		const text = await readFile(pidPath, "utf-8");
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
 * Write the server PID to the PID file.
 */
export async function writeServerPid(projectRoot: string, pid: number): Promise<void> {
	const pidPath = serverPidPath(projectRoot);
	await writeFile(pidPath, String(pid), "utf-8");
}

/**
 * Remove the server PID file.
 */
export async function removeServerPid(projectRoot: string): Promise<void> {
	const pidPath = serverPidPath(projectRoot);
	try {
		await unlink(pidPath);
	} catch {
		// File may already be gone — not an error
	}
}

export async function serverCommand(args: string[], deps: ServerDeps = {}): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${SERVER_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startServer(subArgs, deps);
			break;
		case "stop":
			await stopServer(subArgs, deps);
			break;
		case "status":
			await statusServer(subArgs, deps);
			break;
		default:
			process.stderr.write(`Unknown server subcommand: ${subcommand}\n`);
			process.stderr.write("Run 'legio server --help' for usage.\n");
			process.exit(1);
	}
}

async function startServer(args: string[], deps: ServerDeps): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${SERVER_HELP}\n`);
		return;
	}

	const portStr = getFlag(args, "--port");
	const host = getFlag(args, "--host") ?? "127.0.0.1";
	const shouldOpen = hasFlag(args, "--open");
	const isDaemon = hasFlag(args, "--daemon");

	const port = portStr ? Number.parseInt(portStr, 10) : 4173;
	if (Number.isNaN(port) || port < 1 || port > 65535) {
		throw new ValidationError("--port must be a valid port number (1-65535)", {
			field: "port",
			value: portStr,
		});
	}

	// Resolve project root and validate .legio exists
	const root = process.cwd();
	const config = await loadConfig(root);
	const projectRoot = config.project.root || root;

	if (isDaemon) {
		// Check if already running
		const existingPid = await readServerPid(projectRoot);
		const checkRunning = deps._isProcessRunning ?? isProcessRunning;
		if (existingPid !== null && checkRunning(existingPid)) {
			process.stdout.write(`Server already running (PID ${existingPid})\n`);
			return;
		}
		// Clean up stale PID file if present
		if (existingPid !== null) {
			await removeServerPid(projectRoot);
		}

		// Spawn detached child without --daemon, with LEGIO_SERVER_DAEMON=1
		const spawnFn = deps._spawn ?? spawn;
		const childArgs = ["server", "start", "--port", String(port), "--host", host];
		if (shouldOpen) childArgs.push("--open");

		const child = spawnFn("legio", childArgs, {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, LEGIO_SERVER_DAEMON: "1" },
		});
		child.unref();

		if (child.pid !== undefined) {
			await writeServerPid(projectRoot, child.pid);

			// Wait for daemon to attempt port binding, then verify it survived
			const sleep = deps._sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
			await sleep(500);

			if (!checkRunning(child.pid)) {
				await removeServerPid(projectRoot);
				process.stderr.write(
					"Daemon process exited immediately — port may already be in use\n",
				);
				process.exit(1);
			}

			process.stdout.write(
				`Server started as daemon (PID ${child.pid}) at http://${host}:${port}\n`,
			);
		} else {
			process.stderr.write("Failed to spawn daemon process\n");
			process.exit(1);
		}
		return;
	}

	// Import the server module dynamically to avoid circular deps
	const { startServer: start } = await import("../server/index.ts");
	await start({ port, host, root, shouldOpen });
}

async function stopServer(_args: string[], deps: ServerDeps): Promise<void> {
	const root = process.cwd();
	const config = await loadConfig(root);
	const projectRoot = config.project.root || root;

	const pid = await readServerPid(projectRoot);
	if (pid === null) {
		process.stdout.write("Server not running\n");
		return;
	}

	const checkRunning = deps._isProcessRunning ?? isProcessRunning;
	if (!checkRunning(pid)) {
		await removeServerPid(projectRoot);
		process.stdout.write("Server not running (stale PID file cleaned up)\n");
		return;
	}

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Process may have just died
	}
	await removeServerPid(projectRoot);
	process.stdout.write(`Server stopped (PID ${pid})\n`);
}

async function statusServer(args: string[], deps: ServerDeps): Promise<void> {
	const jsonMode = hasFlag(args, "--json");

	const root = process.cwd();
	const config = await loadConfig(root);
	const projectRoot = config.project.root || root;

	const pid = await readServerPid(projectRoot);
	const checkRunning = deps._isProcessRunning ?? isProcessRunning;

	if (pid === null) {
		if (jsonMode) {
			process.stdout.write(`${JSON.stringify({ running: false, pid: null })}\n`);
		} else {
			process.stdout.write("Server not running\n");
		}
		return;
	}

	const alive = checkRunning(pid);
	if (!alive) {
		// Clean up stale PID file
		await removeServerPid(projectRoot);
		if (jsonMode) {
			process.stdout.write(`${JSON.stringify({ running: false, pid: null, stale: true })}\n`);
		} else {
			process.stdout.write("Server not running (stale PID file cleaned up)\n");
		}
		return;
	}

	// Determine port from config or default
	const port = 4173;
	if (jsonMode) {
		process.stdout.write(`${JSON.stringify({ running: true, pid, port })}\n`);
	} else {
		process.stdout.write(`Server running (PID ${pid}) on port ${port}\n`);
	}
}
