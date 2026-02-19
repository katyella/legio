/**
 * CLI command: legio doctor [options]
 *
 * Runs health checks on legio subsystems and reports problems.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { checkAgents } from "../doctor/agents.ts";
import { checkConfig } from "../doctor/config-check.ts";
import { checkConsistency } from "../doctor/consistency.ts";
import { checkDatabases } from "../doctor/databases.ts";
import { checkDependencies } from "../doctor/dependencies.ts";
import { checkLogs } from "../doctor/logs.ts";
import { checkMergeQueue } from "../doctor/merge-queue.ts";
import { checkStructure } from "../doctor/structure.ts";
import type { DoctorCategory, DoctorCheck, DoctorCheckFn } from "../doctor/types.ts";
import { checkVersion } from "../doctor/version.ts";
import { ValidationError } from "../errors.ts";
import { color } from "../logging/color.ts";

/** Registry of all check modules in execution order. */
const ALL_CHECKS: Array<{ category: DoctorCategory; fn: DoctorCheckFn }> = [
	{ category: "dependencies", fn: checkDependencies },
	{ category: "config", fn: checkConfig },
	{ category: "structure", fn: checkStructure },
	{ category: "databases", fn: checkDatabases },
	{ category: "consistency", fn: checkConsistency },
	{ category: "agents", fn: checkAgents },
	{ category: "merge", fn: checkMergeQueue },
	{ category: "logs", fn: checkLogs },
	{ category: "version", fn: checkVersion },
];

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) {
		return undefined;
	}
	return args[idx + 1];
}

/**
 * Format human-readable output for doctor checks.
 */
function printHumanReadable(
	checks: DoctorCheck[],
	verbose: boolean,
	checkRegistry: Array<{ category: DoctorCategory; fn: DoctorCheckFn }>,
): void {
	const w = process.stdout.write.bind(process.stdout);

	w(`${color.bold}Legio Doctor${color.reset}\n`);
	w("================\n\n");

	// Group checks by category
	const byCategory = new Map<DoctorCategory, DoctorCheck[]>();
	for (const check of checks) {
		const existing = byCategory.get(check.category);
		if (existing) {
			existing.push(check);
		} else {
			byCategory.set(check.category, [check]);
		}
	}

	// Print each category
	for (const { category } of checkRegistry) {
		const categoryChecks = byCategory.get(category) ?? [];
		if (categoryChecks.length === 0 && !verbose) {
			continue; // Skip empty categories unless verbose
		}

		w(`${color.bold}[${category}]${color.reset}\n`);

		if (categoryChecks.length === 0) {
			w(`  ${color.dim}No checks${color.reset}\n`);
		} else {
			for (const check of categoryChecks) {
				// Skip passing checks unless verbose
				if (check.status === "pass" && !verbose) {
					continue;
				}

				const icon =
					check.status === "pass"
						? `${color.green}✔${color.reset}`
						: check.status === "warn"
							? `${color.yellow}⚠${color.reset}`
							: `${color.red}✘${color.reset}`;

				w(`  ${icon} ${check.message}\n`);

				// Print details if present
				if (check.details && check.details.length > 0) {
					for (const detail of check.details) {
						w(`    ${color.dim}→ ${detail}${color.reset}\n`);
					}
				}
			}
		}

		w("\n");
	}

	// Summary
	const pass = checks.filter((c) => c.status === "pass").length;
	const warn = checks.filter((c) => c.status === "warn").length;
	const fail = checks.filter((c) => c.status === "fail").length;

	w(
		`${color.bold}Summary:${color.reset} ${color.green}${pass} passed${color.reset}, ${color.yellow}${warn} warning${warn === 1 ? "" : "s"}${color.reset}, ${color.red}${fail} failure${fail === 1 ? "" : "s"}${color.reset}\n`,
	);
}

/**
 * Format JSON output for doctor checks.
 */
function printJSON(checks: DoctorCheck[]): void {
	const pass = checks.filter((c) => c.status === "pass").length;
	const warn = checks.filter((c) => c.status === "warn").length;
	const fail = checks.filter((c) => c.status === "fail").length;

	const output = {
		checks,
		summary: { pass, warn, fail },
	};

	process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

const DOCTOR_HELP = `legio doctor -- Run health checks on legio subsystems

Usage: legio doctor [options]

Options:
  --json                 Output as JSON
  --verbose              Show passing checks (default: only problems)
  --category <name>      Run only one category
  --help, -h             Show this help

Categories: dependencies, structure, config, databases, consistency, agents, merge, logs, version`;

/** Options for dependency injection in doctorCommand. */
export interface DoctorCommandOptions {
	/** Override the check runners (defaults to ALL_CHECKS). Pass [] to skip all checks. */
	checkRunners?: Array<{ category: DoctorCategory; fn: DoctorCheckFn }>;
}

/**
 * Entry point for `legio doctor [--json] [--verbose] [--category <name>]`.
 *
 * @returns Exit code (1 if any check failed, undefined otherwise)
 */
export async function doctorCommand(
	args: string[],
	options?: DoctorCommandOptions,
): Promise<number | undefined> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(`${DOCTOR_HELP}\n`);
		return;
	}

	const json = hasFlag(args, "--json");
	const verbose = hasFlag(args, "--verbose");
	const categoryFilter = getFlag(args, "--category");

	// Validate category filter if provided
	if (categoryFilter !== undefined) {
		const validCategories = ALL_CHECKS.map((c) => c.category);
		if (!validCategories.includes(categoryFilter as DoctorCategory)) {
			throw new ValidationError(
				`Invalid category: ${categoryFilter}. Valid categories: ${validCategories.join(", ")}`,
				{
					field: "category",
					value: categoryFilter,
				},
			);
		}
	}

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const legioDir = join(config.project.root, ".legio");

	// Filter checks by category if specified
	const allChecks = options?.checkRunners ?? ALL_CHECKS;
	const checksToRun = categoryFilter
		? allChecks.filter((c) => c.category === categoryFilter)
		: allChecks;

	// Run all checks sequentially
	const results: DoctorCheck[] = [];
	for (const { fn } of checksToRun) {
		const checkResults = await fn(config, legioDir);
		results.push(...checkResults);
	}

	// Output results
	if (json) {
		printJSON(results);
	} else {
		printHumanReadable(results, verbose, allChecks);
	}

	// Return exit code if any check failed
	const hasFailures = results.some((c) => c.status === "fail");
	return hasFailures ? 1 : undefined;
}
