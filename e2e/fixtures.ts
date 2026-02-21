/**
 * Playwright e2e test fixtures for the legio web UI.
 *
 * Uses node:child_process because Playwright workers run in Node.js.
 * The server process itself is spawned via `tsx src/index.ts server start`.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the legio repo root (one level above e2e/) */
const REPO_ROOT = join(__dirname, "..");

const E2E_PORT = Number(process.env.E2E_PORT ?? 4174);

/** Minimal .legio/config.yaml that satisfies loadConfig() */
const MINIMAL_CONFIG = `project:
  name: e2e-test
  canonicalBranch: main
agents:
  maxDepth: 2
coordinator:
  model: sonnet
`;

/** Poll until the server responds or timeout expires */
async function waitForServer(url: string, timeout = 15_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			// Any non-5xx response means the server is up
			if (res.status < 500) return;
		} catch {
			// Server not yet accepting connections — keep polling
		}
		await new Promise<void>((r) => setTimeout(r, 200));
	}
	throw new Error(`Server at ${url} did not start within ${timeout}ms`);
}

type OvFixtures = {
	/** Temp directory with .legio/config.yaml pre-created */
	projectDir: string;
	/** Base URL of the running legio server (e.g. http://localhost:4174) */
	serverUrl: string;
};

export const test = base.extend<OvFixtures>({
	projectDir: async ({}, use) => {
		const dir = await mkdtemp(join(tmpdir(), "ov-e2e-"));
		const ovDir = join(dir, ".legio");
		await mkdir(ovDir, { recursive: true });
		await writeFile(join(ovDir, "config.yaml"), MINIMAL_CONFIG);
		await use(dir);
		await rm(dir, { recursive: true, force: true });
	},

	// projectDir must be set up before serverUrl can start the server
	serverUrl: async ({ projectDir }, use) => {
		const port = E2E_PORT;
		const serverEntry = join(REPO_ROOT, "src", "index.ts");

		const proc = spawn("tsx", [serverEntry, "server", "start", "--port", String(port)], {
			cwd: projectDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		const url = `http://localhost:${port}`;
		try {
			await waitForServer(url);
			await use(url);
		} finally {
			proc.kill("SIGTERM");
			// Wait for process to exit cleanly
			await new Promise<void>((resolve) => proc.on("close", resolve));
		}
	},
});

export { expect } from "@playwright/test";
