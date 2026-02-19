/**
 * Tier 1 AI-assisted failure classification for stalled agents.
 *
 * When an agent is detected as stalled, triage reads recent log entries and
 * uses Claude to classify the situation as recoverable, fatal, or long-running.
 * Falls back to "extend" if Claude is unavailable.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentError } from "../errors.ts";

/**
 * Triage a stalled agent by analyzing its recent log output with Claude.
 *
 * Steps:
 * 1. Find the most recent session log directory for the agent
 * 2. Read the last 50 lines of session.log
 * 3. Ask Claude to classify the situation
 * 4. Parse the response to determine action
 *
 * @param options.agentName - Name of the agent to triage
 * @param options.root - Project root directory (contains .legio/)
 * @param options.lastActivity - ISO timestamp of the agent's last recorded activity
 * @returns "retry" if recoverable, "terminate" if fatal, "extend" if likely long-running
 */
export async function triageAgent(options: {
	agentName: string;
	root: string;
	lastActivity: string;
	/** Timeout in ms for the Claude subprocess. Defaults to 30_000 (30s). */
	timeoutMs?: number;
}): Promise<"retry" | "terminate" | "extend"> {
	const { agentName, root, lastActivity, timeoutMs } = options;
	const logsDir = join(root, ".legio", "logs", agentName);

	let logContent: string;
	try {
		logContent = await readRecentLog(logsDir);
	} catch {
		// No logs available — assume long-running operation
		return "extend";
	}

	const prompt = buildTriagePrompt(agentName, lastActivity, logContent);

	try {
		const response = await spawnClaude(prompt, timeoutMs);
		return classifyResponse(response);
	} catch {
		// Claude not available — default to extend (safe fallback)
		return "extend";
	}
}

/**
 * Read the last 50 lines of the most recent session.log for an agent.
 *
 * @param logsDir - Path to the agent's logs directory (e.g., .legio/logs/{agent}/)
 * @returns The last 50 lines of the session log as a string
 * @throws AgentError if no log directories or session.log are found
 */
async function readRecentLog(logsDir: string): Promise<string> {
	let entries: string[];
	try {
		entries = await readdir(logsDir);
	} catch {
		throw new AgentError(`No log directory found at ${logsDir}`);
	}

	if (entries.length === 0) {
		throw new AgentError(`No session directories in ${logsDir}`);
	}

	// Session directories are named with timestamps — sort descending to get most recent
	const sorted = entries.sort().reverse();
	const mostRecent = sorted[0];
	if (mostRecent === undefined) {
		throw new AgentError(`No session directories in ${logsDir}`);
	}

	const logPath = join(logsDir, mostRecent, "session.log");
	let content: string;
	try {
		content = await readFile(logPath, "utf-8");
	} catch {
		throw new AgentError(`No session.log found at ${logPath}`);
	}

	const lines = content.split("\n");

	// Take the last 50 non-empty lines
	const tail = lines.slice(-50).join("\n");
	return tail;
}

/**
 * Build the triage prompt for Claude analysis.
 */
export function buildTriagePrompt(
	agentName: string,
	lastActivity: string,
	logContent: string,
): string {
	return [
		"Analyze this agent log and classify the situation.",
		`Agent: ${agentName}`,
		`Last activity: ${lastActivity}`,
		"",
		"Respond with exactly one word: 'retry' if the error is recoverable,",
		"'terminate' if the error is fatal or the agent has failed,",
		"or 'extend' if this looks like a long-running operation.",
		"",
		"Log content:",
		"```",
		logContent,
		"```",
	].join("\n");
}

/** Default timeout for Claude subprocess: 30 seconds */
const DEFAULT_TRIAGE_TIMEOUT_MS = 30_000;

/**
 * Spawn Claude in non-interactive mode to analyze the log.
 *
 * @param prompt - The analysis prompt
 * @param timeoutMs - Timeout in ms for the subprocess (default 30s)
 * @returns Claude's response text
 * @throws Error if claude is not installed, the process fails, or the timeout is reached
 */
async function spawnClaude(prompt: string, timeoutMs?: number): Promise<string> {
	const timeout = timeoutMs ?? DEFAULT_TRIAGE_TIMEOUT_MS;

	return new Promise((resolve, reject) => {
		const proc = spawn("claude", ["--print", "-p", prompt], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (proc.stdout === null || proc.stderr === null) {
			reject(new AgentError("spawn failed to create stdio pipes"));
			return;
		}

		const timer = globalThis.setTimeout(() => {
			proc.kill();
		}, timeout);

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		proc.stdout.on("data", (data: Buffer) => stdoutChunks.push(data));
		proc.stderr.on("data", (data: Buffer) => stderrChunks.push(data));

		proc.on("close", (code) => {
			clearTimeout(timer);
			const stdout = Buffer.concat(stdoutChunks).toString().trim();
			if (code !== 0) {
				const stderr = Buffer.concat(stderrChunks).toString().trim();
				reject(new AgentError(`Claude triage failed (exit ${code}): ${stderr}`));
				return;
			}
			resolve(stdout);
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Classify Claude's response into a triage action.
 *
 * @param response - Claude's raw response text
 * @returns "retry" | "terminate" | "extend"
 */
export function classifyResponse(response: string): "retry" | "terminate" | "extend" {
	const lower = response.toLowerCase();

	if (lower.includes("retry") || lower.includes("recoverable")) {
		return "retry";
	}

	if (lower.includes("terminate") || lower.includes("fatal") || lower.includes("failed")) {
		return "terminate";
	}

	// Default: assume long-running operation
	return "extend";
}
