/**
 * CLI command: legio server <subcommand>
 *
 * Starts the local web UI server for project monitoring.
 * The actual server implementation lives in src/server/index.ts.
 */

import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

const SERVER_HELP = `legio server <subcommand>

Subcommands:
  start               Start the local web UI server

Options (start):
  --port <n>          Port to listen on (default: 4173)
  --host <addr>       Bind address (default: 127.0.0.1)
  --open              Auto-open browser after server starts
  --help, -h          Show this help
`;

export async function serverCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${SERVER_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startServer(subArgs);
			break;
		default:
			process.stderr.write(`Unknown server subcommand: ${subcommand}\n`);
			process.stderr.write("Run 'legio server --help' for usage.\n");
			process.exit(1);
	}
}

async function startServer(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${SERVER_HELP}\n`);
		return;
	}

	const portStr = getFlag(args, "--port");
	const host = getFlag(args, "--host") ?? "127.0.0.1";
	const shouldOpen = hasFlag(args, "--open");

	const port = portStr ? Number.parseInt(portStr, 10) : 4173;
	if (Number.isNaN(port) || port < 1 || port > 65535) {
		throw new ValidationError("--port must be a valid port number (1-65535)", {
			field: "port",
			value: portStr,
		});
	}

	// Resolve project root and validate .legio exists
	const root = process.cwd();
	await loadConfig(root);

	// Import the server module dynamically to avoid circular deps
	const { startServer: start } = await import("../server/index.ts");
	await start({ port, host, root, shouldOpen });
}
