/**
 * Mulch CLI adapter for the memory system.
 *
 * Wraps the external `mulch` command-line tool to implement the MemoryClient
 * interface. Keeps mulch as an optional backend for users who have it installed.
 *
 * Uses node:child_process spawn — zero runtime npm dependencies.
 */

import { spawn } from "node:child_process";
import { AgentError } from "../errors.ts";
import { inferDomainsFromFiles } from "./domain-map.ts";
import type { MemoryClient, MemoryRecord } from "./types.ts";

/**
 * Run a shell command and capture its output.
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
		proc.on("error", reject);
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
 * Create a MemoryClient that delegates to the mulch CLI.
 *
 * @param cwd - Working directory where mulch commands should run
 */
export function createMulchMemoryClient(cwd: string): MemoryClient {
	async function runMulch(
		args: string[],
		context: string,
	): Promise<{ stdout: string; stderr: string }> {
		const { stdout, stderr, exitCode } = await runCommand(["mulch", ...args], cwd);
		if (exitCode !== 0) {
			throw new AgentError(`mulch ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
		}
		return { stdout, stderr };
	}

	return {
		async prime(options) {
			const args = ["prime"];
			if (options?.domains && options.domains.length > 0) {
				args.push(...options.domains);
			}
			if (options?.format) {
				args.push("--format", options.format);
			}
			if (options?.files && options.files.length > 0) {
				args.push("--files", ...options.files);
			}
			if (options?.budget !== undefined) {
				args.push("--budget", String(options.budget));
			}
			const { stdout } = await runMulch(args, "prime");
			return stdout;
		},

		async record(domain, options) {
			const args = ["record", domain, "--type", options.type];
			if (options.description) {
				args.push("--description", options.description);
			}
			if (options.tags && options.tags.length > 0) {
				args.push("--tags", options.tags.join(","));
			}
			if (options.classification) {
				args.push("--classification", options.classification);
			}
			if (options.evidenceCommit) {
				args.push("--evidence-commit", options.evidenceCommit);
			}
			if (options.evidenceBead) {
				args.push("--evidence-bead", options.evidenceBead);
			}
			await runMulch(args, `record ${domain}`);
			// Mulch CLI doesn't return the record ID; return a placeholder
			return `mulch-${Date.now()}`;
		},

		async search(query) {
			const { stdout } = await runMulch(["search", query], "search");
			return stdout;
		},

		async query(domain) {
			const args = ["query"];
			if (domain) {
				args.push(domain);
			}
			const { stdout } = await runMulch(args, "query");
			return stdout;
		},

		async status() {
			const { stdout } = await runMulch(["status", "--json"], "status");
			const trimmed = stdout.trim();
			if (trimmed === "") {
				return [];
			}
			try {
				const parsed = JSON.parse(trimmed) as {
					domains: Array<{ name: string; recordCount: number; lastUpdated: string }>;
				};
				return parsed.domains.map((d) => ({
					name: d.name,
					recordCount: d.recordCount,
					lastUpdated: d.lastUpdated,
				}));
			} catch {
				throw new AgentError(
					`Failed to parse JSON output from mulch status: ${trimmed.slice(0, 200)}`,
				);
			}
		},

		async list(options) {
			// Mulch doesn't have a direct list command with these filters.
			// Use query + parse as best effort.
			const args = ["query"];
			if (options?.domain) {
				args.push(options.domain);
			}
			args.push("--json");
			try {
				const { stdout } = await runMulch(args, "list");
				const trimmed = stdout.trim();
				if (trimmed === "") return [];
				return JSON.parse(trimmed) as MemoryRecord[];
			} catch {
				return [];
			}
		},

		async show(id) {
			// Mulch doesn't have a show-by-id command. Search for the ID.
			const { stdout } = await runMulch(["search", id, "--json"], `show ${id}`);
			const trimmed = stdout.trim();
			if (trimmed === "") {
				throw new Error(`Record not found: ${id}`);
			}
			try {
				const results = JSON.parse(trimmed) as MemoryRecord[];
				const match = results.find((r) => r.id === id);
				if (!match) {
					throw new Error(`Record not found: ${id}`);
				}
				return match;
			} catch (err) {
				if (err instanceof Error && err.message.startsWith("Record not found")) {
					throw err;
				}
				throw new Error(`Record not found: ${id}`);
			}
		},

		async delete(_id) {
			// Mulch doesn't support deleting individual records via CLI.
			throw new Error("Delete is not supported by the mulch backend");
		},

		async prune(options) {
			const args = ["prune", "--json"];
			if (options?.dryRun) {
				args.push("--dry-run");
			}
			const { stdout } = await runMulch(args, "prune");
			const trimmed = stdout.trim();
			try {
				const parsed = JSON.parse(trimmed) as {
					totalPruned: number;
					dryRun: boolean;
				};
				return { pruned: parsed.totalPruned, dryRun: parsed.dryRun };
			} catch {
				return { pruned: 0, dryRun: options?.dryRun ?? false };
			}
		},

		suggestDomains(files) {
			return inferDomainsFromFiles(files);
		},
	};
}
