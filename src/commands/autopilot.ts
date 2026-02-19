/**
 * CLI command: legio autopilot <subcommand>
 *
 * Controls the coordinator autopilot via REST API calls to the running server.
 * The autopilot daemon runs in-process with the web server (src/server/index.ts).
 */

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

const AUTOPILOT_HELP = `legio autopilot <subcommand>

Controls the coordinator autopilot daemon. The autopilot must be started with
the web server running ('legio server start').

Subcommands:
  start     Start the autopilot daemon
  stop      Stop the autopilot daemon
  status    Show current autopilot state

Options:
  --port <n>     Server port (default: 4173)
  --host <addr>  Server host (default: 127.0.0.1)
  --json         JSON output
  --help, -h     Show this help
`;

export async function autopilotCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${AUTOPILOT_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await runAutopilotSubcommand("start", subArgs);
			break;
		case "stop":
			await runAutopilotSubcommand("stop", subArgs);
			break;
		case "status":
			await runAutopilotSubcommand("status", subArgs);
			break;
		default:
			process.stderr.write(`Unknown autopilot subcommand: ${subcommand}\n`);
			process.stderr.write("Run 'legio autopilot --help' for usage.\n");
			process.exit(1);
	}
}

async function runAutopilotSubcommand(
	action: "start" | "stop" | "status",
	args: string[],
): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${AUTOPILOT_HELP}\n`);
		return;
	}

	const portStr = getFlag(args, "--port");
	const host = getFlag(args, "--host") ?? "127.0.0.1";
	const jsonOutput = hasFlag(args, "--json");

	const port = portStr ? Number.parseInt(portStr, 10) : 4173;

	const method = action === "status" ? "GET" : "POST";
	const url = `http://${host}:${port}/api/autopilot/${action}`;

	let response: Response;
	try {
		response = await fetch(url, { method });
	} catch (err) {
		const msg =
			err instanceof Error && err.message.includes("ECONNREFUSED")
				? `Server not running at ${host}:${port}. Start it with 'legio server start'.`
				: `Failed to connect to server at ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`;
		if (jsonOutput) {
			process.stdout.write(JSON.stringify({ error: msg }) + "\n");
		} else {
			process.stderr.write(`Error: ${msg}\n`);
		}
		process.exit(1);
	}

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		data = { error: "Failed to parse server response" };
	}

	if (jsonOutput) {
		process.stdout.write(JSON.stringify(data, null, 2) + "\n");
		return;
	}

	if (!response.ok) {
		const errMsg =
			data !== null && typeof data === "object" && "error" in data
				? String((data as Record<string, unknown>).error)
				: `HTTP ${response.status}`;
		process.stderr.write(`Error: ${errMsg}\n`);
		process.exit(1);
	}

	// Human-readable output
	formatAutopilotState(data, action);
}

function formatAutopilotState(data: unknown, action: string): void {
	if (data === null || typeof data !== "object" || !("running" in data)) {
		process.stdout.write(JSON.stringify(data, null, 2) + "\n");
		return;
	}

	const state = data as {
		running: boolean;
		startedAt: string | null;
		stoppedAt: string | null;
		lastTick: string | null;
		tickCount: number;
		actions: Array<{ timestamp: string; type: string; details: string }>;
		config: { intervalMs: number; autoMerge: boolean; autoCleanWorktrees: boolean };
	};

	if (action === "start") {
		process.stdout.write(`Autopilot ${state.running ? "started" : "already running"}.\n`);
	} else if (action === "stop") {
		process.stdout.write(`Autopilot ${!state.running ? "stopped" : "already stopped"}.\n`);
	}

	process.stdout.write(`\nAutopilot Status:\n`);
	process.stdout.write(`  Running:     ${state.running ? "yes" : "no"}\n`);
	process.stdout.write(`  Started:     ${state.startedAt ?? "never"}\n`);
	process.stdout.write(`  Last tick:   ${state.lastTick ?? "never"}\n`);
	process.stdout.write(`  Tick count:  ${state.tickCount}\n`);
	process.stdout.write(`  Interval:    ${state.config.intervalMs}ms\n`);
	process.stdout.write(`  Auto merge:  ${state.config.autoMerge ? "yes" : "no"}\n`);
	process.stdout.write(`  Auto clean:  ${state.config.autoCleanWorktrees ? "yes" : "no"}\n`);

	if (state.actions.length > 0) {
		process.stdout.write(`\nRecent Actions (${state.actions.length}):\n`);
		const recent = state.actions.slice(0, 10);
		for (const a of recent) {
			process.stdout.write(`  [${a.timestamp}] ${a.type}: ${a.details}\n`);
		}
	}
}
