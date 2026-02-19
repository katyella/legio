/**
 * Beads molecule management helpers.
 *
 * Wraps `bd mol` commands via Bun.spawn for multi-step workflow prototypes.
 * Molecules are templates with ordered steps. "Pouring" a prototype creates
 * actual issues with dependencies pre-wired.
 *
 * Zero runtime dependencies — only Bun built-in APIs.
 */

import { AgentError } from "../errors.ts";

// === Types ===

export interface MoleculeStep {
	title: string;
	type?: string;
}

export interface MoleculePrototype {
	id: string;
	name: string;
	stepCount: number;
}

export interface ConvoyStatus {
	total: number;
	completed: number;
	inProgress: number;
	blocked: number;
}

// === Internal helpers ===

/**
 * Run a shell command and capture its output.
 */
async function runCommand(
	cmd: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/**
 * Run a `bd` subcommand and throw on failure.
 */
async function runBd(
	args: string[],
	cwd: string,
	context: string,
): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr, exitCode } = await runCommand(["bd", ...args], cwd);
	if (exitCode !== 0) {
		throw new AgentError(`bd ${context} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return { stdout, stderr };
}

/**
 * Parse JSON output from a bd command.
 * Handles the case where output may be empty or malformed.
 */
function parseJsonOutput<T>(stdout: string, context: string): T {
	const trimmed = stdout.trim();
	if (trimmed === "") {
		throw new AgentError(`Empty output from bd ${context}`);
	}
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		throw new AgentError(
			`Failed to parse JSON output from bd ${context}: ${trimmed.slice(0, 200)}`,
		);
	}
}

// === Public API ===

/**
 * Create a molecule prototype with ordered steps.
 *
 * First creates the prototype via `bd mol create`, then adds each step
 * in order via `bd mol step add`. Returns the prototype ID.
 *
 * @param cwd - Working directory where bd commands should run
 * @param options - Prototype name and ordered steps
 * @returns The molecule prototype ID
 */
export async function createMoleculePrototype(
	cwd: string,
	options: { name: string; steps: MoleculeStep[] },
): Promise<string> {
	const { stdout } = await runBd(
		["mol", "create", "--name", options.name, "--json"],
		cwd,
		"mol create",
	);
	const result = parseJsonOutput<{ id: string }>(stdout, "mol create");
	const molId = result.id;

	for (const step of options.steps) {
		const stepArgs = [
			"mol",
			"step",
			"add",
			molId,
			"--title",
			step.title,
			"--type",
			step.type ?? "task",
			"--json",
		];
		await runBd(stepArgs, cwd, `mol step add (${step.title})`);
	}

	return molId;
}

/**
 * Pour (instantiate) a molecule prototype into actual issues.
 *
 * Creates issues from the prototype with dependencies pre-wired.
 * Optionally applies a prefix to all created issue titles.
 *
 * @param cwd - Working directory where bd commands should run
 * @param options - Prototype ID and optional title prefix
 * @returns Array of created issue IDs
 */
export async function pourMolecule(
	cwd: string,
	options: { prototypeId: string; prefix?: string },
): Promise<string[]> {
	const args = ["mol", "pour", options.prototypeId, "--json"];
	if (options.prefix !== undefined) {
		args.push("--prefix", options.prefix);
	}
	const { stdout } = await runBd(args, cwd, "mol pour");
	const result = parseJsonOutput<{ ids: string[] }>(stdout, "mol pour");
	return result.ids;
}

/**
 * List all molecule prototypes.
 *
 * @param cwd - Working directory where bd commands should run
 * @returns Array of prototype summaries
 */
export async function listPrototypes(cwd: string): Promise<MoleculePrototype[]> {
	const { stdout } = await runBd(["mol", "list", "--json"], cwd, "mol list");
	const result = parseJsonOutput<Array<{ id: string; name: string; stepCount: number }>>(
		stdout,
		"mol list",
	);
	return result.map((entry) => ({
		id: entry.id,
		name: entry.name,
		stepCount: entry.stepCount,
	}));
}

/**
 * Get the convoy status for a molecule prototype instance.
 *
 * Returns counts of total, completed, in-progress, and blocked issues
 * that were poured from this prototype.
 *
 * @param cwd - Working directory where bd commands should run
 * @param prototypeId - The prototype ID to check status for
 * @returns Status counts for the convoy
 */
export async function getConvoyStatus(cwd: string, prototypeId: string): Promise<ConvoyStatus> {
	const { stdout } = await runBd(
		["mol", "status", prototypeId, "--json"],
		cwd,
		`mol status ${prototypeId}`,
	);
	const result = parseJsonOutput<{
		total: number;
		completed: number;
		inProgress: number;
		blocked: number;
	}>(stdout, `mol status ${prototypeId}`);
	return {
		total: result.total,
		completed: result.completed,
		inProgress: result.inProgress,
		blocked: result.blocked,
	};
}
