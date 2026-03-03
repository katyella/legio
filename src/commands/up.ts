/**
 * CLI command: legio up
 *
 * Single command to bring up the full legio stack:
 * 1. Check git repo
 * 2. Initialize .legio/ if needed (legio init)
 * 3. Start the server in daemon mode (legio server start --daemon)
 *    The server auto-starts the coordinator with watchman.
 * 4. Start the gateway (legio gateway start --no-attach)
 * 5. Open the browser (unless --no-open)
 *
 * Running legio up when everything is already running is a safe no-op.
 */

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ServerError, ValidationError } from "../errors.ts";
import { isProcessRunning } from "../watchman/health.ts";

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

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

/**
 * Open the browser at the given URL. Fire-and-forget.
 */
function openBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : "xdg-open";
	const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
	child.unref();
}

/**
 * Spawn a process in the background (detached, unreffed).
 * The process outlives the parent — used for gateway start
 * so legio up doesn't block on beacon delivery.
 */
function defaultSpawnDetached(cmd: string[], opts?: { cwd?: string }): void {
	const [command, ...args] = cmd;
	if (!command) return;
	const proc = spawn(command, args, {
		cwd: opts?.cwd,
		stdio: "ignore",
		detached: true,
	});
	proc.unref();
}

// --- Spinner ---

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Handle returned by spinner factories. */
export interface SpinnerHandle {
	succeed(msg: string): void;
	fail(msg: string): void;
}

/** Animated braille spinner for interactive TTYs. */
function createAnimatedSpinner(msg: string): SpinnerHandle {
	let i = 0;
	const frame0 = SPINNER_FRAMES[0] ?? "⠋";
	process.stdout.write(`${frame0} ${msg}`);
	const timer = setInterval(() => {
		i = (i + 1) % SPINNER_FRAMES.length;
		const frame = SPINNER_FRAMES[i] ?? "⠋";
		process.stdout.write(`\r${frame} ${msg}`);
	}, 80);
	return {
		succeed(finalMsg: string) {
			clearInterval(timer);
			process.stdout.write(`\r\x1b[2K✓ ${finalMsg}\n`);
		},
		fail(finalMsg: string) {
			clearInterval(timer);
			process.stdout.write(`\r\x1b[2K✗ ${finalMsg}\n`);
		},
	};
}

/** Static spinner for non-TTY (piped, CI). Prints the final message only. */
function createStaticSpinner(_msg: string): SpinnerHandle {
	return {
		succeed(finalMsg: string) {
			process.stdout.write(`✓ ${finalMsg}\n`);
		},
		fail(finalMsg: string) {
			process.stdout.write(`✗ ${finalMsg}\n`);
		},
	};
}

/** Silent spinner for JSON mode. No output. */
function createSilentSpinner(): SpinnerHandle {
	return { succeed() {}, fail() {} };
}

/** Dependency injection interface for testing. */
export interface UpDeps {
	_runCommand?: (
		cmd: string[],
		opts?: { cwd?: string },
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	_fileExists?: (path: string) => Promise<boolean>;
	_readPid?: (path: string) => Promise<number | null>;
	_isProcessRunning?: (pid: number) => boolean;
	_openBrowser?: (url: string) => void;
	_projectRoot?: string;
	_spawnDetached?: (cmd: string[], opts?: { cwd?: string }) => void;
	_createSpinner?: (msg: string) => SpinnerHandle;
}

const UP_HELP = `legio up — Start the full legio stack

Usage: legio up [options]

Options:
  --port <n>     Server port (default: 4173)
  --host <addr>  Bind address (default: 127.0.0.1)
  --no-open      Do not auto-open browser
  --force        Force reinitialize .legio/ even if it exists
  --json         JSON output
  --help, -h     Show this help

legio up initializes .legio/ if needed, starts the server in daemon mode,
starts the gateway, and opens the browser. The server auto-starts the
coordinator with watchman. Running legio up when already running is a no-op.`;

/**
 * Entry point for \`legio up [options]\`.
 *
 * @param args - CLI arguments after "up"
 * @param deps - Optional dependency injection for testing
 */
export async function upCommand(args: string[], deps: UpDeps = {}): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${UP_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const force = hasFlag(args, "--force");
	const noOpen = hasFlag(args, "--no-open");
	const portStr = getFlag(args, "--port");
	const host = getFlag(args, "--host") ?? "127.0.0.1";
	const port = portStr ? Number.parseInt(portStr, 10) : 4173;

	if (Number.isNaN(port) || port < 1 || port > 65535) {
		throw new ValidationError("--port must be a valid port number (1-65535)", {
			field: "port",
			value: portStr,
		});
	}

	const run = deps._runCommand ?? runCommand;
	const fileExistsFn = deps._fileExists ?? fileExists;
	const readPidFn = deps._readPid ?? readPidFromFile;
	const isRunningFn = deps._isProcessRunning ?? isProcessRunning;
	const openBrowserFn = deps._openBrowser ?? openBrowser;
	const projectRoot = deps._projectRoot ?? process.cwd();
	const spawnBg = deps._spawnDetached ?? defaultSpawnDetached;

	// Spinner: animated on TTY, static on pipe/CI, silent for JSON
	const spin = json
		? () => createSilentSpinner()
		: (deps._createSpinner ?? (process.stdout.isTTY ? createAnimatedSpinner : createStaticSpinner));

	let initRan = false;
	let serverStarted = false;
	let serverAlreadyRunning = false;
	let gatewayStarted = false;
	let gatewayAlreadyRunning = false;

	// 1. Check git repo
	let s = spin("Checking git repository...");
	const gitCheck = await run(["git", "rev-parse", "--is-inside-work-tree"], { cwd: projectRoot });
	if (gitCheck.exitCode !== 0) {
		s.fail("Not a git repository");
		throw new ValidationError("legio requires a git repository. Run 'git init' first.", {
			field: "git",
		});
	}
	s.succeed("Git repository");

	// 2. Check if .legio/ is initialized
	const configPath = join(projectRoot, ".legio", "config.yaml");
	const initialized = await fileExistsFn(configPath);

	if (!initialized || force) {
		const label = initialized ? "Reinitializing .legio/ (--force)..." : "Initializing .legio/...";
		s = spin(label);
		const initArgs = ["legio", "init"];
		if (force) initArgs.push("--force");
		const initResult = await run(initArgs, { cwd: projectRoot });
		if (initResult.exitCode !== 0) {
			s.fail("Init failed");
			throw new ValidationError(`Init failed: ${initResult.stderr.trim()}`, {
				field: "init",
			});
		}
		s.succeed("Initialized");
		initRan = true;
	} else {
		s = spin("Checking initialization...");
		s.succeed("Already initialized");
	}

	// 3. Check if server is already running
	const pidFile = join(projectRoot, ".legio", "server.pid");
	const pidFileExists = await fileExistsFn(pidFile);
	let serverPid: number | undefined;

	if (pidFileExists) {
		const pid = await readPidFn(pidFile);
		if (pid !== null && isRunningFn(pid)) {
			serverAlreadyRunning = true;
			serverPid = pid;
		}
	}

	if (serverAlreadyRunning) {
		s = spin("Checking server...");
		s.succeed(`Server already running (PID ${serverPid})`);
	} else {
		s = spin(`Starting server on ${host}:${port}...`);
		const serverResult = await run(
			["legio", "server", "start", "--daemon", "--port", String(port), "--host", host],
			{ cwd: projectRoot },
		);
		if (serverResult.exitCode !== 0) {
			s.fail("Server start failed");
			throw new ServerError(`Server start failed: ${serverResult.stderr.trim()}`, { port });
		}
		serverStarted = true;
		s.succeed(`Server started on ${host}:${port}`);
	}

	// 4. Check if gateway is already running and start if needed (non-fatal)
	let gatewayRunning = false;
	try {
		const gatewayStatus = await run(["legio", "gateway", "status", "--json"], { cwd: projectRoot });
		if (gatewayStatus.exitCode === 0) {
			const statusData = JSON.parse(gatewayStatus.stdout.trim()) as { running?: boolean };
			if (statusData.running === true) {
				gatewayAlreadyRunning = true;
				gatewayRunning = true;
			}
		}
	} catch {
		// ignore status check errors, proceed to try starting
	}

	if (gatewayRunning) {
		s = spin("Checking gateway...");
		s.succeed("Gateway already running");
	} else {
		s = spin("Starting gateway...");
		try {
			// Spawn gateway detached so legio up returns immediately.
			// Beacon delivery (15-30s) happens in the background.
			spawnBg(["legio", "gateway", "start", "--no-attach"], { cwd: projectRoot });
			gatewayStarted = true;
			s.succeed("Gateway launched");
		} catch {
			s.fail("Gateway failed to start");
		}
	}

	const url = `http://${host}:${port}`;

	// 5. Open browser (unless --no-open)
	if (!noOpen) {
		openBrowserFn(url);
	}

	// 6. Print summary
	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				url,
				initRan,
				serverStarted,
				serverAlreadyRunning,
				serverPid,
				gatewayStarted,
				gatewayAlreadyRunning,
			})}\n`,
		);
	} else {
		process.stdout.write(`\nLegio is up at ${url}\n`);
	}
}
