/**
 * CLI command: legio worktree list | clean [--completed] [--all]
 *
 * List shows worktrees with agent status.
 * Clean removes worktree dirs, branch refs (if merged), and tmux sessions.
 * Logs are never auto-deleted.
 */

import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { ValidationError } from "../errors.ts";
import { createMailStore } from "../mail/store.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import { listWorktrees, removeWorktree } from "../worktree/manager.ts";
import { isSessionAlive, killSession } from "../worktree/tmux.ts";
import { access } from "node:fs/promises";


function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

/**
 * Handle `legio worktree list`.
 */
async function handleList(root: string, json: boolean): Promise<void> {
	const worktrees = await listWorktrees(root);
	const legioDir = join(root, ".legio");
	const { store } = openSessionStore(legioDir);
	let sessions: AgentSession[];
	try {
		sessions = store.getAll();
	} finally {
		store.close();
	}

	const legioWts = worktrees.filter((wt) => wt.branch.startsWith("legio/"));

	if (json) {
		const entries = legioWts.map((wt) => {
			const session = sessions.find((s) => s.worktreePath === wt.path);
			return {
				path: wt.path,
				branch: wt.branch,
				head: wt.head,
				agentName: session?.agentName ?? null,
				state: session?.state ?? null,
				beadId: session?.beadId ?? null,
			};
		});
		process.stdout.write(`${JSON.stringify(entries, null, "\t")}\n`);
		return;
	}

	if (legioWts.length === 0) {
		process.stdout.write("No agent worktrees found.\n");
		return;
	}

	process.stdout.write(`🌳 Agent worktrees: ${legioWts.length}\n\n`);
	for (const wt of legioWts) {
		const session = sessions.find((s) => s.worktreePath === wt.path);
		const state = session?.state ?? "unknown";
		const agent = session?.agentName ?? "?";
		const bead = session?.beadId ?? "?";
		process.stdout.write(`  ${wt.branch}\n`);
		process.stdout.write(`    Agent: ${agent} | State: ${state} | Task: ${bead}\n`);
		process.stdout.write(`    Path: ${wt.path}\n\n`);
	}
}

/**
 * Handle `legio worktree clean [--completed] [--all]`.
 */
async function handleClean(args: string[], root: string, json: boolean): Promise<void> {
	const all = hasFlag(args, "--all");
	const completedOnly = hasFlag(args, "--completed") || !all;

	const worktrees = await listWorktrees(root);
	const legioDir = join(root, ".legio");
	const { store } = openSessionStore(legioDir);

	let sessions: AgentSession[];
	try {
		sessions = store.getAll();
	} catch {
		store.close();
		return;
	}

	const legioWts = worktrees.filter((wt) => wt.branch.startsWith("legio/"));
	const cleaned: string[] = [];
	const failed: string[] = [];

	try {
		for (const wt of legioWts) {
			const session = sessions.find((s) => s.worktreePath === wt.path);

			// If --completed (default), only clean worktrees whose agent is done/zombie
			if (completedOnly && session && session.state !== "completed" && session.state !== "zombie") {
				continue;
			}

			// If --all, clean everything
			// Kill tmux session if still alive
			if (session?.tmuxSession) {
				const alive = await isSessionAlive(session.tmuxSession);
				if (alive) {
					try {
						await killSession(session.tmuxSession);
					} catch {
						// Best effort
					}
				}
			}

			// Remove worktree and its branch.
			// Always force worktree removal since deployed .claude/ files create untracked
			// files that cause non-forced removal to fail.
			// Always force-delete the branch since we're cleaning up finished/zombie agents
			// whose branches are typically unmerged.
			try {
				await removeWorktree(root, wt.path, { force: true, forceBranch: true });
				cleaned.push(wt.branch);

				if (!json) {
					process.stdout.write(`🗑️  Removed: ${wt.branch}\n`);
				}
			} catch (err) {
				failed.push(wt.branch);
				if (!json) {
					const msg = err instanceof Error ? err.message : String(err);
					process.stderr.write(`⚠️  Failed to remove ${wt.branch}: ${msg}\n`);
				}
			}
		}

		// Purge mail for cleaned agents
		let mailPurged = 0;
		if (cleaned.length > 0) {
			const mailDbPath = join(root, ".legio", "mail.db");
			let mailDbFileExists = false;
			try { await access(mailDbPath); mailDbFileExists = true; } catch { /* not found */ }
			if (mailDbFileExists) {
				const mailStore = createMailStore(mailDbPath);
				try {
					for (const branch of cleaned) {
						const session = sessions.find((s) => s.branchName === branch);
						if (session) {
							mailPurged += mailStore.purge({ agent: session.agentName });
						}
					}
				} finally {
					mailStore.close();
				}
			}
		}

		// Mark cleaned sessions as zombie in the SessionStore
		for (const branch of cleaned) {
			const session = sessions.find((s) => s.branchName === branch);
			if (session) {
				store.updateState(session.agentName, "zombie");
			}
		}

		// Prune zombie entries whose worktree paths no longer exist on disk.
		// This prevents the session store from growing unbounded with stale entries.
		const remainingWorktrees = await listWorktrees(root);
		const worktreePaths = new Set(remainingWorktrees.map((wt) => wt.path));
		let pruneCount = 0;

		// Re-read sessions after state updates to get current zombie list
		const currentSessions = store.getAll();
		for (const session of currentSessions) {
			if (session.state === "zombie" && !worktreePaths.has(session.worktreePath)) {
				store.remove(session.agentName);
				pruneCount++;
			}
		}

		if (json) {
			process.stdout.write(
				`${JSON.stringify({ cleaned, failed, pruned: pruneCount, mailPurged })}\n`,
			);
		} else if (cleaned.length === 0 && pruneCount === 0 && failed.length === 0) {
			process.stdout.write("No worktrees to clean.\n");
		} else {
			if (cleaned.length > 0) {
				process.stdout.write(
					`\nCleaned ${cleaned.length} worktree${cleaned.length === 1 ? "" : "s"}.\n`,
				);
			}
			if (failed.length > 0) {
				process.stdout.write(
					`Failed to clean ${failed.length} worktree${failed.length === 1 ? "" : "s"}.\n`,
				);
			}
			if (mailPurged > 0) {
				process.stdout.write(
					`Purged ${mailPurged} mail message${mailPurged === 1 ? "" : "s"} from cleaned agents.\n`,
				);
			}
			if (pruneCount > 0) {
				process.stdout.write(
					`Pruned ${pruneCount} zombie session${pruneCount === 1 ? "" : "s"} from store.\n`,
				);
			}
		}
	} finally {
		store.close();
	}
}

/**
 * Entry point for `legio worktree <subcommand> [flags]`.
 *
 * Subcommands: list, clean.
 */
const WORKTREE_HELP = `legio worktree — Manage agent worktrees

Usage: legio worktree <subcommand> [flags]

Subcommands:
  list               List worktrees with agent status
  clean              Remove completed worktrees
                       [--completed]  Only finished agents (default)
                       [--all]        Force remove all

Options:
  --json             Output as JSON
  --help, -h         Show this help`;

export async function worktreeCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${WORKTREE_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);
	const jsonFlag = hasFlag(args, "--json");

	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const root = config.project.root;

	switch (subcommand) {
		case "list":
			await handleList(root, jsonFlag);
			break;
		case "clean":
			await handleClean(subArgs, root, jsonFlag);
			break;
		default:
			throw new ValidationError(
				`Unknown worktree subcommand: ${subcommand ?? "(none)"}. Use: list, clean`,
				{ field: "subcommand" },
			);
	}
}
