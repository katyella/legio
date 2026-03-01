/**
 * Beads adapter for the tracker abstraction layer.
 *
 * Wraps the bd CLI to implement TrackerClient. Reuses the same
 * normalizeIssue/parseJsonOutput patterns as seeds.ts for consistency.
 */

import { AgentError } from "../errors.ts";
import { runTrackerCommand } from "./exec.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Parse JSON output from a bd command.
 */
function parseJsonOutput<T>(stdout: string, context: string): T {
	const trimmed = stdout.trim();
	if (trimmed === "") {
		throw new AgentError(`Empty output from bd ${context}`);
	}
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new AgentError(
			`Failed to parse JSON output from bd ${context}: ${trimmed.slice(0, 200)}`,
		);
	}
}

/**
 * Raw issue shape from the bd CLI (snake_case fields).
 */
interface RawBeadIssue {
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
 * Normalize a raw bd issue into a TrackerIssue (camelCase).
 */
function normalizeIssue(raw: RawBeadIssue): TrackerIssue {
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
 * Create a TrackerClient backed by the beads (bd) CLI.
 *
 * @param cwd - Working directory where bd commands should run
 */
export function createBeadsTrackerClient(cwd: string): TrackerClient {
	async function runBd(
		args: string[],
		context: string,
	): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr, exitCode } = await runTrackerCommand(["bd", ...args], cwd);
		if (exitCode !== 0) {
			throw new AgentError(`bd ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	}

	return {
		async ready(options): Promise<TrackerIssue[]> {
			const args = ["ready", "--json"];
			if (options?.mol) {
				args.push("--mol", options.mol);
			}
			const { stdout } = await runBd(args, "ready");
			const raw = parseJsonOutput<RawBeadIssue[]>(stdout, "ready");
			return raw.map(normalizeIssue);
		},

		async show(id): Promise<TrackerIssue> {
			const { stdout } = await runBd(["show", id, "--json"], `show ${id}`);
			const raw = parseJsonOutput<RawBeadIssue[]>(stdout, `show ${id}`);
			const first = raw[0];
			if (!first) {
				throw new AgentError(`bd show ${id} returned empty array`);
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
			const { stdout } = await runBd(args, "create");
			const result = parseJsonOutput<{ id: string }>(stdout, "create");
			return result.id;
		},

		async claim(id): Promise<void> {
			await runBd(["update", id, "--status", "in_progress"], `claim ${id}`);
		},

		async close(id, reason): Promise<void> {
			const args = ["close", id];
			if (reason) {
				args.push("--reason", reason);
			}
			await runBd(args, `close ${id}`);
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
			const { stdout } = await runBd(args, "list");
			const raw = parseJsonOutput<RawBeadIssue[]>(stdout, "list");
			return raw.map(normalizeIssue);
		},

		async sync(): Promise<void> {
			const { exitCode, stderr } = await runTrackerCommand(["bd", "sync"], cwd);
			if (exitCode !== 0) {
				throw new AgentError(`bd sync failed (exit ${exitCode}): ${stderr.trim()}`);
			}
		},
	};
}
