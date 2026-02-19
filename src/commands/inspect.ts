/**
 * CLI command: legio inspect <agent-name>
 *
 * Deep per-agent inspection aggregating data from EventStore, SessionStore,
 * MetricsStore, and tmux capture-pane.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { color } from "../logging/color.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession, StoredEvent, ToolStats } from "../types.ts";

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
 * Format a duration in ms to a human-readable string.
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainSec = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainSec}s`;
	const hours = Math.floor(minutes / 60);
	const remainMin = minutes % 60;
	return `${hours}h ${remainMin}m`;
}

/**
 * Get colored state icon based on agent state.
 */
function getStateIcon(state: AgentSession["state"]): string {
	switch (state) {
		case "booting":
			return `${color.yellow}⏳${color.reset}`; // Yellow hourglass
		case "working":
			return `${color.green}●${color.reset}`; // Green circle
		case "stalled":
			return `${color.yellow}⚠${color.reset}`; // Yellow warning
		case "completed":
			return `${color.blue}✓${color.reset}`; // Blue checkmark
		case "zombie":
			return `${color.red}☠${color.reset}`; // Red skull
		default:
			return "?";
	}
}

/**
 * Extract current file from most recent Edit/Write/Read tool_start event.
 */
function extractCurrentFile(events: StoredEvent[]): string | null {
	// Scan backwards for tool_start events with Edit/Write/Read
	const fileTools = ["Edit", "Write", "Read"];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (
			event &&
			event.eventType === "tool_start" &&
			event.toolName &&
			fileTools.includes(event.toolName) &&
			event.toolArgs
		) {
			try {
				const args = JSON.parse(event.toolArgs) as Record<string, unknown>;
				const filePath = (args.file_path as string) ?? (args.path as string);
				if (filePath) {
					return filePath;
				}
			} catch {
				// Failed to parse JSON, continue
			}
		}
	}
	return null;
}

/**
 * Summarize tool arguments for display (truncate long values).
 */
function summarizeArgs(toolArgs: string | null): string {
	if (!toolArgs) return "";
	try {
		const parsed = JSON.parse(toolArgs) as Record<string, unknown>;
		const entries = Object.entries(parsed)
			.map(([key, value]) => {
				const str = String(value);
				return `${key}=${str.length > 40 ? `${str.slice(0, 37)}...` : str}`;
			})
			.join(", ");
		return entries.length > 100 ? `${entries.slice(0, 97)}...` : entries;
	} catch {
		return toolArgs.length > 100 ? `${toolArgs.slice(0, 97)}...` : toolArgs;
	}
}

/**
 * Capture tmux pane output.
 */
async function captureTmux(sessionName: string, lines: number): Promise<string | null> {
	try {
		const proc = Bun.spawn(["tmux", "capture-pane", "-t", sessionName, "-p", "-S", `-${lines}`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return null;
		}
		const output = await new Response(proc.stdout).text();
		return output.trim();
	} catch {
		return null;
	}
}

export interface InspectData {
	session: AgentSession;
	timeSinceLastActivity: number;
	recentToolCalls: Array<{
		toolName: string;
		args: string;
		durationMs: number | null;
		timestamp: string;
	}>;
	currentFile: string | null;
	toolStats: ToolStats[];
	tokenUsage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
		estimatedCostUsd: number | null;
		modelUsed: string | null;
	} | null;
	tmuxOutput: string | null;
}

/**
 * Gather all inspection data for an agent.
 */
export async function gatherInspectData(
	root: string,
	agentName: string,
	opts: {
		limit?: number;
		noTmux?: boolean;
		tmuxLines?: number;
	} = {},
): Promise<InspectData> {
	const legioDir = join(root, ".legio");
	const { store } = openSessionStore(legioDir);

	let session: AgentSession | null = null;
	try {
		session = store.getByName(agentName);
		if (!session) {
			throw new ValidationError(`Agent not found: ${agentName}`, {
				field: "agent-name",
				value: agentName,
			});
		}

		const now = Date.now();
		const timeSinceLastActivity = now - new Date(session.lastActivity).getTime();

		// EventStore: recent tool calls and tool stats
		let recentToolCalls: InspectData["recentToolCalls"] = [];
		let currentFile: string | null = null;
		let toolStats: ToolStats[] = [];

		const eventsDbPath = join(legioDir, "events.db");
		const eventsFile = Bun.file(eventsDbPath);
		if (await eventsFile.exists()) {
			const eventStore = createEventStore(eventsDbPath);
			try {
				// Get recent events for this agent
				const events = eventStore.getByAgent(agentName, { limit: 200 });

				// Extract current file from most recent Edit/Write/Read tool_start
				currentFile = extractCurrentFile(events);

				// Filter to tool_start events for recent tool calls display
				const toolStartEvents = events.filter((e) => e.eventType === "tool_start");
				const limit = opts.limit ?? 20;
				recentToolCalls = toolStartEvents.slice(0, limit).map((event) => ({
					toolName: event.toolName ?? "unknown",
					args: summarizeArgs(event.toolArgs),
					durationMs: event.toolDurationMs,
					timestamp: event.createdAt,
				}));

				// Tool usage statistics
				toolStats = eventStore.getToolStats({ agentName });
			} finally {
				eventStore.close();
			}
		}

		// MetricsStore: token usage
		let tokenUsage: InspectData["tokenUsage"] = null;
		const metricsDbPath = join(legioDir, "metrics.db");
		const metricsFile = Bun.file(metricsDbPath);
		if (await metricsFile.exists()) {
			const metricsStore = createMetricsStore(metricsDbPath);
			try {
				const sessions = metricsStore.getSessionsByAgent(agentName);
				const mostRecent = sessions[0];
				if (mostRecent) {
					tokenUsage = {
						inputTokens: mostRecent.inputTokens,
						outputTokens: mostRecent.outputTokens,
						cacheReadTokens: mostRecent.cacheReadTokens,
						cacheCreationTokens: mostRecent.cacheCreationTokens,
						estimatedCostUsd: mostRecent.estimatedCostUsd,
						modelUsed: mostRecent.modelUsed,
					};
				}
			} finally {
				metricsStore.close();
			}
		}

		// tmux capture
		let tmuxOutput: string | null = null;
		if (!opts.noTmux && session.tmuxSession) {
			const lines = opts.tmuxLines ?? 30;
			tmuxOutput = await captureTmux(session.tmuxSession, lines);
		}

		return {
			session,
			timeSinceLastActivity,
			recentToolCalls,
			currentFile,
			toolStats,
			tokenUsage,
			tmuxOutput,
		};
	} finally {
		store.close();
	}
}

/**
 * Print inspection data in human-readable format.
 */
export function printInspectData(data: InspectData): void {
	const w = process.stdout.write.bind(process.stdout);
	const { session } = data;

	w(`\n🔍 Agent Inspection: ${session.agentName}\n`);
	w(`${"═".repeat(80)}\n\n`);

	// Agent state and metadata
	const stateIcon = getStateIcon(session.state);
	w(`${stateIcon} State: ${session.state}\n`);
	w(`⏱  Last activity: ${formatDuration(data.timeSinceLastActivity)} ago\n`);
	w(`🎯 Task: ${session.beadId}\n`);
	w(`🔧 Capability: ${session.capability}\n`);
	w(`🌿 Branch: ${session.branchName}\n`);
	if (session.parentAgent) {
		w(`👤 Parent: ${session.parentAgent} (depth: ${session.depth})\n`);
	}
	w(`📅 Started: ${session.startedAt}\n`);
	w(`💻 Tmux: ${session.tmuxSession}\n`);
	w("\n");

	// Current file
	if (data.currentFile) {
		w(`📝 Current file: ${data.currentFile}\n\n`);
	}

	// Token usage
	if (data.tokenUsage) {
		w("💰 Token Usage\n");
		w(`${"─".repeat(80)}\n`);
		w(`  Input:         ${data.tokenUsage.inputTokens.toLocaleString()}\n`);
		w(`  Output:        ${data.tokenUsage.outputTokens.toLocaleString()}\n`);
		w(`  Cache read:    ${data.tokenUsage.cacheReadTokens.toLocaleString()}\n`);
		w(`  Cache created: ${data.tokenUsage.cacheCreationTokens.toLocaleString()}\n`);
		if (data.tokenUsage.estimatedCostUsd !== null) {
			w(`  Estimated cost: $${data.tokenUsage.estimatedCostUsd.toFixed(4)}\n`);
		}
		if (data.tokenUsage.modelUsed) {
			w(`  Model: ${data.tokenUsage.modelUsed}\n`);
		}
		w("\n");
	}

	// Tool usage statistics (top 10)
	if (data.toolStats.length > 0) {
		w("🛠  Tool Usage (Top 10)\n");
		w(`${"─".repeat(80)}\n`);
		const top10 = data.toolStats.slice(0, 10);
		for (const stat of top10) {
			const avgMs = stat.avgDurationMs.toFixed(0);
			w(`  ${stat.toolName.padEnd(20)} ${String(stat.count).padStart(6)} calls  `);
			w(`avg: ${String(avgMs).padStart(6)}ms  max: ${stat.maxDurationMs}ms\n`);
		}
		w("\n");
	}

	// Recent tool calls
	if (data.recentToolCalls.length > 0) {
		w(`📊 Recent Tool Calls (last ${data.recentToolCalls.length})\n`);
		w(`${"─".repeat(80)}\n`);
		for (const call of data.recentToolCalls) {
			const time = new Date(call.timestamp).toLocaleTimeString();
			const duration = call.durationMs !== null ? `${call.durationMs}ms` : "pending";
			w(`  [${time}] ${call.toolName.padEnd(15)} ${duration.padStart(10)}`);
			if (call.args) {
				w(`  ${call.args}`);
			}
			w("\n");
		}
		w("\n");
	}

	// tmux output
	if (data.tmuxOutput) {
		w("📺 Live Tmux Output\n");
		w(`${"─".repeat(80)}\n`);
		w(`${data.tmuxOutput}\n`);
		w(`${"─".repeat(80)}\n`);
	}
}

const INSPECT_HELP = `legio inspect <agent-name> — Deep inspection of a single agent

Usage: legio inspect <agent-name> [options]

Options:
  --json             Output as JSON
  --follow           Poll and refresh (clears screen, re-gathers, re-prints)
  --interval <ms>    Polling interval for --follow in milliseconds (default: 3000, min: 500)
  --limit <n>        Number of recent tool calls to show (default: 20)
  --no-tmux          Skip tmux capture-pane
  --help, -h         Show this help

Examples:
  legio inspect builder-1
  legio inspect scout-alpha --json
  legio inspect builder-1 --follow --interval 2000`;

/**
 * Entry point for `legio inspect <agent-name>`.
 */
export async function inspectCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${INSPECT_HELP}\n`);
		return;
	}

	const agentName = args[0];
	if (!agentName) {
		throw new ValidationError("Agent name is required", {
			field: "agent-name",
		});
	}

	const json = hasFlag(args, "--json");
	const follow = hasFlag(args, "--follow");
	const noTmux = hasFlag(args, "--no-tmux");

	const intervalStr = getFlag(args, "--interval");
	const interval = intervalStr ? Number.parseInt(intervalStr, 10) : 3000;
	if (Number.isNaN(interval) || interval < 500) {
		throw new ValidationError("--interval must be a number >= 500 (milliseconds)", {
			field: "interval",
			value: intervalStr,
		});
	}

	const limitStr = getFlag(args, "--limit");
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 20;
	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a number >= 1", {
			field: "limit",
			value: limitStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	if (follow) {
		// Polling loop
		while (true) {
			// Clear screen
			process.stdout.write("\x1b[2J\x1b[H");
			const data = await gatherInspectData(root, agentName, {
				limit,
				noTmux,
				tmuxLines: 30,
			});
			if (json) {
				process.stdout.write(`${JSON.stringify(data, null, "\t")}\n`);
			} else {
				printInspectData(data);
			}
			await Bun.sleep(interval);
		}
	} else {
		// Single snapshot
		const data = await gatherInspectData(root, agentName, { limit, noTmux, tmuxLines: 30 });
		if (json) {
			process.stdout.write(`${JSON.stringify(data, null, "\t")}\n`);
		} else {
			printInspectData(data);
		}
	}
}
