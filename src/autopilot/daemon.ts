/**
 * Coordinator autopilot daemon.
 *
 * A mechanical daemon that automates coordinator tasks:
 * - Processes merge_ready mail → auto-enqueues and merges branches
 * - Logs error/escalation messages
 * - Optionally cleans completed worktrees
 *
 * Runs in-process with the web server, controlled via REST API.
 * Follows the watchdog daemon pattern (src/watchdog/daemon.ts).
 */

import { join } from "node:path";
import { createMailStore } from "../mail/store.ts";
import type { AutopilotAction, AutopilotConfig, AutopilotState, MailMessage } from "../types.ts";

/** Default runtime config for the autopilot. */
const DEFAULT_AUTOPILOT_CONFIG: AutopilotConfig = {
	intervalMs: 10_000,
	autoMerge: true,
	autoCleanWorktrees: false,
	maxActionsLog: 100,
};

/** Dependency injection for mail operations. */
export interface AutopilotMailDeps {
	getUnread(agent: string): MailMessage[];
	markRead(id: string): void;
}

/** Dependency injection for merge operations. */
export interface AutopilotMergeDeps {
	mergeBranch(root: string, branch: string): Promise<{ success: boolean; output: string }>;
}

/** Dependency injection for worktree operations. */
export interface AutopilotWorktreeDeps {
	cleanCompleted(root: string): Promise<void>;
}

/** All injectable dependencies for testing. */
export interface AutopilotDeps {
	_mail?: AutopilotMailDeps;
	_merge?: AutopilotMergeDeps;
	_worktree?: AutopilotWorktreeDeps;
}

/** Public interface for an autopilot instance. */
export interface AutopilotInstance {
	start(): void;
	stop(): void;
	getState(): AutopilotState;
}

/**
 * Real mail dependency: opens the mail store, fetches unread messages for the
 * given agent, then closes the store.
 */
function createRealMailDeps(root: string): AutopilotMailDeps {
	const mailDbPath = join(root, ".legio", "mail.db");
	return {
		getUnread(agent: string): MailMessage[] {
			try {
				const store = createMailStore(mailDbPath);
				try {
					return store.getUnread(agent);
				} finally {
					store.close();
				}
			} catch {
				return [];
			}
		},
		markRead(id: string): void {
			try {
				const store = createMailStore(mailDbPath);
				try {
					store.markRead(id);
				} finally {
					store.close();
				}
			} catch {
				// Non-fatal — mail may not exist
			}
		},
	};
}

/**
 * Run `legio merge --branch <branch>` as a subprocess.
 */
async function realMergeBranch(
	root: string,
	branch: string,
): Promise<{ success: boolean; output: string }> {
	const proc = Bun.spawn(["legio", "merge", "--branch", branch], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return {
		success: exitCode === 0,
		output: (stdout + stderr).trim(),
	};
}

/**
 * Run `legio worktree clean --completed` as a subprocess.
 */
async function realCleanCompleted(root: string): Promise<void> {
	const proc = Bun.spawn(["legio", "worktree", "clean", "--completed"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
}

/**
 * Extract branch name from a merge_ready mail message.
 * Tries payload JSON first, then falls back to subject line parsing.
 */
function extractBranchFromMessage(message: MailMessage): string | null {
	// Try payload first (MergeReadyPayload)
	if (message.payload) {
		try {
			const payload = JSON.parse(message.payload) as { branch?: string };
			if (typeof payload.branch === "string" && payload.branch) {
				return payload.branch;
			}
		} catch {
			// Fall through to subject parsing
		}
	}

	// Try subject: "Branch ready: <branch>" or "merge_ready: <branch>"
	const subjectMatch = /branch[:\s]+([^\s]+)/i.exec(message.subject);
	if (subjectMatch?.[1]) {
		return subjectMatch[1];
	}

	// Try body: look for a line containing a branch-like path
	const bodyMatch = /legio\/[^\s]+/i.exec(message.body);
	if (bodyMatch?.[0]) {
		return bodyMatch[0];
	}

	return null;
}

/**
 * Run a single autopilot tick.
 *
 * Fetches unread mail for coordinator/orchestrator, processes each message
 * by type, and returns the list of actions taken.
 *
 * @param root - Project root directory
 * @param state - Current autopilot state (read for config values)
 * @param deps - Optional dependency injection for testing
 * @returns Array of actions taken in this tick
 */
export async function runAutopilotTick(
	root: string,
	state: AutopilotState,
	deps?: AutopilotDeps,
): Promise<AutopilotAction[]> {
	const actions: AutopilotAction[] = [];
	const { autoMerge, autoCleanWorktrees } = state.config;

	const mail = deps?._mail ?? createRealMailDeps(root);
	const merge = deps?._merge ?? {
		mergeBranch: realMergeBranch,
	};
	const worktree = deps?._worktree ?? {
		cleanCompleted: realCleanCompleted,
	};

	// Collect unread messages for both coordinator and orchestrator aliases
	const coordinatorMail = mail.getUnread("coordinator");
	const orchestratorMail = mail.getUnread("orchestrator");

	// Deduplicate by message ID (in case the same message appears for both)
	const seen = new Set<string>();
	const messages: MailMessage[] = [];
	for (const msg of [...coordinatorMail, ...orchestratorMail]) {
		if (!seen.has(msg.id)) {
			seen.add(msg.id);
			messages.push(msg);
		}
	}

	for (const message of messages) {
		if (message.type === "merge_ready") {
			const branch = extractBranchFromMessage(message);

			if (autoMerge && branch) {
				try {
					const result = await merge.mergeBranch(root, branch);
					actions.push({
						timestamp: new Date().toISOString(),
						type: "merge",
						details: result.success
							? `Merged branch: ${branch}`
							: `Merge failed for branch: ${branch} — ${result.output}`,
					});
				} catch (err) {
					actions.push({
						timestamp: new Date().toISOString(),
						type: "error",
						details: `Error merging branch ${branch ?? "unknown"}: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
			} else {
				actions.push({
					timestamp: new Date().toISOString(),
					type: "mail_processed",
					details: `merge_ready received (branch: ${branch ?? "unknown"}, autoMerge: ${String(autoMerge)})`,
				});
			}

			mail.markRead(message.id);
		} else if (message.type === "error" || message.type === "escalation") {
			actions.push({
				timestamp: new Date().toISOString(),
				type: "mail_processed",
				details: `${message.type} from ${message.from}: ${message.subject}`,
			});
			mail.markRead(message.id);
		} else {
			// Mark all other unread messages as read — no action taken
			mail.markRead(message.id);
		}
	}

	// Optionally clean completed worktrees
	if (autoCleanWorktrees) {
		try {
			await worktree.cleanCompleted(root);
			actions.push({
				timestamp: new Date().toISOString(),
				type: "worktree_cleaned",
				details: "Cleaned completed worktrees",
			});
		} catch (err) {
			actions.push({
				timestamp: new Date().toISOString(),
				type: "error",
				details: `Error cleaning worktrees: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	return actions;
}

/**
 * Create an autopilot instance.
 *
 * The autopilot is initially stopped. Call `start()` to begin the daemon loop.
 *
 * @param root - Project root directory
 * @param config - Optional config overrides (merged with defaults)
 * @param deps - Optional dependency injection for testing
 */
export function createAutopilot(
	root: string,
	config?: Partial<AutopilotConfig>,
	deps?: AutopilotDeps,
): AutopilotInstance {
	const resolvedConfig: AutopilotConfig = {
		...DEFAULT_AUTOPILOT_CONFIG,
		...config,
	};

	const state: AutopilotState = {
		running: false,
		startedAt: null,
		stoppedAt: null,
		lastTick: null,
		tickCount: 0,
		actions: [],
		config: resolvedConfig,
	};

	let interval: ReturnType<typeof setInterval> | null = null;

	function runTick(): void {
		runAutopilotTick(root, state, deps)
			.then((actions) => {
				state.lastTick = new Date().toISOString();
				state.tickCount++;
				// Prepend new actions (most recent first)
				state.actions = [...actions, ...state.actions].slice(0, state.config.maxActionsLog);
			})
			.catch(() => {
				// Swallow errors — daemon must not crash
			});
	}

	return {
		start(): void {
			if (state.running) return;
			state.running = true;
			state.startedAt = new Date().toISOString();
			state.stoppedAt = null;

			// Run first tick immediately, then on interval
			runTick();
			interval = setInterval(runTick, resolvedConfig.intervalMs);
		},

		stop(): void {
			if (!state.running) return;
			state.running = false;
			state.stoppedAt = new Date().toISOString();
			if (interval !== null) {
				clearInterval(interval);
				interval = null;
			}
		},

		getState(): AutopilotState {
			// Return a snapshot (shallow copy) to prevent external mutation
			return {
				...state,
				actions: [...state.actions],
				config: { ...state.config },
			};
		},
	};
}
