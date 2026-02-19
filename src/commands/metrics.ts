/**
 * CLI command: legio metrics [--last <n>] [--json]
 *
 * Shows metrics summary from SQLite store: session durations, success rates,
 * merge tier distribution, agent utilization.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { access } from "node:fs/promises";


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
 * Format milliseconds as human-readable duration.
 */
function formatDuration(ms: number): string {
	if (ms === 0) return "0s";
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
 * Entry point for `legio metrics [--last <n>] [--json]`.
 */
const METRICS_HELP = `legio metrics — Show session metrics

Usage: legio metrics [--last <n>] [--json]

Options:
  --last <n>         Number of recent sessions to show (default: 20)
  --json             Output as JSON
  --help, -h         Show this help`;

export async function metricsCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${METRICS_HELP}\n`);
		return;
	}

	const lastStr = getFlag(args, "--last");
	const limit = lastStr ? Number.parseInt(lastStr, 10) : 20;
	const json = hasFlag(args, "--json");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const dbPath = join(config.project.root, ".legio", "metrics.db");

	let dbFileExists = false;
	try { await access(dbPath); dbFileExists = true; } catch { /* not found */ }
	if (!dbFileExists) {
		if (json) {
			process.stdout.write('{"sessions":[]}\n');
		} else {
			process.stdout.write("No metrics data yet.\n");
		}
		return;
	}

	const store = createMetricsStore(dbPath);

	try {
		const sessions = store.getRecentSessions(limit);

		if (json) {
			process.stdout.write(`${JSON.stringify({ sessions })}\n`);
			return;
		}

		if (sessions.length === 0) {
			process.stdout.write("No sessions recorded yet.\n");
			return;
		}

		process.stdout.write("📈 Session Metrics\n");
		process.stdout.write(`${"═".repeat(60)}\n\n`);

		// Summary stats
		const completed = sessions.filter((s) => s.completedAt !== null);
		const avgDuration = store.getAverageDuration();

		process.stdout.write(`Total sessions: ${sessions.length}\n`);
		process.stdout.write(`Completed: ${completed.length}\n`);
		process.stdout.write(`Avg duration: ${formatDuration(avgDuration)}\n\n`);

		// Merge tier distribution
		const tierCounts: Record<string, number> = {};
		for (const s of completed) {
			if (s.mergeResult) {
				tierCounts[s.mergeResult] = (tierCounts[s.mergeResult] ?? 0) + 1;
			}
		}
		if (Object.keys(tierCounts).length > 0) {
			process.stdout.write("Merge tiers:\n");
			for (const [tier, count] of Object.entries(tierCounts)) {
				process.stdout.write(`  ${tier}: ${count}\n`);
			}
			process.stdout.write("\n");
		}

		// Capability breakdown
		const capCounts: Record<string, number> = {};
		for (const s of sessions) {
			capCounts[s.capability] = (capCounts[s.capability] ?? 0) + 1;
		}
		process.stdout.write("By capability:\n");
		for (const [cap, count] of Object.entries(capCounts)) {
			const capAvg = store.getAverageDuration(cap);
			process.stdout.write(`  ${cap}: ${count} sessions (avg ${formatDuration(capAvg)})\n`);
		}
		process.stdout.write("\n");

		// Recent sessions table
		process.stdout.write("Recent sessions:\n");
		for (const s of sessions) {
			const status = s.completedAt ? "done" : "running";
			const duration = formatDuration(s.durationMs);
			process.stdout.write(
				`  ${s.agentName} [${s.capability}] ${s.beadId} | ${status} | ${duration}\n`,
			);
		}
	} finally {
		store.close();
	}
}
