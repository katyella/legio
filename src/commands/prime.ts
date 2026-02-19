/**
 * `legio prime` command.
 *
 * Loads context for the orchestrator or a specific agent and outputs it
 * to stdout for injection into Claude Code's context via hooks.
 *
 * Called by the SessionStart hook.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCheckpoint } from "../agents/checkpoint.ts";
import { loadIdentity } from "../agents/identity.ts";
import { createManifestLoader } from "../agents/manifest.ts";
import { loadConfig } from "../config.ts";
import { AgentError } from "../errors.ts";
import { createMetricsStore } from "../metrics/store.ts";
import { createMulchClient } from "../mulch/client.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentIdentity, AgentManifest, SessionCheckpoint, SessionMetrics } from "../types.ts";
import { getCurrentSessionName } from "../worktree/tmux.ts";

/**
 * Gitignore content for .legio/.gitignore.
 * TODO: Import from init.ts once it's exported (parallel branch change).
 * Wildcard+whitelist pattern: ignore everything except tracked config files.
 */
const OVERSTORY_GITIGNORE = `# Wildcard+whitelist: ignore everything, whitelist tracked files
# Auto-healed by legio prime on each session start
*
!.gitignore
!config.yaml
!agent-manifest.json
!hooks.json
!groups.json
!agent-defs/
`;

/**
 * Parse CLI flags from the args array.
 *
 * Supports:
 * - `--agent <name>` — Prime for a specific agent
 * - `--compact` — Output reduced context
 */
function parseArgs(args: string[]): { agentName: string | null; compact: boolean } {
	let agentName: string | null = null;
	let compact = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--agent") {
			const next = args[i + 1];
			if (next === undefined || next.startsWith("--")) {
				throw new AgentError("--agent requires a name argument");
			}
			agentName = next;
			i++; // Skip the value
		} else if (arg === "--compact") {
			compact = true;
		}
	}

	return { agentName, compact };
}

/**
 * Format the agent manifest section for output.
 */
function formatManifest(manifest: AgentManifest): string {
	const lines: string[] = [];
	for (const [name, def] of Object.entries(manifest.agents)) {
		const caps = def.capabilities.join(", ");
		const spawn = def.canSpawn ? " (can spawn)" : "";
		lines.push(`- **${name}** [${def.model}]: ${caps}${spawn}`);
	}
	return lines.length > 0 ? lines.join("\n") : "No agents registered.";
}

/**
 * Format recent session metrics for output.
 */
function formatMetrics(sessions: SessionMetrics[]): string {
	if (sessions.length === 0) {
		return "No recent sessions.";
	}

	const lines: string[] = [];
	for (const s of sessions) {
		const status = s.completedAt !== null ? "completed" : "in-progress";
		const duration = s.durationMs > 0 ? ` (${Math.round(s.durationMs / 1000)}s)` : "";
		const merge = s.mergeResult !== null ? ` [${s.mergeResult}]` : "";
		lines.push(`- ${s.agentName} (${s.capability}): ${s.beadId} — ${status}${duration}${merge}`);
	}
	return lines.join("\n");
}

/**
 * Format agent identity for output.
 */
function formatIdentity(identity: AgentIdentity): string {
	const lines: string[] = [];
	lines.push(`Name: ${identity.name}`);
	lines.push(`Capability: ${identity.capability}`);
	lines.push(`Sessions completed: ${identity.sessionsCompleted}`);

	if (identity.expertiseDomains.length > 0) {
		lines.push(`Expertise: ${identity.expertiseDomains.join(", ")}`);
	}

	if (identity.recentTasks.length > 0) {
		lines.push("Recent tasks:");
		for (const task of identity.recentTasks) {
			lines.push(`  - ${task.beadId}: ${task.summary} (${task.completedAt})`);
		}
	}

	return lines.join("\n");
}

/**
 * Format checkpoint recovery section for compact priming.
 */
function formatCheckpointRecovery(checkpoint: SessionCheckpoint): string {
	const lines: string[] = [];
	lines.push("\n## Session Recovery");
	lines.push("");
	lines.push("You are resuming from a previous session that was compacted.");
	lines.push("");
	lines.push(`**Progress so far:** ${checkpoint.progressSummary}`);
	lines.push(`**Files modified:** ${checkpoint.filesModified.join(", ") || "none"}`);
	lines.push(`**Pending work:** ${checkpoint.pendingWork}`);
	lines.push(`**Branch:** ${checkpoint.currentBranch}`);
	return lines.join("\n");
}

/**
 * Auto-heal .legio/.gitignore if its content differs from the template.
 * Ensures existing projects get updated gitignore on session start.
 */
async function healGitignore(legioDir: string): Promise<void> {
	const gitignorePath = join(legioDir, ".gitignore");
	try {
		const current = await readFile(gitignorePath, "utf-8");
		if (current === OVERSTORY_GITIGNORE) {
			return; // Already up to date
		}
	} catch {
		// File does not exist — write it fresh
	}
	await writeFile(gitignorePath, OVERSTORY_GITIGNORE);
}

/**
 * Prime command entry point.
 *
 * Gathers project state and outputs context to stdout for injection
 * into Claude Code's context.
 *
 * @param args - CLI arguments after "prime" subcommand
 */
const PRIME_HELP = `legio prime — Load context for orchestrator/agent

Usage: legio prime [--agent <name>] [--compact]

Options:
  --agent <name>   Prime for a specific agent (default: orchestrator)
  --compact        Output reduced context (for PreCompact hook)
  --help, -h       Show this help`;

export async function primeCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${PRIME_HELP}\n`);
		return;
	}

	const { agentName, compact } = parseArgs(args);

	// 1. Load config
	const config = await loadConfig(process.cwd());

	// 2. Auto-heal .legio/.gitignore
	const legioDir = join(config.project.root, ".legio");
	await healGitignore(legioDir);

	// 3. Load mulch expertise (optional — skip on failure)
	let expertiseOutput: string | null = null;
	if (!compact && config.mulch.enabled) {
		try {
			const mulch = createMulchClient(config.project.root);
			const domains = config.mulch.domains.length > 0 ? config.mulch.domains : undefined;
			expertiseOutput = await mulch.prime(domains, config.mulch.primeFormat);
		} catch {
			// Mulch is optional — silently skip if it fails
		}
	}

	// 4. Output context (orchestrator or agent)
	if (agentName !== null) {
		// === Agent priming ===
		await outputAgentContext(config, agentName, compact, expertiseOutput);
	} else {
		// === Orchestrator priming ===
		await outputOrchestratorContext(config, compact, expertiseOutput);
	}
}

/**
 * Output context for a specific agent.
 */
async function outputAgentContext(
	config: Awaited<ReturnType<typeof loadConfig>>,
	agentName: string,
	compact: boolean,
	expertiseOutput: string | null,
): Promise<void> {
	const sections: string[] = [];

	sections.push(`# Agent Context: ${agentName}`);

	// Check if the agent exists in the SessionStore or has an identity file
	const legioDir = join(config.project.root, ".legio");
	const { store } = openSessionStore(legioDir);
	let sessionExists = false;
	let boundSession: { beadId: string } | null = null;
	try {
		const agentSession = store.getByName(agentName);
		sessionExists = agentSession !== null;
		if (
			agentSession &&
			agentSession.state !== "completed" &&
			agentSession.state !== "zombie" &&
			agentSession.beadId
		) {
			boundSession = { beadId: agentSession.beadId };
		}
	} finally {
		store.close();
	}

	// Identity section
	let identity: AgentIdentity | null = null;
	try {
		const baseDir = join(config.project.root, ".legio", "agents");
		identity = await loadIdentity(baseDir, agentName);
	} catch {
		// Identity may not exist yet
	}

	// Warn if agent is completely unknown (no session and no identity)
	if (!sessionExists && identity === null) {
		process.stderr.write(
			`Warning: agent "${agentName}" not found in sessions or identity store.\n`,
		);
	}

	sections.push("\n## Identity");
	if (identity !== null) {
		sections.push(formatIdentity(identity));
	} else {
		sections.push("New agent - no prior sessions");
	}

	// Activation context: if agent has a bound task, inject it
	if (boundSession) {
		sections.push("\n## Activation");
		sections.push(`You have a bound task: **${boundSession.beadId}**`);
		sections.push("Read your overlay at `.claude/CLAUDE.md` and begin working immediately.");
		sections.push("Do not wait for dispatch mail. Your assignment was bound at spawn time.");
	}

	// In compact mode, check for checkpoint recovery
	if (compact) {
		const baseDir = join(config.project.root, ".legio", "agents");
		const checkpoint = await loadCheckpoint(baseDir, agentName);
		if (checkpoint !== null) {
			sections.push(formatCheckpointRecovery(checkpoint));
		}
	}

	// In compact mode, skip expertise
	if (!compact && expertiseOutput !== null) {
		sections.push("\n## Expertise");
		sections.push(expertiseOutput.trim());
	}

	process.stdout.write(`${sections.join("\n")}\n`);
}

/**
 * Output context for the orchestrator.
 */
async function outputOrchestratorContext(
	config: Awaited<ReturnType<typeof loadConfig>>,
	compact: boolean,
	expertiseOutput: string | null,
): Promise<void> {
	// Register orchestrator tmux session for reverse-nudge (agents → orchestrator)
	try {
		const tmuxSession = await getCurrentSessionName();
		if (tmuxSession) {
			const regPath = join(config.project.root, ".legio", "orchestrator-tmux.json");
			await writeFile(
				regPath,
				`${JSON.stringify({ tmuxSession, registeredAt: new Date().toISOString() }, null, "\t")}\n`,
			);
		}
	} catch {
		// Tmux detection is optional — silently skip
	}

	// Record the orchestrator's current branch for merge targeting
	let sessionBranch: string | null = null;
	try {
		const branch = await new Promise<string>((res) => {
			let out = "";
			const p = spawn("git", ["symbolic-ref", "--short", "HEAD"], {
				cwd: config.project.root,
				stdio: ["ignore", "pipe", "ignore"],
			});
			p.stdout.on("data", (d: Buffer) => {
				out += d.toString();
			});
			p.on("close", () => res(out.trim()));
			p.on("error", () => res(""));
		});
		if (branch) {
			sessionBranch = branch;
			const sessionBranchPath = join(config.project.root, ".legio", "session-branch.txt");
			await writeFile(sessionBranchPath, `${branch}\n`);
		}
	} catch {
		// Branch detection is optional — silently skip
	}

	const sections: string[] = [];

	// Project section
	sections.push("# Legio Context");
	sections.push(`\n## Project: ${config.project.name}`);
	sections.push(`Canonical branch: ${config.project.canonicalBranch}`);
	if (sessionBranch && sessionBranch !== config.project.canonicalBranch) {
		sections.push(`Session branch: ${sessionBranch} (merge target)`);
	}
	sections.push(`Max concurrent agents: ${config.agents.maxConcurrent}`);
	sections.push(`Max depth: ${config.agents.maxDepth}`);

	// Agent manifest section
	sections.push("\n## Agent Manifest");
	try {
		const manifestPath = join(config.project.root, config.agents.manifestPath);
		const baseDir = join(config.project.root, config.agents.baseDir);
		const loader = createManifestLoader(manifestPath, baseDir);
		const manifest = await loader.load();
		sections.push(formatManifest(manifest));
	} catch {
		sections.push("No agent manifest found.");
	}

	// In compact mode, skip metrics and expertise
	if (!compact) {
		// Recent activity section
		sections.push("\n## Recent Activity");
		try {
			const metricsPath = join(config.project.root, ".legio", "metrics.db");
			const store = createMetricsStore(metricsPath);
			try {
				const sessions = store.getRecentSessions(5);
				sections.push(formatMetrics(sessions));
			} finally {
				store.close();
			}
		} catch {
			sections.push("No metrics available.");
		}

		// Expertise section
		if (expertiseOutput !== null) {
			sections.push("\n## Expertise");
			sections.push(expertiseOutput.trim());
		}
	}

	process.stdout.write(`${sections.join("\n")}\n`);
}
