/**
 * CLI command: legio memory prime|record|search|query|status|list|show|delete|prune|suggest
 *
 * Universal memory/expertise interface that delegates to the configured backend.
 * Reads `memory.backend` from config and creates the appropriate adapter.
 *
 * Pattern follows src/commands/task.ts.
 */

import { loadConfig, resolveProjectRoot } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createMemoryClient } from "../memory/factory.ts";
import type { DomainStats, MemoryRecord } from "../memory/types.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

/** Boolean flags that do NOT consume the next arg. */
const BOOLEAN_FLAGS = new Set(["--json", "--help", "-h", "--dry-run"]);

/**
 * Extract positional arguments, skipping flag-value pairs.
 */
function getPositionalArgs(args: string[]): string[] {
	const positional: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (arg?.startsWith("-")) {
			if (BOOLEAN_FLAGS.has(arg)) {
				i += 1;
			} else {
				i += 2;
			}
		} else {
			if (arg !== undefined) {
				positional.push(arg);
			}
			i += 1;
		}
	}
	return positional;
}

/**
 * Format a MemoryRecord for human-readable output.
 */
function formatRecord(record: MemoryRecord, verbose = false): string {
	const lines: string[] = [];
	lines.push(`${record.id} [${record.domain}/${record.type}] ${record.content}`);
	if (verbose) {
		lines.push(`  Classification: ${record.classification}`);
		if (record.tags.length > 0) lines.push(`  Tags: ${record.tags.join(", ")}`);
		if (record.evidenceCommit) lines.push(`  Evidence commit: ${record.evidenceCommit}`);
		if (record.evidenceBead) lines.push(`  Evidence bead: ${record.evidenceBead}`);
		lines.push(`  Recorded: ${record.recordedAt}`);
		if (record.updatedAt) lines.push(`  Updated: ${record.updatedAt}`);
	}
	return lines.join("\n");
}

/**
 * Format DomainStats for human-readable output.
 */
function formatDomainStats(stats: DomainStats): string {
	return `${stats.name}: ${stats.recordCount} records (last updated: ${stats.lastUpdated})`;
}

const MEMORY_HELP = `legio memory — Universal memory/expertise interface

Usage: legio memory <subcommand> [args...]

Subcommands:
  prime                         Generate a priming prompt with expertise
    --domains <d1,d2,...>        Scope to specific domains
    --files <f1,f2,...>          Scope to files (infers domains)
    --budget <N>                 Max records to include
  record <domain>               Record a new expertise entry
    --type <type>                Record type (convention|pattern|failure|decision|reference|guide)
    --description <text>         Record content
    --tags <t1,t2,...>           Tags (comma-separated)
    --classification <class>     Classification (tactical|observational)
    --evidence-commit <sha>      Evidence git commit
    --evidence-bead <id>         Evidence bead/task ID
  search <query>                Full-text search across all records
  query [domain]                Query records, optionally by domain
  status                        Show domain statistics
  list                          List records with filters
    --domain <name>              Filter by domain
    --type <type>                Filter by type
    --limit <N>                  Max results
    --since <ISO>                Records after this date
  show <id>                     Show a single record
  delete <id>                   Delete a record
  prune                         Remove old/stale records
    --dry-run                    Show what would be pruned
    --older-than-days <N>        Records older than N days
    --domain <name>              Scope to a domain
  suggest                       Suggest domains for changed files
    --files <f1,f2,...>          File paths to analyze

Options:
  --json             Output as JSON
  --help, -h         Show this help

The backend is configured via memory.backend in .legio/config.yaml.
Supported backends: builtin (default), mulch.`;

/**
 * Entry point for \`legio memory <subcommand>\`.
 */
export async function memoryCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
		process.stdout.write(`${MEMORY_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);
	const json = hasFlag(subArgs, "--json");

	const projectRoot = await resolveProjectRoot(process.cwd());
	const config = await loadConfig(projectRoot);
	const client = createMemoryClient(config.memory.backend, projectRoot);

	try {
		switch (subcommand) {
			case "prime": {
				const domainsRaw = getFlag(subArgs, "--domains");
				const filesRaw = getFlag(subArgs, "--files");
				const budgetStr = getFlag(subArgs, "--budget");
				const domains = domainsRaw ? domainsRaw.split(",").map((d) => d.trim()) : undefined;
				const files = filesRaw ? filesRaw.split(",").map((f) => f.trim()) : undefined;
				const budget = budgetStr ? Number.parseInt(budgetStr, 10) : undefined;

				const output = await client.prime({ domains, files, budget });

				if (json) {
					process.stdout.write(`${JSON.stringify({ output }, null, "\t")}\n`);
				} else {
					process.stdout.write(`${output}\n`);
				}
				break;
			}

			case "record": {
				const positional = getPositionalArgs(subArgs);
				const domain = positional[0];
				if (!domain || domain.trim().length === 0) {
					throw new ValidationError(
						"Domain is required: legio memory record <domain> --type <type> --description <text>",
						{ field: "domain" },
					);
				}
				const type = getFlag(subArgs, "--type");
				if (!type) {
					throw new ValidationError(
						"--type is required (convention|pattern|failure|decision|reference|guide)",
						{ field: "type" },
					);
				}
				const description = getFlag(subArgs, "--description");
				if (!description) {
					throw new ValidationError("--description is required", {
						field: "description",
					});
				}
				const tagsRaw = getFlag(subArgs, "--tags");
				const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()) : undefined;
				const classification = getFlag(subArgs, "--classification");
				const evidenceCommit = getFlag(subArgs, "--evidence-commit");
				const evidenceBead = getFlag(subArgs, "--evidence-bead");

				const id = await client.record(domain, {
					type,
					description,
					tags,
					classification,
					evidenceCommit,
					evidenceBead,
				});

				if (json) {
					process.stdout.write(`${JSON.stringify({ id, domain, type }, null, "\t")}\n`);
				} else {
					process.stdout.write(`Recorded: ${id}\n`);
				}
				break;
			}

			case "search": {
				const positional = getPositionalArgs(subArgs);
				const query = positional[0];
				if (!query || query.trim().length === 0) {
					throw new ValidationError("Query is required: legio memory search <query>", {
						field: "query",
					});
				}

				const output = await client.search(query);

				if (json) {
					process.stdout.write(`${JSON.stringify({ output }, null, "\t")}\n`);
				} else {
					process.stdout.write(`${output}\n`);
				}
				break;
			}

			case "query": {
				const positional = getPositionalArgs(subArgs);
				const domain = positional[0];

				const output = await client.query(domain);

				if (json) {
					process.stdout.write(`${JSON.stringify({ output }, null, "\t")}\n`);
				} else {
					process.stdout.write(`${output}\n`);
				}
				break;
			}

			case "status": {
				const stats = await client.status();

				if (json) {
					process.stdout.write(`${JSON.stringify(stats, null, "\t")}\n`);
				} else if (stats.length === 0) {
					process.stdout.write("No domains found.\n");
				} else {
					for (const stat of stats) {
						process.stdout.write(`${formatDomainStats(stat)}\n`);
					}
				}
				break;
			}

			case "list": {
				const domain = getFlag(subArgs, "--domain");
				const type = getFlag(subArgs, "--type");
				const limitStr = getFlag(subArgs, "--limit");
				const since = getFlag(subArgs, "--since");
				const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;

				const records = await client.list({ domain, type, limit, since });

				if (json) {
					process.stdout.write(`${JSON.stringify(records, null, "\t")}\n`);
				} else if (records.length === 0) {
					process.stdout.write("No records found.\n");
				} else {
					for (const record of records) {
						process.stdout.write(`${formatRecord(record)}\n`);
					}
				}
				break;
			}

			case "show": {
				const positional = getPositionalArgs(subArgs);
				const id = positional[0];
				if (!id) {
					throw new ValidationError("Record ID is required: legio memory show <id>", {
						field: "id",
					});
				}

				const record = await client.show(id);

				if (json) {
					process.stdout.write(`${JSON.stringify(record, null, "\t")}\n`);
				} else {
					process.stdout.write(`${formatRecord(record, true)}\n`);
				}
				break;
			}

			case "delete": {
				const positional = getPositionalArgs(subArgs);
				const id = positional[0];
				if (!id) {
					throw new ValidationError("Record ID is required: legio memory delete <id>", {
						field: "id",
					});
				}

				await client.delete(id);

				if (json) {
					process.stdout.write(`${JSON.stringify({ id, deleted: true }, null, "\t")}\n`);
				} else {
					process.stdout.write(`Deleted: ${id}\n`);
				}
				break;
			}

			case "prune": {
				const dryRun = hasFlag(subArgs, "--dry-run");
				const olderThanDaysStr = getFlag(subArgs, "--older-than-days");
				const domain = getFlag(subArgs, "--domain");
				const olderThanDays = olderThanDaysStr ? Number.parseInt(olderThanDaysStr, 10) : undefined;

				const result = await client.prune({ dryRun, olderThanDays, domain });

				if (json) {
					process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
				} else {
					const action = result.dryRun ? "Would prune" : "Pruned";
					process.stdout.write(
						`${action} ${result.pruned} record${result.pruned === 1 ? "" : "s"}.\n`,
					);
				}
				break;
			}

			case "suggest": {
				const filesRaw = getFlag(subArgs, "--files");
				if (!filesRaw) {
					throw new ValidationError(
						"--files is required: legio memory suggest --files <f1,f2,...>",
						{ field: "files" },
					);
				}
				const files = filesRaw
					.split(",")
					.map((f) => f.trim())
					.filter((f) => f.length > 0);

				const domains = client.suggestDomains(files);

				if (json) {
					process.stdout.write(`${JSON.stringify({ files, domains }, null, "\t")}\n`);
				} else if (domains.length === 0) {
					process.stdout.write("No domains suggested for the given files.\n");
				} else {
					process.stdout.write(`Suggested domains: ${domains.join(", ")}\n`);
				}
				break;
			}

			default:
				throw new ValidationError(
					`Unknown memory subcommand: ${subcommand}. Run 'legio memory --help' for usage.`,
					{ field: "subcommand", value: subcommand },
				);
		}
	} finally {
		if (client.dispose) {
			client.dispose();
		}
	}
}
