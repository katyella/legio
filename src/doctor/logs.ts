import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

const DISK_USAGE_WARN_THRESHOLD = 500 * 1024 * 1024; // 500MB in bytes

/**
 * Check if a path exists.
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Calculate total disk usage for a directory recursively.
 */
async function calculateDiskUsage(dirPath: string): Promise<number> {
	let totalBytes = 0;

	try {
		const entries = await readdir(dirPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dirPath, entry.name);

			if (entry.isDirectory()) {
				totalBytes += await calculateDiskUsage(fullPath);
			} else if (entry.isFile()) {
				const stats = await stat(fullPath);
				totalBytes += stats.size;
			}
		}
	} catch {
		// Ignore errors (permission denied, etc.)
	}

	return totalBytes;
}

/**
 * Format bytes as human-readable size.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Check NDJSON file for malformed lines.
 */
async function checkNDJSON(filePath: string): Promise<string[]> {
	const errors: string[] = [];

	try {
		const content = await readFile(filePath, "utf-8");
		const lines = content.split("\n").filter((line) => line.trim() !== "");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;

			try {
				JSON.parse(line);
			} catch {
				errors.push(`Line ${i + 1}: malformed JSON`);
			}
		}
	} catch {
		// File doesn't exist or can't be read
	}

	return errors;
}

/**
 * Check tools.ndjson for orphaned toolStart events.
 */
async function checkOrphanedToolEvents(filePath: string): Promise<string[]> {
	const orphans: string[] = [];

	try {
		const content = await readFile(filePath, "utf-8");
		const lines = content.split("\n").filter((line) => line.trim() !== "");

		const startEvents = new Set<string>();

		for (const line of lines) {
			if (!line) continue;

			try {
				const event = JSON.parse(line) as { event?: string; tool?: string; data?: unknown };

				if (event.event === "toolStart" && typeof event.tool === "string") {
					startEvents.add(event.tool);
				} else if (event.event === "toolEnd" && typeof event.tool === "string") {
					startEvents.delete(event.tool);
				}
			} catch {
				// Ignore malformed lines
			}
		}

		for (const tool of startEvents) {
			orphans.push(tool);
		}
	} catch {
		// File doesn't exist or can't be read
	}

	return orphans;
}

/**
 * Get per-agent log sizes.
 */
async function getPerAgentSizes(logsDir: string): Promise<Map<string, number>> {
	const sizes = new Map<string, number>();

	try {
		const agentDirs = await readdir(logsDir, { withFileTypes: true });

		for (const agentDir of agentDirs) {
			if (!agentDir.isDirectory()) continue;

			const agentPath = join(logsDir, agentDir.name);
			const size = await calculateDiskUsage(agentPath);
			sizes.set(agentDir.name, size);
		}
	} catch {
		// Logs directory doesn't exist or can't be read
	}

	return sizes;
}

/**
 * Log directory health checks.
 * Validates log directory structure and detects excessive log accumulation.
 */
export const checkLogs: DoctorCheckFn = async (_config, legioDir): Promise<DoctorCheck[]> => {
	const checks: DoctorCheck[] = [];
	const logsDir = join(legioDir, "logs");

	// Check 1: logs/ directory exists
	const logsDirExists = await pathExists(logsDir);
	checks.push({
		name: "logs/ directory",
		category: "logs",
		status: logsDirExists ? "pass" : "warn",
		message: logsDirExists
			? "Directory exists"
			: "Directory missing (will be created on first log)",
		details: logsDirExists ? undefined : ["Not an error - created automatically on agent spawn"],
		fixable: false,
	});

	// If logs/ doesn't exist, no further checks
	if (!logsDirExists) {
		return checks;
	}

	// Check 2: Total disk usage
	const totalBytes = await calculateDiskUsage(logsDir);
	checks.push({
		name: "Total disk usage",
		category: "logs",
		status: totalBytes > DISK_USAGE_WARN_THRESHOLD ? "warn" : "pass",
		message: `Using ${formatBytes(totalBytes)}`,
		details:
			totalBytes > DISK_USAGE_WARN_THRESHOLD
				? [
						`Exceeds ${formatBytes(DISK_USAGE_WARN_THRESHOLD)} threshold`,
						"Consider running 'legio worktree clean --completed' to remove old logs",
					]
				: undefined,
		fixable: totalBytes > DISK_USAGE_WARN_THRESHOLD,
	});

	// Check 3: Per-agent log sizes
	const perAgentSizes = await getPerAgentSizes(logsDir);
	if (perAgentSizes.size > 0) {
		const details = Array.from(perAgentSizes.entries())
			.sort((a, b) => b[1] - a[1]) // Sort by size descending
			.map(([agent, size]) => `${agent}: ${formatBytes(size)}`);

		checks.push({
			name: "Per-agent log sizes",
			category: "logs",
			status: "pass",
			message: `${perAgentSizes.size} agent(s) with logs`,
			details,
			fixable: false,
		});
	}

	// Check 4: Sample NDJSON files for malformed JSON
	// We'll check a few random session directories
	try {
		const agentDirs = await readdir(logsDir, { withFileTypes: true });
		const ndjsonErrors: string[] = [];

		for (const agentDir of agentDirs) {
			if (!agentDir.isDirectory()) continue;

			const agentPath = join(logsDir, agentDir.name);
			const sessionDirs = await readdir(agentPath, { withFileTypes: true });

			for (const sessionDir of sessionDirs) {
				if (!sessionDir.isDirectory()) continue;

				const sessionPath = join(agentPath, sessionDir.name);

				// Check events.ndjson
				const eventsErrors = await checkNDJSON(join(sessionPath, "events.ndjson"));
				if (eventsErrors.length > 0) {
					ndjsonErrors.push(
						`${agentDir.name}/${sessionDir.name}/events.ndjson: ${eventsErrors.length} error(s)`,
					);
				}

				// Check tools.ndjson
				const toolsErrors = await checkNDJSON(join(sessionPath, "tools.ndjson"));
				if (toolsErrors.length > 0) {
					ndjsonErrors.push(
						`${agentDir.name}/${sessionDir.name}/tools.ndjson: ${toolsErrors.length} error(s)`,
					);
				}
			}
		}

		if (ndjsonErrors.length > 0) {
			checks.push({
				name: "NDJSON integrity",
				category: "logs",
				status: "warn",
				message: `Found ${ndjsonErrors.length} file(s) with malformed JSON`,
				details: ndjsonErrors.slice(0, 10), // Limit to first 10
				fixable: false,
			});
		} else {
			checks.push({
				name: "NDJSON integrity",
				category: "logs",
				status: "pass",
				message: "All sampled NDJSON files are valid",
				fixable: false,
			});
		}

		// Check 5: Orphaned toolStart events
		const orphanedTools: string[] = [];

		for (const agentDir of agentDirs) {
			if (!agentDir.isDirectory()) continue;

			const agentPath = join(logsDir, agentDir.name);
			const sessionDirs = await readdir(agentPath, { withFileTypes: true });

			for (const sessionDir of sessionDirs) {
				if (!sessionDir.isDirectory()) continue;

				const sessionPath = join(agentPath, sessionDir.name);
				const orphans = await checkOrphanedToolEvents(join(sessionPath, "tools.ndjson"));

				if (orphans.length > 0) {
					orphanedTools.push(
						`${agentDir.name}/${sessionDir.name}: ${orphans.join(", ")} (incomplete session)`,
					);
				}
			}
		}

		if (orphanedTools.length > 0) {
			checks.push({
				name: "Orphaned tool events",
				category: "logs",
				status: "warn",
				message: `Found ${orphanedTools.length} session(s) with incomplete tool logs`,
				details: orphanedTools.slice(0, 10), // Limit to first 10
				fixable: false,
			});
		}
	} catch {
		// Ignore errors reading log directories
	}

	return checks;
};
