import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for legio web UI end-to-end tests.
 *
 * Tests live in e2e/ and use the fixtures defined in e2e/fixtures.ts.
 * The fixtures start a real legio server against a temp project dir.
 *
 * Run with: bun run test:e2e
 * Type-check with: tsc --project tsconfig.e2e.json --noEmit
 */
export default defineConfig({
	testDir: "./e2e",

	// Run tests sequentially — fixtures bind a fixed port
	fullyParallel: false,
	workers: 1,

	// Fail CI builds on test.only() left in
	forbidOnly: !!process.env.CI,

	// Retry failed tests in CI
	retries: process.env.CI ? 2 : 0,

	reporter: "list",

	use: {
		baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${process.env.E2E_PORT ?? "4174"}`,
		trace: "on-first-retry",
	},

	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
