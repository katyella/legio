import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Git environment variables for test repos.
 * Using env vars instead of per-repo `git config` eliminates 2 subprocess
 * spawns per repo creation.
 */
const GIT_TEST_ENV = {
	GIT_AUTHOR_NAME: "Legio Test",
	GIT_AUTHOR_EMAIL: "test@legio.dev",
	GIT_COMMITTER_NAME: "Legio Test",
	GIT_COMMITTER_EMAIL: "test@legio.dev",
};

/** Cached template repo path. Created lazily on first call. */
let _templateDir: string | null = null;

/**
 * Get or create a template git repo with an initial commit.
 * All test repos clone from this template (1 subprocess instead of 5).
 */
async function getTemplateRepo(): Promise<string> {
	if (_templateDir) return _templateDir;

	const dir = await mkdtemp(join(tmpdir(), "legio-template-"));
	runGitInDir(dir, ["init", "-b", "main"]);
	await writeFile(join(dir, ".gitkeep"), "");
	runGitInDir(dir, ["add", ".gitkeep"]);
	runGitInDir(dir, ["commit", "-m", "initial commit"]);

	_templateDir = dir;
	return dir;
}

/**
 * Create a temporary directory with a real git repo initialized.
 * Includes an initial commit so branches can be created immediately.
 *
 * Uses a cached template repo + `git clone --local` for speed:
 * 1 subprocess per call instead of 5.
 *
 * @returns The absolute path to the temp git repo.
 */
export async function createTempGitRepo(): Promise<string> {
	const template = await getTemplateRepo();
	const dir = await mkdtemp(join(tmpdir(), "legio-test-"));
	// Clone into the empty dir. Avoid --local (hardlinks trigger EFAULT in Bun's rm).
	runGitInDir(".", ["clone", template, dir]);
	// Set git identity at repo level so code that doesn't use GIT_TEST_ENV
	// (e.g., resolver's runGit) can still commit. Locally this is covered by
	// ~/.gitconfig, but CI runners have no global git identity.
	runGitInDir(dir, ["config", "user.name", "Legio Test"]);
	runGitInDir(dir, ["config", "user.email", "test@legio.dev"]);
	return dir;
}

/**
 * Add and commit a file to a git repo.
 *
 * @param repoDir - Absolute path to the git repo
 * @param filePath - Relative path within the repo (e.g. "src/foo.ts")
 * @param content - File content to write
 * @param message - Commit message (defaults to "add {filePath}")
 */
export async function commitFile(
	repoDir: string,
	filePath: string,
	content: string,
	message?: string,
): Promise<void> {
	const fullPath = join(repoDir, filePath);

	// Ensure parent directories exist
	const parentDir = join(fullPath, "..");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(parentDir, { recursive: true });

	await writeFile(fullPath, content);
	runGitInDir(repoDir, ["add", filePath]);
	runGitInDir(repoDir, ["commit", "-m", message ?? `add ${filePath}`]);
}

/**
 * Get the default branch name of a git repo (e.g., "main" or "master").
 * Uses `git symbolic-ref --short HEAD` to read the current branch.
 *
 * Useful in tests to avoid hardcoding "main" -- CI runners may default to "master".
 */
export function getDefaultBranch(repoDir: string): string {
	return runGitInDir(repoDir, ["symbolic-ref", "--short", "HEAD"]).trim();
}

/**
 * Remove a temp directory. Safe to call even if the directory doesn't exist.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

/**
 * Run a git command in the given directory. Throws on non-zero exit.
 * Passes GIT_AUTHOR/COMMITTER env vars so repos don't need per-repo config.
 */
export function runGitInDir(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		stdio: "pipe",
		env: { ...process.env, ...GIT_TEST_ENV },
	});

	const exitCode = result.status ?? 1;
	if (exitCode !== 0) {
		const stderr = (result.stderr ?? Buffer.alloc(0)).toString();
		throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
	}

	return (result.stdout ?? Buffer.alloc(0)).toString();
}
