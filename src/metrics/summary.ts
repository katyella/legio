/**
 * Metrics reporting utilities.
 *
 * Generates summary statistics from a MetricsStore and formats them
 * for human-readable console output.
 */

import type { SessionMetrics } from "../types.ts";
import type { MetricsStore } from "./store.ts";

export interface TokenTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	estimatedCostUsd: number;
}

export interface MetricsSummary {
	totalSessions: number;
	completedSessions: number;
	averageDurationMs: number;
	byCapability: Record<string, { count: number; avgDurationMs: number }>;
	recentSessions: SessionMetrics[];
	tokenTotals: TokenTotals;
}

/**
 * Generate an aggregate summary from the metrics store.
 *
 * @param store - The MetricsStore to query
 * @param limit - Maximum number of recent sessions to include (default 10)
 */
export function generateSummary(store: MetricsStore, limit = 10): MetricsSummary {
	const recentSessions = store.getRecentSessions(limit);

	// Fetch all sessions for aggregate stats (use a generous limit)
	const allSessions = store.getRecentSessions(10_000);

	const totalSessions = allSessions.length;
	const completedSessions = allSessions.filter((s) => s.completedAt !== null).length;
	const averageDurationMs = store.getAverageDuration();

	// Group by capability
	const capabilityMap = new Map<string, { count: number; totalMs: number }>();
	for (const session of allSessions) {
		const existing = capabilityMap.get(session.capability);
		if (existing) {
			existing.count++;
			if (session.completedAt !== null) {
				existing.totalMs += session.durationMs;
			}
		} else {
			capabilityMap.set(session.capability, {
				count: 1,
				totalMs: session.completedAt !== null ? session.durationMs : 0,
			});
		}
	}

	const byCapability: Record<string, { count: number; avgDurationMs: number }> = {};
	for (const [capability, data] of capabilityMap) {
		const completedInCap = allSessions.filter(
			(s) => s.capability === capability && s.completedAt !== null,
		).length;
		byCapability[capability] = {
			count: data.count,
			avgDurationMs: completedInCap > 0 ? Math.round(data.totalMs / completedInCap) : 0,
		};
	}

	// Aggregate token totals across all sessions
	const tokenTotals: TokenTotals = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		estimatedCostUsd: 0,
	};
	for (const session of allSessions) {
		tokenTotals.inputTokens += session.inputTokens;
		tokenTotals.outputTokens += session.outputTokens;
		tokenTotals.cacheReadTokens += session.cacheReadTokens;
		tokenTotals.cacheCreationTokens += session.cacheCreationTokens;
		if (session.estimatedCostUsd !== null) {
			tokenTotals.estimatedCostUsd += session.estimatedCostUsd;
		}
	}

	return {
		totalSessions,
		completedSessions,
		averageDurationMs: Math.round(averageDurationMs),
		byCapability,
		recentSessions,
		tokenTotals,
	};
}

/**
 * Format a MetricsSummary into a human-readable string for console output.
 */
export function formatSummary(summary: MetricsSummary): string {
	const lines: string[] = [];

	lines.push("=== Session Metrics ===");
	lines.push("");
	lines.push(`Total sessions:     ${summary.totalSessions}`);
	lines.push(`Completed:          ${summary.completedSessions}`);
	lines.push(`Average duration:   ${formatDuration(summary.averageDurationMs)}`);

	const capabilities = Object.entries(summary.byCapability);
	if (capabilities.length > 0) {
		lines.push("");
		lines.push("By capability:");
		for (const [cap, data] of capabilities) {
			lines.push(`  ${cap}: ${data.count} sessions, avg ${formatDuration(data.avgDurationMs)}`);
		}
	}

	// Token usage section (only if any tokens were recorded)
	const tt = summary.tokenTotals;
	const hasTokenData =
		tt.inputTokens > 0 ||
		tt.outputTokens > 0 ||
		tt.cacheReadTokens > 0 ||
		tt.cacheCreationTokens > 0;

	if (hasTokenData) {
		lines.push("");
		lines.push("Token usage:");
		lines.push(`  Input:           ${formatTokenCount(tt.inputTokens)}`);
		lines.push(`  Output:          ${formatTokenCount(tt.outputTokens)}`);
		lines.push(`  Cache read:      ${formatTokenCount(tt.cacheReadTokens)}`);
		lines.push(`  Cache creation:  ${formatTokenCount(tt.cacheCreationTokens)}`);
		if (tt.estimatedCostUsd > 0) {
			lines.push(`  Estimated cost:  $${tt.estimatedCostUsd.toFixed(2)}`);
		}
	}

	if (summary.recentSessions.length > 0) {
		lines.push("");
		lines.push("Recent sessions:");
		for (const session of summary.recentSessions) {
			const status = session.completedAt !== null ? "done" : "running";
			const duration =
				session.completedAt !== null ? formatDuration(session.durationMs) : "in progress";
			const costSuffix =
				session.estimatedCostUsd !== null ? ` $${session.estimatedCostUsd.toFixed(2)}` : "";
			lines.push(
				`  ${session.agentName} [${session.capability}] ${status} (${duration})${costSuffix}`,
			);
		}
	}

	return lines.join("\n");
}

/** Format milliseconds into a human-friendly duration string. */
function formatDuration(ms: number): string {
	if (ms < 1_000) {
		return `${ms}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1_000).toFixed(1)}s`;
	}
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	return `${minutes}m ${seconds}s`;
}

/** Format a token count into a human-friendly string (e.g., 1,234,567 or 1.2M). */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	return count.toLocaleString("en-US");
}
