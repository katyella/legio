/**
 * Beads (bd) CLI client.
 *
 * Wraps the `bd` command-line tool for issue tracking operations.
 * All commands use `--json` for parseable output where supported.
 * Uses Bun.spawn — zero runtime dependencies.
 */

import { AgentError } from "../errors.ts";

/**
 * A beads issue as returned by the bd CLI.
 * Defined locally since it comes from an external CLI tool.
 */
export interface BeadIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	type: string;
	assignee?: string;
	description?: string;
	blocks?: string[];
	blockedBy?: string[];
}

export interface BeadsClient {
	/** List issues that are ready for work (open, unblocked). */
	ready(options?: { mol?: string }): Promise<BeadIssue[]>;

	/** Show details for a specific issue. */
	show(id: string): Promise<BeadIssue>;

	/** Create a new issue. Returns the new issue ID. */
	create(
		title: string,
		options?: { type?: string; priority?: number; description?: string },
	): Promise<string>;

	/** Claim an issue (mark as in_progress). */
	claim(id: string): Promise<void>;

	/** Close an issue with an optional reason. */
	close(id: string, reason?: string): Promise<void>;

	/** List issues with optional filters. */
	list(options?: { status?: string; limit?: number }): Promise<BeadIssue[]>;
}

/**
 * Run a shell command and capture its output.
 */
async function runCommand(
	cmd: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/**
 * Parse JSON output from a bd command.
 * Handles the case where output may be empty or malformed.
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
 * Raw issue shape from the bd CLI.
 * bd uses `issue_type` instead of `type`.
 */
interface RawBeadIssue {
	id: string;
	title: string;
	status: string;
	priority: number;
	issue_type?: string;
	type?: string;
	assignee?: string;
	description?: string;
	blocks?: string[];
	blockedBy?: string[];
}

/**
 * Normalize a raw bd issue into a BeadIssue.
 * Maps `issue_type` -> `type` to match the BeadIssue interface.
 */
function normalizeIssue(raw: RawBeadIssue): BeadIssue {
	return {
		id: raw.id,
		title: raw.title,
		status: raw.status,
		priority: raw.priority,
		type: raw.issue_type ?? raw.type ?? "unknown",
		assignee: raw.assignee,
		description: raw.description,
		blocks: raw.blocks,
		blockedBy: raw.blockedBy,
	};
}

/**
 * Create a BeadsClient bound to the given working directory.
 *
 * @param cwd - Working directory where bd commands should run
 * @returns A BeadsClient instance wrapping the bd CLI
 */
export function createBeadsClient(cwd: string): BeadsClient {
	async function runBd(
		args: string[],
		context: string,
	): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr, exitCode } = await runCommand(["bd", ...args], cwd);
		if (exitCode !== 0) {
			throw new AgentError(`bd ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	}

	return {
		async ready(options) {
			const args = ["ready", "--json"];
			if (options?.mol) {
				args.push("--mol", options.mol);
			}
			const { stdout } = await runBd(args, "ready");
			const raw = parseJsonOutput<RawBeadIssue[]>(stdout, "ready");
			return raw.map(normalizeIssue);
		},

		async show(id) {
			const { stdout } = await runBd(["show", id, "--json"], `show ${id}`);
			// bd show --json returns an array with a single element
			const raw = parseJsonOutput<RawBeadIssue[]>(stdout, `show ${id}`);
			const first = raw[0];
			if (!first) {
				throw new AgentError(`bd show ${id} returned empty array`);
			}
			return normalizeIssue(first);
		},

		async create(title, options) {
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

		async claim(id) {
			await runBd(["update", id, "--status", "in_progress"], `claim ${id}`);
		},

		async close(id, reason) {
			const args = ["close", id];
			if (reason) {
				args.push("--reason", reason);
			}
			await runBd(args, `close ${id}`);
		},

		async list(options) {
			const args = ["list", "--json"];
			if (options?.status) {
				args.push("--status", options.status);
			}
			if (options?.limit !== undefined) {
				args.push("--limit", String(options.limit));
			}
			const { stdout } = await runBd(args, "list");
			const raw = parseJsonOutput<RawBeadIssue[]>(stdout, "list");
			return raw.map(normalizeIssue);
		},
	};
}
