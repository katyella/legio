/**
 * CLI command: legio task create|list|show|ready|claim|close|sync
 *
 * Universal task interface that delegates to the configured tracker backend.
 * Reads `taskTracker.backend` from config and creates the appropriate adapter.
 */

import { loadConfig, resolveProjectRoot } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createTrackerClient } from "../tracker/factory.ts";
import type { TrackerIssue } from "../tracker/types.ts";

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getFlag(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1 || idx + 1 >= args.length) return undefined;
	return args[idx + 1];
}

/** Boolean flags that do NOT consume the next arg. */
const BOOLEAN_FLAGS = new Set(["--json", "--help", "-h", "--all"]);

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
 * Format a TrackerIssue for human-readable output.
 */
function formatIssue(issue: TrackerIssue, verbose = false): string {
	const lines: string[] = [];
	const status = issue.status === "closed" ? "[closed]" : `[${issue.status}]`;
	lines.push(`${issue.id} ${status} ${issue.title}`);
	if (verbose) {
		lines.push(`  Priority: P${issue.priority} | Type: ${issue.type}`);
		if (issue.assignee) lines.push(`  Assignee: ${issue.assignee}`);
		if (issue.description) lines.push(`  Description: ${issue.description}`);
		if (issue.blockedBy && issue.blockedBy.length > 0) {
			lines.push(`  Blocked by: ${issue.blockedBy.join(", ")}`);
		}
		if (issue.blocks && issue.blocks.length > 0) {
			lines.push(`  Blocks: ${issue.blocks.join(", ")}`);
		}
		if (issue.closeReason) lines.push(`  Close reason: ${issue.closeReason}`);
		if (issue.createdAt) lines.push(`  Created: ${issue.createdAt}`);
		if (issue.closedAt) lines.push(`  Closed: ${issue.closedAt}`);
	}
	return lines.join("\n");
}

/**
 * Map priority string (P1/P2/P3) to numeric value.
 */
function parsePriority(value: string): number {
	switch (value.toUpperCase()) {
		case "P1":
		case "1":
			return 1;
		case "P2":
		case "2":
			return 2;
		case "P3":
		case "3":
			return 3;
		default:
			throw new ValidationError(`Invalid priority: ${value}. Use P1, P2, or P3.`, {
				field: "priority",
				value,
			});
	}
}

const TASK_HELP = `legio task — Universal task interface

Usage: legio task <subcommand> [args...]

Subcommands:
  create <title>                  Create a new task
    --priority <P1|P2|P3>          Priority level (default: P2)
    --description <text>           Task description
    --type <bug|feature|task>      Task type (default: task)
  list                            List tasks
    --status <status>              Filter by status (open|in_progress|closed)
    --all                          Include closed tasks
    --limit <N>                    Max results
  show <id>                       Show task details
  ready                           List tasks ready for work
  claim <id>                      Claim a task (set to in_progress)
  close <id>                      Close a task
    --reason <text>                Close reason
  sync                            Sync tracker state

Options:
  --json             Output as JSON
  --help, -h         Show this help

The backend is configured via taskTracker.backend in .legio/config.yaml.
Supported backends: builtin (default), beads, seeds.`;

/**
 * Entry point for `legio task <subcommand>`.
 */
export async function taskCommand(args: string[]): Promise<void> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h") || args.length === 0) {
		process.stdout.write(`${TASK_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);
	const json = hasFlag(subArgs, "--json");

	const projectRoot = await resolveProjectRoot(process.cwd());
	const config = await loadConfig(projectRoot);
	const client = createTrackerClient(config.taskTracker.backend, projectRoot);

	try {
		switch (subcommand) {
			case "create": {
				const positional = getPositionalArgs(subArgs);
				const title = positional[0];
				if (!title || title.trim().length === 0) {
					throw new ValidationError("Task title is required: legio task create <title>", {
						field: "title",
					});
				}
				const priorityStr = getFlag(subArgs, "--priority");
				const description = getFlag(subArgs, "--description");
				const type = getFlag(subArgs, "--type");

				const id = await client.create(title, {
					priority: priorityStr ? parsePriority(priorityStr) : undefined,
					description,
					type,
				});

				if (json) {
					process.stdout.write(`${JSON.stringify({ id, title }, null, "\t")}\n`);
				} else {
					process.stdout.write(`Created task: ${id}\n`);
				}
				break;
			}

			case "list": {
				const status = getFlag(subArgs, "--status");
				const all = hasFlag(subArgs, "--all");
				const limitStr = getFlag(subArgs, "--limit");
				const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;

				const issues = await client.list({ status, all, limit });

				if (json) {
					process.stdout.write(`${JSON.stringify(issues, null, "\t")}\n`);
				} else if (issues.length === 0) {
					process.stdout.write("No tasks found.\n");
				} else {
					for (const issue of issues) {
						process.stdout.write(`${formatIssue(issue)}\n`);
					}
				}
				break;
			}

			case "show": {
				const positional = getPositionalArgs(subArgs);
				const id = positional[0];
				if (!id) {
					throw new ValidationError("Task ID is required: legio task show <id>", {
						field: "id",
					});
				}

				const issue = await client.show(id);

				if (json) {
					process.stdout.write(`${JSON.stringify(issue, null, "\t")}\n`);
				} else {
					process.stdout.write(`${formatIssue(issue, true)}\n`);
				}
				break;
			}

			case "ready": {
				const issues = await client.ready();

				if (json) {
					process.stdout.write(`${JSON.stringify(issues, null, "\t")}\n`);
				} else if (issues.length === 0) {
					process.stdout.write("No tasks ready for work.\n");
				} else {
					for (const issue of issues) {
						process.stdout.write(`${formatIssue(issue)}\n`);
					}
				}
				break;
			}

			case "claim": {
				const positional = getPositionalArgs(subArgs);
				const id = positional[0];
				if (!id) {
					throw new ValidationError("Task ID is required: legio task claim <id>", {
						field: "id",
					});
				}

				await client.claim(id);

				if (json) {
					process.stdout.write(`${JSON.stringify({ id, status: "in_progress" }, null, "\t")}\n`);
				} else {
					process.stdout.write(`Claimed task: ${id}\n`);
				}
				break;
			}

			case "close": {
				const positional = getPositionalArgs(subArgs);
				const id = positional[0];
				if (!id) {
					throw new ValidationError("Task ID is required: legio task close <id>", {
						field: "id",
					});
				}
				const reason = getFlag(subArgs, "--reason");

				await client.close(id, reason);

				if (json) {
					process.stdout.write(
						`${JSON.stringify({ id, status: "closed", reason: reason ?? null }, null, "\t")}\n`,
					);
				} else {
					process.stdout.write(`Closed task: ${id}\n`);
				}
				break;
			}

			case "sync": {
				await client.sync();

				if (json) {
					process.stdout.write(`${JSON.stringify({ synced: true }, null, "\t")}\n`);
				} else {
					process.stdout.write("Sync complete.\n");
				}
				break;
			}

			default:
				throw new ValidationError(
					`Unknown task subcommand: ${subcommand}. Run 'legio task --help' for usage.`,
					{ field: "subcommand", value: subcommand },
				);
		}
	} finally {
		// Dispose the client if it has a dispose method (builtin backend)
		if ("dispose" in client && typeof (client as Record<string, unknown>).dispose === "function") {
			(client as unknown as { dispose: () => void }).dispose();
		}
	}
}
