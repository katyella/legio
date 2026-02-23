/**
 * Mulch CLI client.
 *
 * Wraps the `mulch` command-line tool for structured expertise operations.
 * Uses node:child_process — zero runtime npm dependencies.
 */

import { spawn } from "node:child_process";
import { AgentError } from "../errors.ts";
import type {
	MulchCompactResult,
	MulchDiffResult,
	MulchDoctorResult,
	MulchLearnResult,
	MulchPruneResult,
	MulchReadyResult,
	MulchStatus,
} from "../types.ts";

export interface MulchClient {
	/** Generate a priming prompt, optionally scoped to specific domains. */
	prime(
		domains?: string[],
		format?: "markdown" | "xml" | "json",
		options?: {
			files?: string[];
			excludeDomain?: string[];
		},
	): Promise<string>;

	/** Show domain statistics. */
	status(): Promise<MulchStatus>;

	/** Record an expertise entry for a domain. */
	record(
		domain: string,
		options: {
			type: string;
			name?: string;
			description?: string;
			title?: string;
			rationale?: string;
			tags?: string[];
			classification?: string;
			stdin?: boolean;
			evidenceBead?: string;
		},
	): Promise<void>;

	/** Query expertise records, optionally scoped to a domain. */
	query(domain?: string): Promise<string>;

	/** Search records across all domains. */
	search(query: string): Promise<string>;

	/** Show expertise record changes since a git ref. */
	diff(options?: { since?: string }): Promise<MulchDiffResult>;

	/** Show changed files and suggest domains for recording learnings. */
	learn(options?: { since?: string }): Promise<MulchLearnResult>;

	/** Remove unused or stale records. */
	prune(options?: { dryRun?: boolean }): Promise<MulchPruneResult>;

	/** Run health checks on mulch repository. */
	doctor(options?: { fix?: boolean }): Promise<MulchDoctorResult>;

	/** Show recently added or updated expertise records. */
	ready(options?: { limit?: number; domain?: string; since?: string }): Promise<MulchReadyResult>;

	/** Compact and optimize domain storage. */
	compact(
		domain?: string,
		options?: {
			analyze?: boolean;
			apply?: boolean;
			auto?: boolean;
			dryRun?: boolean;
			minGroup?: number;
			maxRecords?: number;
			yes?: boolean;
			records?: string[];
		},
	): Promise<MulchCompactResult>;
}

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
 * Default mapping from glob patterns to mulch domain names.
 * Used by inferDomainsFromFiles() when no custom map is provided.
 */
export const DEFAULT_DOMAIN_MAP: Record<string, string[]> = {
	"src/commands/**": ["cli"],
	"src/server/routes*": ["server"],
	"src/server/public/**": ["frontend"],
	"src/sessions/**": ["server"],
	"src/metrics/**": ["server"],
	"src/events/**": ["server"],
	"src/mail/**": ["server"],
	"src/agents/**": ["swarm"],
	"src/worktree/**": ["swarm", "merge"],
	"src/merge/**": ["merge"],
	"src/beads/**": ["cli"],
	"src/*.test.*": ["testing"],
	"src/**/*.test.*": ["testing"],
	"agents/**": ["swarm"],
	"templates/**": ["swarm"],
};

/**
 * Convert a glob pattern to a regular expression and test it against a file path.
 *
 * Rules:
 * - `**` in `/**\/` position matches zero or more path segments (including zero)
 * - `**` at the end of pattern matches any remaining path
 * - `*` matches any characters within a single path segment (no slashes)
 * - All other regex special characters are escaped
 *
 * @internal
 */
function matchGlob(pattern: string, filePath: string): boolean {
	let regexStr = "^";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === undefined) break;
		if (ch === "*" && i + 1 < pattern.length && pattern[i + 1] === "*") {
			// Check for /**/  in the middle of the pattern
			if (
				i > 0 &&
				pattern[i - 1] === "/" &&
				i + 2 < pattern.length &&
				pattern[i + 2] === "/"
			) {
				// /**/  → match zero or more path segments (consumes the trailing /)
				regexStr += "(?:.*/)?";
				i += 3; // skip **/
			} else {
				// ** at end (or start, or without surrounding slashes) → match anything
				regexStr += ".*";
				i += 2;
			}
		} else if (ch === "*") {
			// * → match any chars within a single segment (no slashes)
			regexStr += "[^/]*";
			i++;
		} else {
			// Escape regex special chars
			regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			i++;
		}
	}
	regexStr += "$";
	return new RegExp(regexStr).test(filePath);
}

/**
 * Infer mulch domain names from a list of file paths using glob pattern matching.
 *
 * Maps file paths to domain names using the provided domain map (or DEFAULT_DOMAIN_MAP).
 * Returns a deduplicated array of matched domain names.
 *
 * @param files - File paths to match (relative to project root)
 * @param domainMap - Optional custom glob-to-domain mapping; falls back to DEFAULT_DOMAIN_MAP
 * @returns Deduplicated array of matched domain names
 */
export function inferDomainsFromFiles(
	files: readonly string[],
	domainMap?: Record<string, string[]>,
): string[] {
	const map = domainMap ?? DEFAULT_DOMAIN_MAP;
	const domainsSet = new Set<string>();
	for (const file of files) {
		for (const [pattern, domains] of Object.entries(map)) {
			if (matchGlob(pattern, file)) {
				for (const domain of domains) {
					domainsSet.add(domain);
				}
			}
		}
	}
	return Array.from(domainsSet);
}

/**
 * Create a MulchClient bound to the given working directory.
 *
 * @param cwd - Working directory where mulch commands should run
 * @returns A MulchClient instance wrapping the mulch CLI
 */
export function createMulchClient(cwd: string): MulchClient {
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
		async prime(domains, format, options) {
			const args = ["prime"];
			if (domains && domains.length > 0) {
				args.push(...domains);
			}
			if (format) {
				args.push("--format", format);
			}
			if (options?.files && options.files.length > 0) {
				args.push("--files", ...options.files);
			}
			if (options?.excludeDomain && options.excludeDomain.length > 0) {
				args.push("--exclude-domain", ...options.excludeDomain);
			}
			const { stdout } = await runMulch(args, "prime");
			return stdout;
		},

		async status() {
			const { stdout } = await runMulch(["status", "--json"], "status");
			const trimmed = stdout.trim();
			if (trimmed === "") {
				return { domains: [] };
			}
			try {
				return JSON.parse(trimmed) as MulchStatus;
			} catch {
				throw new AgentError(
					`Failed to parse JSON output from mulch status: ${trimmed.slice(0, 200)}`,
				);
			}
		},

		async record(domain, options) {
			const args = ["record", domain, "--type", options.type];
			if (options.name) {
				args.push("--name", options.name);
			}
			if (options.description) {
				args.push("--description", options.description);
			}
			if (options.title) {
				args.push("--title", options.title);
			}
			if (options.rationale) {
				args.push("--rationale", options.rationale);
			}
			if (options.tags && options.tags.length > 0) {
				args.push("--tags", options.tags.join(","));
			}
			if (options.classification) {
				args.push("--classification", options.classification);
			}
			if (options.stdin) {
				args.push("--stdin");
			}
			if (options.evidenceBead) {
				args.push("--evidence-bead", options.evidenceBead);
			}
			await runMulch(args, `record ${domain}`);
		},

		async query(domain) {
			const args = ["query"];
			if (domain) {
				args.push(domain);
			}
			const { stdout } = await runMulch(args, "query");
			return stdout;
		},

		async search(query) {
			const { stdout } = await runMulch(["search", query], "search");
			return stdout;
		},

		async diff(options) {
			const args = ["diff", "--json"];
			if (options?.since) {
				args.push("--since", options.since);
			}
			const { stdout } = await runMulch(args, "diff");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchDiffResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch diff: ${trimmed.slice(0, 200)}`);
			}
		},

		async learn(options) {
			const args = ["learn", "--json"];
			if (options?.since) {
				args.push("--since", options.since);
			}
			const { stdout } = await runMulch(args, "learn");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchLearnResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch learn: ${trimmed.slice(0, 200)}`);
			}
		},

		async prune(options) {
			const args = ["prune", "--json"];
			if (options?.dryRun) {
				args.push("--dry-run");
			}
			const { stdout } = await runMulch(args, "prune");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchPruneResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch prune: ${trimmed.slice(0, 200)}`);
			}
		},

		async doctor(options) {
			const args = ["doctor", "--json"];
			if (options?.fix) {
				args.push("--fix");
			}
			const { stdout } = await runMulch(args, "doctor");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchDoctorResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch doctor: ${trimmed.slice(0, 200)}`);
			}
		},

		async ready(options) {
			const args = ["ready", "--json"];
			if (options?.limit !== undefined) {
				args.push("--limit", String(options.limit));
			}
			if (options?.domain) {
				args.push("--domain", options.domain);
			}
			if (options?.since) {
				args.push("--since", options.since);
			}
			const { stdout } = await runMulch(args, "ready");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchReadyResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch ready: ${trimmed.slice(0, 200)}`);
			}
		},

		async compact(domain, options) {
			const args = ["compact", "--json"];
			if (domain) {
				args.push(domain);
			}
			if (options?.analyze) {
				args.push("--analyze");
			}
			if (options?.apply) {
				args.push("--apply");
			}
			if (options?.auto) {
				args.push("--auto");
			}
			if (options?.dryRun) {
				args.push("--dry-run");
			}
			if (options?.minGroup !== undefined) {
				args.push("--min-group", String(options.minGroup));
			}
			if (options?.maxRecords !== undefined) {
				args.push("--max-records", String(options.maxRecords));
			}
			if (options?.yes) {
				args.push("--yes");
			}
			if (options?.records && options.records.length > 0) {
				args.push("--records", options.records.join(","));
			}
			const { stdout } = await runMulch(args, domain ? `compact ${domain}` : "compact");
			const trimmed = stdout.trim();
			try {
				return JSON.parse(trimmed) as MulchCompactResult;
			} catch {
				throw new AgentError(`Failed to parse JSON from mulch compact: ${trimmed.slice(0, 200)}`);
			}
		},
	};
}
