import { cleanupTempDir, createTempGitRepo } from "./test-helpers.js";

let fixtureRepoPath: string | undefined;

export async function setup() {
	fixtureRepoPath = await createTempGitRepo();
	process.env.LEGIO_TEST_FIXTURE_REPO = fixtureRepoPath;
}

export async function teardown() {
	if (fixtureRepoPath) {
		await cleanupTempDir(fixtureRepoPath);
	}
}
