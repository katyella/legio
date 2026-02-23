import { spawn } from "node:child_process";
import { join } from "node:path";
import { WorktreeError } from "../errors.ts";

/**
 * Run a shell command and capture its output.
 */
async function runCommand(
	cmd: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const [command, ...args] = cmd;
	if (!command) throw new Error("Empty command");
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
		proc.stdout.on("data", (data: Buffer) => chunks.stdout.push(data));
		proc.stderr.on("data", (data: Buffer) => chunks.stderr.push(data));
		proc.on("error", reject);
		proc.on("close", (code) => {
			resolve({
				stdout: Buffer.concat(chunks.stdout).toString(),
				stderr: Buffer.concat(chunks.stderr).toString(),
				exitCode: code ?? 1,
			});
		});
	});
}

/**
 * Run a git command and return stdout. Throws WorktreeError on non-zero exit.
 */
async function runGit(
	repoRoot: string,
	args: string[],
	context?: { worktreePath?: string; branchName?: string },
): Promise<string> {
	const { stdout, stderr, exitCode } = await runCommand(["git", ...args], repoRoot);

	if (exitCode !== 0) {
		throw new WorktreeError(
			`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
			{
				worktreePath: context?.worktreePath,
				branchName: context?.branchName,
			},
		);
	}

	return stdout;
}

/**
 * Create a new git worktree for an agent.
 *
 * Creates a worktree at `{baseDir}/{agentName}` with a new branch
 * named `legio/{agentName}/{beadId}` based on `baseBranch`.
 *
 * @returns The absolute worktree path and branch name.
 */
export async function createWorktree(options: {
	repoRoot: string;
	baseDir: string;
	agentName: string;
	baseBranch: string;
	beadId: string;
}): Promise<{ path: string; branch: string }> {
	const { repoRoot, baseDir, agentName, baseBranch, beadId } = options;

	const worktreePath = join(baseDir, agentName);
	const branchName = `legio/${agentName}/${beadId}`;

	await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseBranch], {
		worktreePath,
		branchName,
	});

	return { path: worktreePath, branch: branchName };
}

/**
 * Parsed representation of a single worktree entry from `git worktree list --porcelain`.
 */
interface WorktreeEntry {
	path: string;
	branch: string;
	head: string;
}

/**
 * Parse the output of `git worktree list --porcelain` into structured entries.
 *
 * Porcelain format example:
 * ```
 * worktree /path/to/main
 * HEAD abc123
 * branch refs/heads/main
 *
 * worktree /path/to/wt
 * HEAD def456
 * branch refs/heads/legio/agent/bead
 * ```
 */
function parseWorktreeOutput(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	const blocks = output.trim().split("\n\n");

	for (const block of blocks) {
		if (block.trim() === "") continue;

		let path = "";
		let head = "";
		let branch = "";

		const lines = block.trim().split("\n");
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length);
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length);
			} else if (line.startsWith("branch ")) {
				// Strip refs/heads/ prefix to get the short branch name
				const ref = line.slice("branch ".length);
				branch = ref.replace(/^refs\/heads\//, "");
			}
		}

		if (path.length > 0) {
			entries.push({ path, head, branch });
		}
	}

	return entries;
}

/**
 * List all git worktrees in the repository.
 *
 * @returns Array of worktree entries with path, branch name, and HEAD commit.
 */
export async function listWorktrees(
	repoRoot: string,
): Promise<Array<{ path: string; branch: string; head: string }>> {
	const stdout = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	return parseWorktreeOutput(stdout);
}

/**
 * Check whether a branch has been merged into a target ref.
 *
 * Uses `git merge-base --is-ancestor <branch> <target>`, which exits 0
 * when branch is an ancestor of target (i.e., merged) and 1 when it is not.
 * Any other exit code (e.g., unknown object) is treated as not merged.
 *
 * @param repoRoot - Absolute path to the git repository root.
 * @param branch - Branch to check.
 * @param target - Ref to check against (e.g. "HEAD", "main").
 */
export async function isBranchMerged(
	repoRoot: string,
	branch: string,
	target: string,
): Promise<boolean> {
	const { exitCode } = await runCommand(
		["git", "merge-base", "--is-ancestor", branch, target],
		repoRoot,
	);
	// exit 0 = is ancestor (merged), exit 1 = not ancestor, other = error → treat as not merged
	return exitCode === 0;
}

/**
 * Remove a git worktree and delete its associated branch.
 *
 * Runs `git worktree remove {path}` to remove the worktree, then
 * deletes the branch. With `forceBranch: true`, uses `git branch -D`
 * to force-delete even unmerged branches and swallows deletion errors
 * (best-effort). Without `forceBranch`, uses `git branch -d` which only
 * deletes merged branches — if deletion fails (branch is unmerged), throws
 * `WorktreeError` to signal that unmerged work remains.
 */
export async function removeWorktree(
	repoRoot: string,
	path: string,
	options?: { force?: boolean; forceBranch?: boolean },
): Promise<void> {
	// First, figure out which branch this worktree is on so we can clean it up
	const worktrees = await listWorktrees(repoRoot);
	const entry = worktrees.find((wt) => wt.path === path);
	const branchName = entry?.branch ?? "";

	// Remove the worktree (--force handles untracked files and uncommitted changes)
	const removeArgs = ["worktree", "remove", path];
	if (options?.force) {
		removeArgs.push("--force");
	}
	await runGit(repoRoot, removeArgs, {
		worktreePath: path,
		branchName,
	});

	// Delete the associated branch after worktree removal.
	// Use -D (force) when forceBranch is set, since the branch may not have
	// been merged yet. Use -d (safe) otherwise, which only deletes merged branches.
	if (branchName.length > 0) {
		const deleteFlag = options?.forceBranch ? "-D" : "-d";
		try {
			await runGit(repoRoot, ["branch", deleteFlag, branchName], { branchName });
		} catch {
			if (!options?.forceBranch) {
				// Branch deletion failed without forceBranch — the branch has unmerged commits.
				// Throw so callers know unmerged work remains on the branch.
				throw new WorktreeError(
					`Branch "${branchName}" has unmerged commits; pass forceBranch: true to force-delete.`,
					{ worktreePath: path, branchName },
				);
			}
			// forceBranch: branch deletion is best-effort, swallow the error.
		}
	}
}
