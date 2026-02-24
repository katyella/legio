/**
 * CLI command: legio stop
 *
 * Stops active agent sessions deepest-first (leaf agents before parents).
 * Kills each agent's tmux session and marks the session as completed in
 * the session store.
 *
 * If --agent <name> is provided, stops only that specific agent.
 * Otherwise stops all active sessions (state: booting, working, stalled).
 *
 * Uses DI (StopDeps._tmux) for tmux operations, matching coordinator.ts pattern.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { AgentError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getFlagValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

/** Dependency injection interface for testing. */
export interface StopDeps {
	_tmux?: {
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
	};
	_projectRoot?: string;
}

const STOP_HELP = `legio stop — Stop active agent sessions

Usage: legio stop [options]

Options:
  --agent <name>  Stop only the named agent (default: stop all active agents)
  --json          JSON output
  --help, -h      Show this help

Agents are stopped deepest-first (leaf agents before their parents).
Running legio stop when no agents are active is a safe no-op.`;

/**
 * Entry point for \`legio stop [options]\`.
 *
 * @param args - CLI arguments after "stop"
 * @param deps - Optional dependency injection for testing
 */
export async function stopCommand(args: string[], deps: StopDeps = {}): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${STOP_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const agentFilter = getFlagValue(args, "--agent");
	const tmux = deps._tmux ?? { isSessionAlive, killSession };
	const projectRoot = deps._projectRoot ?? process.cwd();

	const config = await loadConfig(projectRoot);
	const legioDir = join(config.project.root, ".legio");
	const { store } = openSessionStore(legioDir);

	try {
		const sessions = agentFilter
			? (() => {
					const session = store.getByName(agentFilter);
					if (!session) {
						throw new AgentError(`No session found for agent '${agentFilter}'`, {
							agentName: agentFilter,
						});
					}
					return [session];
				})()
			: store.getActive();

		if (sessions.length === 0) {
			if (json) {
				process.stdout.write(`${JSON.stringify({ stopped: [], nothingToStop: true })}\n`);
			} else {
				process.stdout.write("Nothing to stop\n");
			}
			return;
		}

		// Sort deepest-first: leaf agents die before their parents
		const sorted = [...sessions].sort((a, b) => b.depth - a.depth);

		const stopped: string[] = [];

		for (const session of sorted) {
			const alive = await tmux.isSessionAlive(session.tmuxSession);
			if (alive) {
				await tmux.killSession(session.tmuxSession);
			}
			store.updateState(session.agentName, "completed");
			stopped.push(session.agentName);
			if (!json) {
				process.stdout.write(`Stopped: ${session.agentName} (${session.tmuxSession})\n`);
			}
		}

		if (json) {
			process.stdout.write(`${JSON.stringify({ stopped, nothingToStop: false })}\n`);
		} else {
			process.stdout.write(`Stopped ${stopped.length} agent${stopped.length === 1 ? "" : "s"}\n`);
		}
	} finally {
		store.close();
	}
}
