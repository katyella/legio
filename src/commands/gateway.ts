/**
 * CLI command: legio gateway start|stop|status
 *
 * Manages the persistent gateway agent lifecycle. The gateway runs
 * at the project root (NOT in a worktree), acts as a planning companion,
 * and communicates via mail.
 *
 * Unlike regular agents spawned by sling, the gateway:
 * - Has no worktree (operates on the main working tree)
 * - Has no bead assignment (it plans and advises, not implements)
 * - Has no overlay CLAUDE.md (context comes via mail + legio prime)
 * - Persists across planning sessions
 */

import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deployHooks } from "../agents/hooks-deployer.ts";
import { createIdentity, loadIdentity } from "../agents/identity.ts";
import { createManifestLoader, resolveModel } from "../agents/manifest.ts";
import { collectProviderEnv, loadConfig } from "../config.ts";
import { AgentError, ValidationError } from "../errors.ts";
import { openSessionStore } from "../sessions/compat.ts";
import type { AgentSession } from "../types.ts";
import {
	capturePaneContent,
	createSession,
	deliverBeacon,
	isSessionAlive,
	killSession,
	sendKeys,
	waitForTuiReady,
} from "../worktree/tmux.ts";

/** Default gateway agent name. */
const GATEWAY_NAME = "gateway";

/**
 * Build the tmux session name for the gateway.
 * Includes the project name to prevent cross-project collisions.
 */
function gatewayTmuxSession(projectName: string): string {
	return `legio-${projectName}-${GATEWAY_NAME}`;
}

/**
 * Check if a file exists at the given path.
 */
async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Dependency injection for testing. Uses real implementations when omitted. */
export interface GatewayDeps {
	_tmux?: {
		createSession: (
			name: string,
			cwd: string,
			command: string,
			env?: Record<string, string>,
		) => Promise<number>;
		isSessionAlive: (name: string) => Promise<boolean>;
		killSession: (name: string) => Promise<void>;
		sendKeys: (name: string, keys: string) => Promise<void>;
		capturePaneContent: (name: string) => Promise<string>;
		waitForTuiReady?: (
			sessionName: string,
			opts?: { timeout?: number; interval?: number },
		) => Promise<void>;
	};
	_sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the gateway startup beacon — the first message sent to the gateway
 * via tmux send-keys after Claude Code initializes.
 */
export function buildGatewayBeacon(isFirstRun = false): string {
	const timestamp = new Date().toISOString();
	const parts = [
		`[LEGIO] ${GATEWAY_NAME} (gateway) ${timestamp}`,
		"You are a gateway agent in the legio multi-agent orchestration system. legio is a CLI tool installed on this machine that coordinates multiple Claude Code agents via tmux, SQLite mail, and git worktrees.",
		"Depth: 0 | Role: planning companion | READONLY: No Write/Edit tool access",
		'COMMUNICATION: Use legio mail for all inter-agent messaging. Check your inbox with: legio mail check --agent gateway. Send replies via: legio mail send --to human --subject "chat" --body "..." --type status --audience human --agent gateway',
		"ISSUES: If a task tracker is configured, use legio task to create issues for work decomposition. Check legio status for current agent fleet.",
		`Startup: run legio memory prime, check mail (legio mail check --agent ${GATEWAY_NAME}), check legio status, then send a greeting to the human via legio mail send --to human --subject "chat" --body "Gateway online and ready. What would you like to work on?" --type status --audience human --agent ${GATEWAY_NAME}`,
	];
	if (isFirstRun) {
		parts.push(
			"FIRST_RUN: true — Follow the First Run workflow in your agent definition: introduce yourself via mail to human, run legio doctor --category config, then ask the human what they want to work on",
		);
	}
	return parts.join(" — ");
}

/**
 * Determine whether to auto-attach to the tmux session after starting.
 * Exported for testing.
 */
export function resolveAttach(args: string[], isTTY: boolean): boolean {
	if (args.includes("--attach")) return true;
	if (args.includes("--no-attach")) return false;
	return isTTY;
}

/**
 * Start the gateway agent.
 *
 * 1. Verify no gateway is already running
 * 2. Load config
 * 3. Deploy hooks via deployHooks(projectRoot, GATEWAY_NAME, 'gateway')
 * 4. Create identity if first run
 * 5. Resolve model — default to 'sonnet'
 * 6. Read agent def from .legio/agent-defs/gateway.md
 * 7. Build settings JSON with skipDangerousModePermissionPrompt + appendSystemPrompt
 * 8. Spawn tmux session at project root with Claude Code
 * 9. Record session: capability 'gateway', worktreePath projectRoot, depth 0, parentAgent null
 * 10. Send beacon after delay, optionally attach
 */
async function startGateway(args: string[], deps: GatewayDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? {
		createSession,
		isSessionAlive,
		killSession,
		sendKeys,
		capturePaneContent,
		waitForTuiReady,
	};
	const sleep =
		deps._sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	const json = args.includes("--json");
	const shouldAttach = resolveAttach(args, !!process.stdout.isTTY);
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;
	const tmuxSession = gatewayTmuxSession(config.project.name);

	// Check for existing gateway
	const legioDir = join(projectRoot, ".legio");
	const { store } = openSessionStore(legioDir);
	try {
		const existing = store.getByName(GATEWAY_NAME);

		if (
			existing &&
			existing.capability === "gateway" &&
			existing.state !== "completed" &&
			existing.state !== "zombie"
		) {
			const alive = await tmux.isSessionAlive(existing.tmuxSession);
			if (alive) {
				throw new AgentError(
					`Gateway is already running (tmux: ${existing.tmuxSession}, since: ${existing.startedAt})`,
					{ agentName: GATEWAY_NAME },
				);
			}
			// Session recorded but tmux is dead — mark as completed and continue
			store.updateState(GATEWAY_NAME, "completed");
		}

		// Deploy hooks to the project root so the gateway gets event logging,
		// mail check --inject, and activity tracking via the standard hook pipeline.
		await deployHooks(projectRoot, GATEWAY_NAME, "gateway");

		// Create gateway identity if first run
		const identityBaseDir = join(projectRoot, ".legio", "agents");
		await mkdir(identityBaseDir, { recursive: true });
		const existingIdentity = await loadIdentity(identityBaseDir, GATEWAY_NAME);
		if (!existingIdentity) {
			await createIdentity(identityBaseDir, {
				name: GATEWAY_NAME,
				capability: "gateway",
				created: new Date().toISOString(),
				sessionsCompleted: 0,
				expertiseDomains: config.memory.enabled ? config.memory.domains : [],
				recentTasks: [],
			});
		}

		// Resolve model from config > manifest > fallback (opus for gateway)
		const manifestLoader = createManifestLoader(
			join(projectRoot, config.agents.manifestPath),
			join(projectRoot, config.agents.baseDir),
		);
		const manifest = await manifestLoader.load();
		const model = resolveModel(config, manifest, "gateway", "opus");

		// Build settings JSON file to skip the bypass dialog and inject the
		// agent definition. Avoids --append-system-prompt's ERR_STREAM_DESTROYED
		// crash with large payloads on Claude Code v2.1.50.
		const agentDefPath = join(projectRoot, ".legio", "agent-defs", "gateway.md");
		const settings: Record<string, unknown> = { skipDangerousModePermissionPrompt: true };
		if (await fileExists(agentDefPath)) {
			settings.appendSystemPrompt = await readFile(agentDefPath, "utf-8");
		}
		const settingsPath = join(legioDir, `settings-${GATEWAY_NAME}.json`);
		await writeFile(settingsPath, JSON.stringify(settings), "utf-8");
		const claudeCmd = `claude --model ${model} --dangerously-skip-permissions --settings ${settingsPath}`;
		const pid = await tmux.createSession(tmuxSession, projectRoot, claudeCmd, {
			...collectProviderEnv(),
			LEGIO_AGENT_NAME: GATEWAY_NAME,
		});

		// Record session BEFORE sending the beacon so that hook-triggered
		// updateLastActivity() can find the entry and transition booting->working.
		const session: AgentSession = {
			id: `session-${Date.now()}-${GATEWAY_NAME}`,
			agentName: GATEWAY_NAME,
			capability: "gateway",
			worktreePath: projectRoot, // Gateway uses project root, not a worktree
			branchName: config.project.canonicalBranch, // Operates on canonical branch
			beadId: "", // No specific bead assignment
			tmuxSession,
			state: "booting",
			pid,
			parentAgent: null, // No parent
			depth: 0,
			runId: null,
			startedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			escalationLevel: 0,
			stalledSince: null,
		};

		store.upsert(session);

		// Write output BEFORE the blocking sleep+sendKeys so that callers
		// reading stdout (e.g., runLegio in the server) get the response
		// immediately and don't hang waiting for the pipe to close.
		const output = {
			agentName: GATEWAY_NAME,
			capability: "gateway",
			tmuxSession,
			projectRoot,
			pid,
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(output)}\n`);
		} else {
			process.stdout.write("Gateway started\n");
			process.stdout.write(`  Tmux:    ${tmuxSession}\n`);
			process.stdout.write(`  Root:    ${projectRoot}\n`);
			process.stdout.write(`  PID:     ${pid}\n`);
		}

		// Send beacon after TUI initialization.
		// Wait for Claude Code's TUI to render before sending beacon.
		// Falls back to sleep(3_000) when waitForTuiReady is not in the DI mock.
		const isFirstRun = !existingIdentity;
		if (tmux.waitForTuiReady) {
			await tmux.waitForTuiReady(tmuxSession);
		} else {
			await sleep(3_000);
		}
		const beacon = buildGatewayBeacon(isFirstRun);

		// Deliver beacon using pane-content-based verification (sling-style).
		// Sends beacon text + Enter, checks pane content for agent activity,
		// and retries if the beacon is stuck in paste preview or input area.
		const confirmed = await deliverBeacon({
			sessionName: tmuxSession,
			beacon,
			agentName: GATEWAY_NAME,
			sendKeysFn: tmux.sendKeys,
			capturePane: tmux.capturePaneContent,
			sleep,
		});

		// Send greeting mail to human only after confirmed beacon delivery
		if (confirmed) {
			const { createMailStore } = await import("../mail/store.ts");
			const mailDb = createMailStore(join(legioDir, "mail.db"));
			try {
				mailDb.insert({
					id: "",
					from: GATEWAY_NAME,
					to: "human",
					subject: "Gateway online",
					body: "Gateway starting up.",
					type: "status",
					priority: "normal",
					threadId: null,
					audience: "human",
				});
			} finally {
				mailDb.close();
			}
		}

		if (shouldAttach) {
			spawnSync("tmux", ["attach-session", "-t", tmuxSession], {
				stdio: ["inherit", "inherit", "inherit"],
			});
		}
	} finally {
		store.close();
	}
}

/**
 * Stop the gateway agent.
 *
 * 1. Find the active gateway session
 * 2. Kill the tmux session (with process tree cleanup)
 * 3. Mark session as completed in SessionStore
 */
async function stopGateway(args: string[], deps: GatewayDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? { createSession, isSessionAlive, killSession, sendKeys };

	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const legioDir = join(projectRoot, ".legio");
	const { store } = openSessionStore(legioDir);
	try {
		const session = store.getByName(GATEWAY_NAME);

		if (
			!session ||
			session.capability !== "gateway" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			throw new AgentError("No active gateway session found", {
				agentName: GATEWAY_NAME,
			});
		}

		// Kill tmux session with process tree cleanup
		const alive = await tmux.isSessionAlive(session.tmuxSession);
		if (alive) {
			await tmux.killSession(session.tmuxSession);
		}

		// Update session state
		store.updateState(GATEWAY_NAME, "completed");
		store.updateLastActivity(GATEWAY_NAME);

		if (json) {
			process.stdout.write(`${JSON.stringify({ stopped: true, sessionId: session.id })}\n`);
		} else {
			process.stdout.write(`Gateway stopped (session: ${session.id})\n`);
		}
	} finally {
		store.close();
	}
}

/**
 * Show gateway status.
 *
 * Checks session registry and tmux liveness to report actual state.
 */
async function statusGateway(args: string[], deps: GatewayDeps = {}): Promise<void> {
	const tmux = deps._tmux ?? { createSession, isSessionAlive, killSession, sendKeys };

	const json = args.includes("--json");
	const cwd = process.cwd();
	const config = await loadConfig(cwd);
	const projectRoot = config.project.root;

	const legioDir = join(projectRoot, ".legio");
	const { store } = openSessionStore(legioDir);
	try {
		const session = store.getByName(GATEWAY_NAME);

		if (
			!session ||
			session.capability !== "gateway" ||
			session.state === "completed" ||
			session.state === "zombie"
		) {
			if (json) {
				process.stdout.write(`${JSON.stringify({ running: false })}\n`);
			} else {
				process.stdout.write("Gateway is not running\n");
			}
			return;
		}

		const alive = await tmux.isSessionAlive(session.tmuxSession);

		// Reconcile state for display: if session says active but tmux is dead,
		// show as zombie. Only update the in-memory object — the watchman daemon
		// is the sole authority for persisting zombie state transitions to the DB
		// (prevents race-window zombification).
		if (!alive) {
			session.state = "zombie"; // display-only, no DB write
		}

		const status = {
			running: alive,
			sessionId: session.id,
			state: session.state,
			tmuxSession: session.tmuxSession,
			pid: session.pid,
			startedAt: session.startedAt,
			lastActivity: session.lastActivity,
		};

		if (json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const stateLabel = alive ? "running" : session.state;
			process.stdout.write(`Gateway: ${stateLabel}\n`);
			process.stdout.write(`  Session:   ${session.id}\n`);
			process.stdout.write(`  Tmux:      ${session.tmuxSession}\n`);
			process.stdout.write(`  PID:       ${session.pid}\n`);
			process.stdout.write(`  Started:   ${session.startedAt}\n`);
			process.stdout.write(`  Activity:  ${session.lastActivity}\n`);
		}
	} finally {
		store.close();
	}
}

const GATEWAY_HELP = `legio gateway — Manage the gateway planning agent

Usage: legio gateway <subcommand> [flags]

Subcommands:
  start                    Start the gateway (spawns Claude Code at project root)
  stop                     Stop the gateway (kills tmux session)
  status                   Show gateway state

Start options:
  --attach                 Always attach to tmux session after start
  --no-attach              Never attach to tmux session after start
                           Default: attach when running in an interactive TTY

General options:
  --json                   Output as JSON
  --help, -h               Show this help

The gateway agent is a planning companion that:
  - Helps decompose objectives into tasks
  - Advises on architecture and approach
  - Creates beads issues (bd create)
  - Communicates via mail with the team`;

/**
 * Entry point for `legio gateway <subcommand>`.
 *
 * @param args - CLI arguments after "gateway"
 * @param deps - Optional dependency injection for testing (tmux)
 */
export async function gatewayCommand(args: string[], deps: GatewayDeps = {}): Promise<void> {
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		process.stdout.write(`${GATEWAY_HELP}\n`);
		return;
	}

	const subcommand = args[0];
	const subArgs = args.slice(1);

	switch (subcommand) {
		case "start":
			await startGateway(subArgs, deps);
			break;
		case "stop":
			await stopGateway(subArgs, deps);
			break;
		case "status":
			await statusGateway(subArgs, deps);
			break;
		default:
			throw new ValidationError(
				`Unknown gateway subcommand: ${subcommand}. Run 'legio gateway --help' for usage.`,
				{ field: "subcommand", value: subcommand },
			);
	}
}
