/**
 * CLI command: legio init [--force]
 *
 * Scaffolds the `.legio/` directory in the current project with:
 * - config.yaml (serialized from DEFAULT_CONFIG)
 * - agent-manifest.json (starter agent definitions)
 * - hooks.json (central hooks config)
 * - Required subdirectories (agents/, worktrees/, specs/, logs/)
 * - .gitignore entries for transient files
 */

import { spawn } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_CONFIG } from "../config.ts";
import { ValidationError } from "../errors.ts";
import type { AgentManifest, LegioConfig } from "../types.ts";

const LEGIO_DIR = ".legio";

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
 * Run an external command and collect stdout/stderr + exit code.
 */
async function runCommand(
	cmd: string[],
	opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const [command, ...args] = cmd;
	if (!command) {
		return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
	}
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: opts?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		proc.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString(),
				exitCode: code ?? 1,
			});
		});
	});
}

/**
 * Detect the project name from git or fall back to directory name.
 */
async function detectProjectName(root: string): Promise<string> {
	// Try git remote origin
	try {
		const { stdout, exitCode } = await runCommand(["git", "remote", "get-url", "origin"], {
			cwd: root,
		});
		if (exitCode === 0) {
			const url = stdout.trim();
			// Extract repo name from URL: git@host:user/repo.git or https://host/user/repo.git
			const match = url.match(/\/([^/]+?)(?:\.git)?$/);
			if (match?.[1]) {
				return match[1];
			}
		}
	} catch {
		// Git not available or not a git repo
	}

	return basename(root);
}

/**
 * Detect the canonical branch name from git.
 */
async function detectCanonicalBranch(root: string): Promise<string> {
	try {
		const { stdout, exitCode } = await runCommand(
			["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
			{ cwd: root },
		);
		if (exitCode === 0) {
			const ref = stdout.trim();
			// refs/remotes/origin/main -> main
			const branch = ref.split("/").pop();
			if (branch) {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	// Fall back to checking current branch
	try {
		const { stdout, exitCode } = await runCommand(["git", "branch", "--show-current"], {
			cwd: root,
		});
		if (exitCode === 0) {
			const branch = stdout.trim();
			if (branch === "main" || branch === "master" || branch === "develop") {
				return branch;
			}
		}
	} catch {
		// Not available
	}

	return "main";
}

/**
 * Serialize an LegioConfig to YAML format.
 *
 * Handles nested objects with indentation, scalar values,
 * arrays with `- item` syntax, and empty arrays as `[]`.
 */
function serializeConfigToYaml(config: LegioConfig): string {
	const lines: string[] = [];
	lines.push("# Legio configuration");
	lines.push("# See: https://github.com/legio/legio");
	lines.push("");

	serializeObject(config as unknown as Record<string, unknown>, lines, 0);

	return `${lines.join("\n")}\n`;
}

/**
 * Recursively serialize an object to YAML lines.
 */
function serializeObject(obj: Record<string, unknown>, lines: string[], depth: number): void {
	const indent = "  ".repeat(depth);

	for (const [key, value] of Object.entries(obj)) {
		if (value === null || value === undefined) {
			lines.push(`${indent}${key}: null`);
		} else if (typeof value === "object" && !Array.isArray(value)) {
			lines.push(`${indent}${key}:`);
			serializeObject(value as Record<string, unknown>, lines, depth + 1);
		} else if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${indent}${key}: []`);
			} else {
				lines.push(`${indent}${key}:`);
				const itemIndent = "  ".repeat(depth + 1);
				for (const item of value) {
					lines.push(`${itemIndent}- ${formatYamlValue(item)}`);
				}
			}
		} else {
			lines.push(`${indent}${key}: ${formatYamlValue(value)}`);
		}
	}
}

/**
 * Format a scalar value for YAML output.
 */
function formatYamlValue(value: unknown): string {
	if (typeof value === "string") {
		// Quote strings that could be misinterpreted
		if (
			value === "" ||
			value === "true" ||
			value === "false" ||
			value === "null" ||
			value.includes(":") ||
			value.includes("#") ||
			value.includes("'") ||
			value.includes('"') ||
			value.includes("\n") ||
			/^\d/.test(value)
		) {
			// Use double quotes, escaping inner double quotes
			return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	if (typeof value === "number") {
		return String(value);
	}

	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	if (value === null || value === undefined) {
		return "null";
	}

	return String(value);
}

/**
 * Build the starter agent manifest.
 */
function buildAgentManifest(): AgentManifest {
	const agents: AgentManifest["agents"] = {
		scout: {
			file: "scout.md",
			model: "haiku",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["explore", "research"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		builder: {
			file: "builder.md",
			model: "sonnet",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
			capabilities: ["implement", "refactor", "fix"],
			canSpawn: false,
			constraints: [],
		},
		reviewer: {
			file: "reviewer.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["review", "validate"],
			canSpawn: false,
			constraints: ["read-only"],
		},
		lead: {
			file: "lead.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
			capabilities: ["coordinate", "implement", "review"],
			canSpawn: true,
			constraints: [],
		},
		merger: {
			file: "merger.md",
			model: "sonnet",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
			capabilities: ["merge", "resolve-conflicts"],
			canSpawn: false,
			constraints: [],
		},
		coordinator: {
			file: "coordinator.md",
			model: "opus",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["coordinate", "dispatch", "escalate"],
			canSpawn: true,
			constraints: ["read-only", "no-worktree"],
		},
		supervisor: {
			file: "supervisor.md",
			model: "opus",
			tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Task"],
			capabilities: ["coordinate", "supervise"],
			canSpawn: true,
			constraints: [],
		},
		monitor: {
			file: "monitor.md",
			model: "sonnet",
			tools: ["Read", "Glob", "Grep", "Bash"],
			capabilities: ["monitor", "patrol"],
			canSpawn: false,
			constraints: ["read-only", "no-worktree"],
		},
	};

	// Build capability index: map each capability to agent names that declare it
	const capabilityIndex: Record<string, string[]> = {};
	for (const [name, def] of Object.entries(agents)) {
		for (const cap of def.capabilities) {
			const existing = capabilityIndex[cap];
			if (existing) {
				existing.push(name);
			} else {
				capabilityIndex[cap] = [name];
			}
		}
	}

	return { version: "1.0", agents, capabilityIndex };
}

/**
 * Build the hooks.json content for the project orchestrator.
 *
 * Always generates from scratch (not from the agent template, which contains
 * {{AGENT_NAME}} placeholders and space indentation). Uses tab indentation
 * to match Biome formatting rules.
 */
function buildHooksJson(): string {
	// Tool name extraction: reads hook stdin JSON and extracts tool_name field.
	// Claude Code sends {"tool_name":"Bash","tool_input":{...}} on stdin for
	// PreToolUse/PostToolUse hooks.
	const toolNameExtract =
		'read -r INPUT; TOOL_NAME=$(echo "$INPUT" | sed \'s/.*"tool_name": *"\\([^"]*\\)".*/\\1/\');';

	const hooks = {
		hooks: {
			SessionStart: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "legio prime --agent orchestrator",
						},
					],
				},
			],
			UserPromptSubmit: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "legio mail check --inject --agent orchestrator",
						},
					],
				},
			],
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command:
								'read -r INPUT; CMD=$(echo "$INPUT" | sed \'s/.*"command": *"\\([^"]*\\)".*/\\1/\'); if echo "$CMD" | grep -qE \'\\bgit\\s+push\\b\'; then echo \'{"decision":"block","reason":"git push is blocked by legio — merge locally, push manually when ready"}\'; exit 0; fi;',
						},
					],
				},
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `${toolNameExtract} legio log tool-start --agent orchestrator --tool-name "$TOOL_NAME"`,
						},
					],
				},
			],
			PostToolUse: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: `${toolNameExtract} legio log tool-end --agent orchestrator --tool-name "$TOOL_NAME"`,
						},
					],
				},
			],
			Stop: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "legio log session-end --agent orchestrator",
						},
						{
							type: "command",
							command: "mulch learn",
						},
					],
				},
			],
			PreCompact: [
				{
					matcher: "",
					hooks: [
						{
							type: "command",
							command: "legio prime --agent orchestrator --compact",
						},
					],
				},
			],
		},
	};

	return `${JSON.stringify(hooks, null, "\t")}\n`;
}

/**
 * Migrate existing SQLite databases on --force reinit.
 *
 * Opens each DB, enables WAL mode, and re-runs CREATE TABLE/INDEX IF NOT EXISTS
 * to apply any schema additions without losing existing data.
 */
async function migrateExistingDatabases(legioPath: string): Promise<string[]> {
	const migrated: string[] = [];

	// Migrate mail.db
	const mailDbPath = join(legioPath, "mail.db");
	if (await fileExists(mailDbPath)) {
		const db = new Database(mailDbPath);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status',
  priority TEXT NOT NULL DEFAULT 'normal',
  thread_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
		db.exec(`
CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_agent, read);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id)`);
		db.close();
		migrated.push("mail.db");
	}

	// Migrate metrics.db
	const metricsDbPath = join(legioPath, "metrics.db");
	if (await fileExists(metricsDbPath)) {
		const db = new Database(metricsDbPath);
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  agent_name TEXT NOT NULL,
  bead_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  merge_result TEXT,
  parent_agent TEXT,
  PRIMARY KEY (agent_name, bead_id)
)`);
		db.close();
		migrated.push("metrics.db");
	}

	return migrated;
}

/**
 * Content for .legio/.gitignore — runtime state that should not be tracked.
 * Uses wildcard+whitelist pattern: ignore everything, whitelist tracked files.
 * Auto-healed by legio prime on each session start.
 * Config files (config.yaml, agent-manifest.json, hooks.json) remain tracked.
 */
export const LEGIO_GITIGNORE = `# Wildcard+whitelist: ignore everything, whitelist tracked files
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
 * Write .legio/.gitignore for runtime state files.
 * Always overwrites to support --force reinit and auto-healing via prime.
 */
export async function writeLegioGitignore(legioPath: string): Promise<void> {
	const gitignorePath = join(legioPath, ".gitignore");
	await writeFile(gitignorePath, OVERSTORY_GITIGNORE);
}

/**
 * Print a success status line.
 */
function printCreated(relativePath: string): void {
	process.stdout.write(`  \u2713 Created ${relativePath}\n`);
}

/**
 * Entry point for `legio init [--force]`.
 *
 * Scaffolds the .legio/ directory structure in the current working directory.
 *
 * @param args - CLI arguments after "init" subcommand
 */
const INIT_HELP = `legio init — Initialize .legio/ in current project

Usage: legio init [--force]

Options:
  --force      Reinitialize even if .legio/ already exists
  --help, -h   Show this help`;

export async function initCommand(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${INIT_HELP}\n`);
		return;
	}

	const force = args.includes("--force");
	const projectRoot = process.cwd();
	const legioPath = join(projectRoot, LEGIO_DIR);

	// 0. Verify we're inside a git repository
	const { exitCode: gitCheckExit } = await runCommand(
		["git", "rev-parse", "--is-inside-work-tree"],
		{ cwd: projectRoot },
	);
	if (gitCheckExit !== 0) {
		throw new ValidationError("legio requires a git repository. Run 'git init' first.", {
			field: "git",
		});
	}

	// 1. Check if .legio/ already exists
	if (await fileExists(join(legioPath, "config.yaml"))) {
		if (!force) {
			process.stdout.write(
				"Warning: .legio/ already initialized in this project.\n" +
					"Use --force to reinitialize.\n",
			);
			return;
		}
		process.stdout.write("Reinitializing .legio/ (--force)\n\n");
	}

	// 2. Detect project info
	const projectName = await detectProjectName(projectRoot);
	const canonicalBranch = await detectCanonicalBranch(projectRoot);

	process.stdout.write(`Initializing legio for "${projectName}"...\n\n`);

	// 3. Create directory structure
	const dirs = [
		LEGIO_DIR,
		join(LEGIO_DIR, "agents"),
		join(LEGIO_DIR, "agent-defs"),
		join(LEGIO_DIR, "worktrees"),
		join(LEGIO_DIR, "specs"),
		join(LEGIO_DIR, "logs"),
	];

	for (const dir of dirs) {
		await mkdir(join(projectRoot, dir), { recursive: true });
		printCreated(`${dir}/`);
	}

	// 3b. Deploy agent definition .md files from legio install directory
	const legioAgentsDir = join(import.meta.dirname, "..", "..", "agents");
	const agentDefsTarget = join(legioPath, "agent-defs");
	const agentDefFiles = await readdir(legioAgentsDir);
	for (const fileName of agentDefFiles) {
		if (!fileName.endsWith(".md")) continue;
		const content = await readFile(join(legioAgentsDir, fileName), "utf-8");
		await writeFile(join(agentDefsTarget, fileName), content);
		printCreated(`${OVERSTORY_DIR}/agent-defs/${fileName}`);
	}

	// 4. Write config.yaml
	const config = structuredClone(DEFAULT_CONFIG);
	config.project.name = projectName;
	config.project.root = projectRoot;
	config.project.canonicalBranch = canonicalBranch;

	const configYaml = serializeConfigToYaml(config);
	const configPath = join(legioPath, "config.yaml");
	await writeFile(configPath, configYaml);
	printCreated(`${OVERSTORY_DIR}/config.yaml`);

	// 5. Write agent-manifest.json
	const manifest = buildAgentManifest();
	const manifestPath = join(legioPath, "agent-manifest.json");
	await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	printCreated(`${OVERSTORY_DIR}/agent-manifest.json`);

	// 6. Write hooks.json
	const hooksContent = buildHooksJson();
	const hooksPath = join(legioPath, "hooks.json");
	await writeFile(hooksPath, hooksContent);
	printCreated(`${OVERSTORY_DIR}/hooks.json`);

	// 7. Write .legio/.gitignore for runtime state
	await writeLegioGitignore(legioPath);
	printCreated(`${LEGIO_DIR}/.gitignore`);

	// 8. Migrate existing SQLite databases on --force reinit
	if (force) {
		const migrated = await migrateExistingDatabases(legioPath);
		for (const dbName of migrated) {
			process.stdout.write(`  \u2713 Migrated ${LEGIO_DIR}/${dbName} (schema validated)\n`);
		}
	}

	process.stdout.write("\nDone.\n");
	process.stdout.write("  Next: run `legio hooks install` to enable Claude Code hooks.\n");
	process.stdout.write("  Then: run `legio status` to see the current state.\n");
}
