/**
 * Seeds adapter for the tracker abstraction layer.
 *
 * Wraps the `sd` CLI to implement TrackerClient using the seeds backend.
 * Follows the same patterns as src/beads/client.ts.
 */

import { spawn } from "node:child_process";
import { AgentError } from "../errors.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Run a shell command and capture output.
 */
async function runCommand(
	cmd: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const [command, ...args] = cmd;
	if (!command) throw new Error("Empty command");
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
		proc.stdout.on("data", (data: Buffer) => chunks.stdout.push(data));
		proc.stderr.on("data", (data: Buffer) => chunks.stderr.push(data));
		proc.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "ENOENT") {
				reject(
					new AgentError(`seeds CLI (sd) not found. Install it or switch to the beads backend.`),
				);
			} else {
				reject(err);
			}
		});
		proc.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(chunks.stdout).toString(),
				stderr: Buffer.concat(chunks.stderr).toString(),
				exitCode: code ?? 1,
			});
		});
	});
}

/**
 * Parse JSON output from an sd command.
 */
function parseJsonOutput<T>(stdout: string, context: string): T {
	const trimmed = stdout.trim();
	if (trimmed === "") {
		throw new AgentError(`Empty output from sd ${context}`);
	}
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new AgentError(
			`Failed to parse JSON output from sd ${context}: ${trimmed.slice(0, 200)}`,
		);
	}
}

/**
 * Raw issue shape from the sd CLI (snake_case fields).
 */
interface RawSeedIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	issue_type?: string;
	type?: string;
	owner?: string;
	assignee?: string;
	description?: string;
	blocks?: string[];
	blocked_by?: string[];
	blockedBy?: string[];
	closed_at?: string;
	close_reason?: string;
	created_at?: string;
}

/**
 * Normalize a raw sd issue into a TrackerIssue (camelCase).
 */
function normalizeIssue(raw: RawSeedIssue): TrackerIssue {
	return {
		id: raw.id,
		title: raw.title,
		status: raw.status,
		priority: raw.priority,
		type: raw.issue_type ?? raw.type ?? "unknown",
		assignee: raw.owner ?? raw.assignee,
		description: raw.description,
		blocks: raw.blocks,
		blockedBy: raw.blocked_by ?? raw.blockedBy,
		closedAt: raw.closed_at,
		closeReason: raw.close_reason,
		createdAt: raw.created_at,
	};
}

/**
 * Create a TrackerClient backed by the seeds (sd) CLI.
 *
 * Throws AgentError if the sd CLI is not installed.
 *
 * @param cwd - Working directory where sd commands should run
 */
export function createSeedsTrackerClient(cwd: string): TrackerClient {
	async function runSd(
		args: string[],
		context: string,
	): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr, exitCode } = await runCommand(["sd", ...args], cwd);
		if (exitCode !== 0) {
			throw new AgentError(`sd ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	}

	return {
		async ready(options): Promise<TrackerIssue[]> {
			const args = ["ready", "--json"];
			if (options?.mol) {
				args.push("--mol", options.mol);
			}
			const { stdout } = await runSd(args, "ready");
			const raw = parseJsonOutput<RawSeedIssue[]>(stdout, "ready");
			return raw.map(normalizeIssue);
		},

		async show(id): Promise<TrackerIssue> {
			const { stdout } = await runSd(["show", id, "--json"], `show ${id}`);
			const raw = parseJsonOutput<RawSeedIssue[]>(stdout, `show ${id}`);
			const first = raw[0];
			if (!first) {
				throw new AgentError(`sd show ${id} returned empty array`);
			}
			return normalizeIssue(first);
		},

		async create(title, options): Promise<string> {
			const args = ["create", title, "--json"];
			if (options?.type) {
				args.push("--type", options.type);
			}
			if (options?.priority !== undefined) {
				args.push("--priority", String(options.priority));
			}
			if (options?.description) {
				args.push("--description", options.description);
			}
			const { stdout } = await runSd(args, "create");
			const result = parseJsonOutput<{ id: string }>(stdout, "create");
			return result.id;
		},

		async claim(id): Promise<void> {
			await runSd(["update", id, "--status", "in_progress"], `claim ${id}`);
		},

		async close(id, reason): Promise<void> {
			const args = ["close", id];
			if (reason) {
				args.push("--reason", reason);
			}
			await runSd(args, `close ${id}`);
		},

		async list(options): Promise<TrackerIssue[]> {
			const args = ["list", "--json"];
			if (options?.status) {
				args.push("--status", options.status);
			}
			if (options?.limit !== undefined) {
				args.push("--limit", String(options.limit));
			}
			if (options?.all) {
				args.push("--all");
			}
			const { stdout } = await runSd(args, "list");
			const raw = parseJsonOutput<RawSeedIssue[]>(stdout, "list");
			return raw.map(normalizeIssue);
		},

		async sync(): Promise<void> {
			await runSd(["sync"], "sync");
		},
	};
}
