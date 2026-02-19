/**
 * CLI command: legio replay [--run <id>] [--agent <name>...] [--json]
 *              [--since <ts>] [--until <ts>] [--limit <n>]
 *
 * Shows an interleaved chronological replay of events across multiple agents.
 * Like reading a combined log — all agents' events merged by timestamp.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createEventStore } from "../events/store.ts";
import { color } from "../logging/color.ts";
import type { EventType, StoredEvent } from "../types.ts";

/** Labels and colors for each event type. */
const EVENT_LABELS: Record<EventType, { label: string; color: string }> = {
	tool_start: { label: "TOOL START", color: color.blue },
	tool_end: { label: "TOOL END  ", color: color.blue },
	session_start: { label: "SESSION  +", color: color.green },
	session_end: { label: "SESSION  -", color: color.yellow },
	mail_sent: { label: "MAIL SENT ", color: color.cyan },
	mail_received: { label: "MAIL RECV ", color: color.cyan },
	spawn: { label: "SPAWN     ", color: color.magenta },
	error: { label: "ERROR     ", color: color.red },
	custom: { label: "CUSTOM    ", color: color.gray },
};

/** Colors assigned to agents in order of first appearance. */
const AGENT_COLORS = [color.blue, color.green, color.yellow, color.cyan, color.magenta] as const;

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

/**
 * Parse all occurrences of a named flag from args.
 * Returns an array of values (e.g., --agent a --agent b => ["a", "b"]).
 */
function getAllFlags(args: string[], flag: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag && i + 1 < args.length) {
			const value = args[i + 1];
			if (value !== undefined) {
				values.push(value);
			}
			i++; // skip the value
		}
	}
	return values;
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Format a relative time string from a timestamp.
 * Returns strings like "2m ago", "1h ago", "3d ago".
 */
function formatRelativeTime(timestamp: string): string {
	const eventTime = new Date(timestamp).getTime();
	const now = Date.now();
	const diffMs = now - eventTime;

	if (diffMs < 0) return "just now";

	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/**
 * Format an absolute time from an ISO timestamp.
 * Returns "HH:MM:SS" portion.
 */
function formatAbsoluteTime(timestamp: string): string {
	const match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return timestamp;
}

/**
 * Format the date portion of an ISO timestamp.
 * Returns "YYYY-MM-DD".
 */
function formatDate(timestamp: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(timestamp);
	if (match?.[1]) {
		return match[1];
	}
	return "";
}

/**
 * Build a detail string for a timeline event based on its type and fields.
 */
function buildEventDetail(event: StoredEvent): string {
	const parts: string[] = [];

	if (event.toolName) {
		parts.push(`tool=${event.toolName}`);
	}

	if (event.toolDurationMs !== null) {
		parts.push(`duration=${event.toolDurationMs}ms`);
	}

	if (event.data) {
		try {
			const parsed: unknown = JSON.parse(event.data);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const data = parsed as Record<string, unknown>;
				for (const [key, value] of Object.entries(data)) {
					if (value !== null && value !== undefined) {
						const strValue = typeof value === "string" ? value : JSON.stringify(value);
						// Truncate long values
						const truncated = strValue.length > 80 ? `${strValue.slice(0, 77)}...` : strValue;
						parts.push(`${key}=${truncated}`);
					}
				}
			}
		} catch {
			// data is not valid JSON; show it raw if short enough
			if (event.data.length <= 80) {
				parts.push(event.data);
			}
		}
	}

	return parts.join(" ");
}

/**
 * Assign a stable color to each agent based on order of first appearance.
 */
function buildAgentColorMap(events: StoredEvent[]): Map<string, string> {
	const colorMap = new Map<string, string>();
	for (const event of events) {
		if (!colorMap.has(event.agentName)) {
			const colorIndex = colorMap.size % AGENT_COLORS.length;
			const color = AGENT_COLORS[colorIndex];
			if (color !== undefined) {
				colorMap.set(event.agentName, color);
			}
		}
	}
	return colorMap;
}

/**
 * Print events as an interleaved timeline with ANSI colors and agent labels.
 */
function printReplay(events: StoredEvent[], useAbsoluteTime: boolean): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${color.bold}Replay${color.reset}\n`);
	w(`${"=".repeat(70)}\n`);

	if (events.length === 0) {
		w(`${color.dim}No events found.${color.reset}\n`);
		return;
	}

	w(`${color.dim}${events.length} event${events.length === 1 ? "" : "s"}${color.reset}\n\n`);

	const colorMap = buildAgentColorMap(events);
	let lastDate = "";

	for (const event of events) {
		// Print date separator when the date changes
		const date = formatDate(event.createdAt);
		if (date && date !== lastDate) {
			if (lastDate !== "") {
				w("\n");
			}
			w(`${color.dim}--- ${date} ---${color.reset}\n`);
			lastDate = date;
		}

		const timeStr = useAbsoluteTime
			? formatAbsoluteTime(event.createdAt)
			: formatRelativeTime(event.createdAt);

		const eventInfo = EVENT_LABELS[event.eventType] ?? {
			label: event.eventType.padEnd(10),
			color: color.gray,
		};

		const levelColor =
			event.level === "error" ? color.red : event.level === "warn" ? color.yellow : "";
		const levelReset = levelColor ? color.reset : "";

		const detail = buildEventDetail(event);
		const detailSuffix = detail ? ` ${color.dim}${detail}${color.reset}` : "";

		const agentColor = colorMap.get(event.agentName) ?? color.gray;
		const agentLabel = ` ${agentColor}[${event.agentName}]${color.reset}`;

		w(
			`${color.dim}${timeStr.padStart(10)}${color.reset} ` +
				`${levelColor}${eventInfo.color}${color.bold}${eventInfo.label}${color.reset}${levelReset}` +
				`${agentLabel}${detailSuffix}\n`,
		);
	}
}

const REPLAY_HELP = `legio replay -- Interleaved chronological replay across agents

Usage: legio replay [options]

Options:
  --run <id>             Filter events by run ID
  --agent <name>         Filter by agent name (can appear multiple times)
  --since <timestamp>    Start time filter (ISO 8601)
  --until <timestamp>    End time filter (ISO 8601)
  --limit <n>            Max events to show (default: 200)
  --json                 Output as JSON array of StoredEvent objects
  --help, -h             Show this help

If --run is specified, shows all events from that run.
If --agent is specified, shows events from those agents merged chronologically.
If neither is specified, tries to read the current run from .legio/current-run.txt.
Falls back to a 24-hour timeline of all events.`;

/**
 * Entry point for `legio replay [--run <id>] [--agent <name>...] [--json]`.
 */
export async function replayCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${REPLAY_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const runId = getFlag(args, "--run");
	const agentNames = getAllFlags(args, "--agent");
	const sinceStr = getFlag(args, "--since");
	const untilStr = getFlag(args, "--until");
	const limitStr = getFlag(args, "--limit");
	const limit = limitStr ? Number.parseInt(limitStr, 10) : 200;

	if (Number.isNaN(limit) || limit < 1) {
		throw new ValidationError("--limit must be a positive integer", {
			field: "limit",
			value: limitStr,
		});
	}

	// Validate timestamps if provided
	if (sinceStr !== undefined && Number.isNaN(new Date(sinceStr).getTime())) {
		throw new ValidationError("--since must be a valid ISO 8601 timestamp", {
			field: "since",
			value: sinceStr,
		});
	}
	if (untilStr !== undefined && Number.isNaN(new Date(untilStr).getTime())) {
		throw new ValidationError("--until must be a valid ISO 8601 timestamp", {
			field: "until",
			value: untilStr,
		});
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const legioDir = join(config.project.root, ".legio");

	// Open event store
	const eventsDbPath = join(legioDir, "events.db");
	const eventsFile = Bun.file(eventsDbPath);
	if (!(await eventsFile.exists())) {
		if (json) {
			process.stdout.write("[]\n");
		} else {
			process.stdout.write("No events data yet.\n");
		}
		return;
	}

	const eventStore = createEventStore(eventsDbPath);

	try {
		let events: StoredEvent[];
		const queryOpts = { since: sinceStr, until: untilStr, limit };

		if (runId) {
			// Query by run ID
			events = eventStore.getByRun(runId, queryOpts);
		} else if (agentNames.length > 0) {
			// Query each agent and merge
			const allEvents: StoredEvent[] = [];
			for (const name of agentNames) {
				const agentEvents = eventStore.getByAgent(name, {
					since: sinceStr,
					until: untilStr,
				});
				allEvents.push(...agentEvents);
			}
			// Sort by createdAt chronologically
			allEvents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			// Apply limit after merge
			events = allEvents.slice(0, limit);
		} else {
			// Default: try current-run.txt, then fall back to 24h timeline
			const currentRunPath = join(legioDir, "current-run.txt");
			const currentRunFile = Bun.file(currentRunPath);
			if (await currentRunFile.exists()) {
				const currentRunId = (await currentRunFile.text()).trim();
				if (currentRunId) {
					events = eventStore.getByRun(currentRunId, queryOpts);
				} else {
					// Empty file, fall back to timeline
					const since24h = sinceStr ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
					events = eventStore.getTimeline({
						since: since24h,
						until: untilStr,
						limit,
					});
				}
			} else {
				// No current run file, fall back to 24h timeline
				const since24h = sinceStr ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
				events = eventStore.getTimeline({
					since: since24h,
					until: untilStr,
					limit,
				});
			}
		}

		if (json) {
			process.stdout.write(`${JSON.stringify(events)}\n`);
			return;
		}

		// Use absolute time if --since is specified, relative otherwise
		const useAbsoluteTime = sinceStr !== undefined;
		printReplay(events, useAbsoluteTime);
	} finally {
		eventStore.close();
	}
}
