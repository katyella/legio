/**
 * CLI command: legio group create|status|add|remove|list
 *
 * Manages TaskGroups for batch work coordination. Groups track collections
 * of beads issues and auto-close when all member issues are closed.
 *
 * Storage: `.legio/groups.json` (array of TaskGroup objects).
 */

import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GroupError, ValidationError } from "../errors.ts";
import type { TaskGroup, TaskGroupProgress } from "../types.ts";

/** Boolean flags that do NOT consume the next arg. */
const BOOLEAN_FLAGS = new Set(["--json", "--help", "-h"]);

/**
 * Check if a file exists using access().
 */
async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

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
 * Resolve the groups.json path from the project root.
 */
function groupsPath(projectRoot: string): string {
	return join(projectRoot, ".legio", "groups.json");
}

/**
 * Load groups from .legio/groups.json.
 */
export async function loadGroups(projectRoot: string): Promise<TaskGroup[]> {
	const path = groupsPath(projectRoot);
	if (!(await fileExists(path))) {
		return [];
	}
	try {
		const text = await readFile(path, "utf-8");
		return JSON.parse(text) as TaskGroup[];
	} catch {
		return [];
	}
}

/**
 * Save groups to .legio/groups.json.
 */
async function saveGroups(projectRoot: string, groups: TaskGroup[]): Promise<void> {
	const path = groupsPath(projectRoot);
	await writeFile(path, `${JSON.stringify(groups, null, "\t")}\n`);
}

/**
 * Query a beads issue status via `bd show <id> --json`.
 * Returns the status string, or null if the issue cannot be found.
 */
async function getIssueStatus(id: string): Promise<string | null> {
	try {
		const { stdout, exitCode } = await new Promise<{ stdout: string; exitCode: number }>(
			(resolve) => {
				const proc = spawn("bd", ["show", id, "--json"], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				const stdoutChunks: Buffer[] = [];
				proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
				proc.on("close", (code) => {
					resolve({
						stdout: Buffer.concat(stdoutChunks).toString(),
						exitCode: code ?? 1,
					});
				});
			},
		);
		if (exitCode !== 0) {
			return null;
		}
		// bd show --json returns an array with a single element
		const arr = JSON.parse(stdout) as { status?: string }[];
		const data = arr[0];
		if (!data) {
			return null;
		}
		return data.status ?? null;
	} catch {
		return null;
	}
}

/**
 * Validate that a beads issue exists.
 */
async function validateIssueExists(id: string): Promise<void> {
	const status = await getIssueStatus(id);
	if (status === null) {
		throw new GroupError(`Issue "${id}" not found in beads`, { groupId: id });
	}
}

/**
 * Generate a group ID.
 */
function generateGroupId(): string {
	return `group-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Create a new task group.
 */
async function createGroup(
	projectRoot: string,
	name: string,
	issueIds: string[],
	skipValidation = false,
): Promise<TaskGroup> {
	if (!name || name.trim().length === 0) {
		throw new ValidationError("Group name is required", { field: "name" });
	}
	if (issueIds.length === 0) {
		throw new ValidationError("At least one issue ID is required", { field: "issueIds" });
	}

	// Validate all issues exist
	if (!skipValidation) {
		for (const id of issueIds) {
			await validateIssueExists(id);
		}
	}

	// Check for duplicate issue IDs in the input
	const unique = new Set(issueIds);
	if (unique.size !== issueIds.length) {
		throw new ValidationError("Duplicate issue IDs provided", { field: "issueIds" });
	}

	const groups = await loadGroups(projectRoot);
	const group: TaskGroup = {
		id: generateGroupId(),
		name: name.trim(),
		memberIssueIds: issueIds,
		status: "active",
		createdAt: new Date().toISOString(),
		completedAt: null,
	};
	groups.push(group);
	await saveGroups(projectRoot, groups);
	return group;
}

/**
 * Add issues to an existing group.
 */
async function addToGroup(
	projectRoot: string,
	groupId: string,
	issueIds: string[],
	skipValidation = false,
): Promise<TaskGroup> {
	if (issueIds.length === 0) {
		throw new ValidationError("At least one issue ID is required", { field: "issueIds" });
	}

	const groups = await loadGroups(projectRoot);
	const group = groups.find((g) => g.id === groupId);
	if (!group) {
		throw new GroupError(`Group "${groupId}" not found`, { groupId });
	}

	// Check for duplicates against existing members
	for (const id of issueIds) {
		if (group.memberIssueIds.includes(id)) {
			throw new GroupError(`Issue "${id}" is already a member of group "${groupId}"`, {
				groupId,
			});
		}
	}

	// Validate issues exist
	if (!skipValidation) {
		for (const id of issueIds) {
			await validateIssueExists(id);
		}
	}

	group.memberIssueIds.push(...issueIds);

	// If group was completed, reopen it
	if (group.status === "completed") {
		group.status = "active";
		group.completedAt = null;
	}

	await saveGroups(projectRoot, groups);
	return group;
}

/**
 * Remove issues from an existing group.
 */
async function removeFromGroup(
	projectRoot: string,
	groupId: string,
	issueIds: string[],
): Promise<TaskGroup> {
	if (issueIds.length === 0) {
		throw new ValidationError("At least one issue ID is required", { field: "issueIds" });
	}

	const groups = await loadGroups(projectRoot);
	const group = groups.find((g) => g.id === groupId);
	if (!group) {
		throw new GroupError(`Group "${groupId}" not found`, { groupId });
	}

	// Validate all issues are members
	for (const id of issueIds) {
		if (!group.memberIssueIds.includes(id)) {
			throw new GroupError(`Issue "${id}" is not a member of group "${groupId}"`, {
				groupId,
			});
		}
	}

	// Check that removal won't empty the group
	const remaining = group.memberIssueIds.filter((id) => !issueIds.includes(id));
	if (remaining.length === 0) {
		throw new GroupError("Cannot remove all issues from a group", { groupId });
	}

	group.memberIssueIds = remaining;
	await saveGroups(projectRoot, groups);
	return group;
}

/**
 * Get progress for a single group. Queries beads for member issue statuses.
 * Auto-closes the group if all members are closed.
 */
async function getGroupProgress(
	projectRoot: string,
	group: TaskGroup,
	groups: TaskGroup[],
): Promise<TaskGroupProgress> {
	let completed = 0;
	let inProgress = 0;
	let blocked = 0;
	let open = 0;

	for (const id of group.memberIssueIds) {
		const status = await getIssueStatus(id);
		switch (status) {
			case "closed":
				completed++;
				break;
			case "in_progress":
				inProgress++;
				break;
			case "blocked":
				blocked++;
				break;
			default:
				open++;
				break;
		}
	}

	const total = group.memberIssueIds.length;

	// Auto-close: if all members are closed and group is still active
	if (completed === total && total > 0 && group.status === "active") {
		group.status = "completed";
		group.completedAt = new Date().toISOString();
		await saveGroups(projectRoot, groups);
		process.stdout.write(`Group "${group.name}" (${group.id}) auto-closed: all issues done\n`);

		// Notify coordinator via mail (best-effort)
		try {
			const mailDbPath = join(projectRoot, ".legio", "mail.db");
			if (await fileExists(mailDbPath)) {
				const { createMailStore } = await import("../mail/store.ts");
				const mailStore = createMailStore(mailDbPath);
				try {
					mailStore.insert({
						id: "",
						from: "system",
						to: "coordinator",
						subject: `Group auto-closed: ${group.name}`,
						body: `Task group ${group.id} ("${group.name}") completed. All ${total} member issues are closed.`,
						type: "status",
						priority: "normal",
						threadId: null,
					});
				} finally {
					mailStore.close();
				}
			}
		} catch {
			// Non-fatal: mail notification is best-effort
		}
	}

	return { group, total, completed, inProgress, blocked, open };
}

/**
 * Print a group's progress in human-readable format.
 */
function printGroupProgress(progress: TaskGroupProgress): void {
	const w = process.stdout.write.bind(process.stdout);
	const { group, total, completed, inProgress, blocked, open } = progress;
	const status = group.status === "completed" ? "[completed]" : "[active]";
	w(`${group.name} (${group.id}) ${status}\n`);
	w(`  Issues: ${total} total`);
	w(` | ${completed} completed`);
	w(` | ${inProgress} in_progress`);
	w(` | ${blocked} blocked`);
	w(` | ${open} open\n`);
	if (group.status === "completed" && group.completedAt) {
		w(`  Completed: ${group.completedAt}\n`);
	}
}

const GROUP_HELP = `legio group -- Manage task groups for batch coordination

Usage: legio group <subcommand> [args...]

Subcommands:
  create '<name>' <id1> [id2...]   Create a new task group
  status [group-id]                Show progress for one or all groups
  add <group-id> <id1> [id2...]    Add issues to a group
  remove <group-id> <id1> [id2...]  Remove issues from a group
  list                             List all groups (summary)

Options:
  --json             Output as JSON
  --skip-validation  Skip beads issue validation (for offline use)
  --help, -h         Show this help`;

/**
 * Entry point for `legio group <subcommand>`.
 */
export async function groupCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${GROUP_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);
	const json = subArgs.includes("--json");
	const skipValidation = subArgs.includes("--skip-validation");

	const { resolveProjectRoot } = await import("../config.ts");
	const projectRoot = await resolveProjectRoot(process.cwd());

	switch (subcommand) {
		case "create": {
			const positional = getPositionalArgs(subArgs);
			const name = positional[0];
			if (!name || name.trim().length === 0) {
				throw new ValidationError(
					"Group name is required: legio group create '<name>' <id1> [id2...]",
					{ field: "name" },
				);
			}
			const issueIds = positional.slice(1);
			if (issueIds.length === 0) {
				throw new ValidationError(
					"At least one issue ID is required: legio group create '<name>' <id1> [id2...]",
					{ field: "issueIds" },
				);
			}
			const group = await createGroup(projectRoot, name, issueIds, skipValidation);
			if (json) {
				process.stdout.write(`${JSON.stringify(group, null, "\t")}\n`);
			} else {
				process.stdout.write(`Created group "${group.name}" (${group.id})\n`);
				process.stdout.write(`  Members: ${group.memberIssueIds.join(", ")}\n`);
			}
			break;
		}

		case "status": {
			const positional = getPositionalArgs(subArgs);
			const groupId = positional[0];
			const groups = await loadGroups(projectRoot);

			if (groupId) {
				const group = groups.find((g) => g.id === groupId);
				if (!group) {
					throw new GroupError(`Group "${groupId}" not found`, { groupId });
				}
				const progress = await getGroupProgress(projectRoot, group, groups);
				if (json) {
					process.stdout.write(`${JSON.stringify(progress, null, "\t")}\n`);
				} else {
					printGroupProgress(progress);
				}
			} else {
				const activeGroups = groups.filter((g) => g.status === "active");
				if (activeGroups.length === 0) {
					if (json) {
						process.stdout.write("[]\n");
					} else {
						process.stdout.write("No active groups\n");
					}
					break;
				}
				const progressList: TaskGroupProgress[] = [];
				for (const group of activeGroups) {
					const progress = await getGroupProgress(projectRoot, group, groups);
					progressList.push(progress);
				}
				if (json) {
					process.stdout.write(`${JSON.stringify(progressList, null, "\t")}\n`);
				} else {
					for (const progress of progressList) {
						printGroupProgress(progress);
						process.stdout.write("\n");
					}
				}
			}
			break;
		}

		case "add": {
			const positional = getPositionalArgs(subArgs);
			const groupId = positional[0];
			if (!groupId || groupId.trim().length === 0) {
				throw new ValidationError(
					"Group ID is required: legio group add <group-id> <id1> [id2...]",
					{ field: "groupId" },
				);
			}
			const issueIds = positional.slice(1);
			if (issueIds.length === 0) {
				throw new ValidationError(
					"At least one issue ID is required: legio group add <group-id> <id1> [id2...]",
					{ field: "issueIds" },
				);
			}
			const group = await addToGroup(projectRoot, groupId, issueIds, skipValidation);
			if (json) {
				process.stdout.write(`${JSON.stringify(group, null, "\t")}\n`);
			} else {
				process.stdout.write(`Added ${issueIds.length} issue(s) to "${group.name}"\n`);
				process.stdout.write(`  Members: ${group.memberIssueIds.join(", ")}\n`);
			}
			break;
		}

		case "remove": {
			const positional = getPositionalArgs(subArgs);
			const groupId = positional[0];
			if (!groupId || groupId.trim().length === 0) {
				throw new ValidationError(
					"Group ID is required: legio group remove <group-id> <id1> [id2...]",
					{ field: "groupId" },
				);
			}
			const issueIds = positional.slice(1);
			if (issueIds.length === 0) {
				throw new ValidationError(
					"At least one issue ID is required: legio group remove <group-id> <id1> [id2...]",
					{ field: "issueIds" },
				);
			}
			const group = await removeFromGroup(projectRoot, groupId, issueIds);
			if (json) {
				process.stdout.write(`${JSON.stringify(group, null, "\t")}\n`);
			} else {
				process.stdout.write(`Removed ${issueIds.length} issue(s) from "${group.name}"\n`);
				process.stdout.write(`  Members: ${group.memberIssueIds.join(", ")}\n`);
			}
			break;
		}

		case "list": {
			const groups = await loadGroups(projectRoot);
			if (groups.length === 0) {
				if (json) {
					process.stdout.write("[]\n");
				} else {
					process.stdout.write("No groups\n");
				}
				break;
			}
			if (json) {
				process.stdout.write(`${JSON.stringify(groups, null, "\t")}\n`);
			} else {
				for (const group of groups) {
					const status = group.status === "completed" ? "[completed]" : "[active]";
					process.stdout.write(
						`${group.id} ${status} "${group.name}" (${group.memberIssueIds.length} issues)\n`,
					);
				}
			}
			break;
		}

		default:
			throw new ValidationError(
				`Unknown group subcommand: ${subcommand}. Run 'legio group --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
