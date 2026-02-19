/**
 * E2E tests for the Costs view (#costs).
 *
 * The Costs view renders:
 *   - Four stat cards: Total Cost, Total Tokens, Sessions, Avg Cost/Session
 *   - Cost by Agent bar chart (shows "No cost data" when empty)
 *   - Token Distribution chart
 *   - Detailed Breakdown table with column headers
 *
 * These tests run against a fresh server with no seeded data, so empty-state
 * strings and structural assertions are the primary assertions.
 */

import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function goToCosts(page: import("@playwright/test").Page, serverUrl: string) {
	await page.goto(`${serverUrl}#costs`);
	await page.waitForSelector("text=Total Cost", { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------------

test("costs view renders Total Cost stat card", async ({ page, serverUrl }) => {
	await goToCosts(page, serverUrl);
	await expect(page.locator("div", { hasText: /^Total Cost$/i }).first()).toBeVisible();
});

test("costs view renders Total Tokens stat card", async ({ page, serverUrl }) => {
	await goToCosts(page, serverUrl);
	await expect(page.locator("div", { hasText: /^Total Tokens$/i }).first()).toBeVisible();
});

test("costs view renders Sessions stat card", async ({ page, serverUrl }) => {
	await goToCosts(page, serverUrl);
	await expect(page.locator("div", { hasText: /^Sessions$/i }).first()).toBeVisible();
});

test("costs view renders Avg Cost/Session stat card", async ({ page, serverUrl }) => {
	await goToCosts(page, serverUrl);
	await expect(page.locator("div", { hasText: /avg cost\/session/i }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// Detailed breakdown table column headers
// ---------------------------------------------------------------------------

test("costs view detailed breakdown table has expected column headers", async ({
	page,
	serverUrl,
}) => {
	await goToCosts(page, serverUrl);
	const expectedHeaders = [
		"Agent",
		"Capability",
		"Input Tokens",
		"Output Tokens",
		"Cache Read",
		"Cache Created",
		"Est. Cost",
	];
	for (const header of expectedHeaders) {
		await expect(page.locator(`th:has-text("${header}")`)).toBeVisible();
	}
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

test("costs view table body shows 'No metrics yet' when no data is seeded", async ({
	page,
	serverUrl,
}) => {
	await goToCosts(page, serverUrl);
	await expect(page.locator("text=No metrics yet")).toBeVisible({ timeout: 10_000 });
});

test("costs view Cost by Agent section shows 'No cost data' when empty", async ({
	page,
	serverUrl,
}) => {
	await goToCosts(page, serverUrl);
	await expect(page.locator("text=No cost data")).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// No crash after WebSocket snapshot
// ---------------------------------------------------------------------------

test("costs view does not crash after WS snapshot poll cycle", async ({ page, serverUrl }) => {
	const jsErrors: string[] = [];
	page.on("pageerror", (err) => {
		jsErrors.push(err.message);
	});

	await goToCosts(page, serverUrl);

	// Wait for at least one WS poll cycle (~3s) so the server has time to push a snapshot
	await page.waitForTimeout(3_000);

	// The page must still show the stat cards (not a blank crash screen)
	await expect(page.locator("text=Total Cost")).toBeVisible();

	// No uncaught JS errors should have occurred
	expect(jsErrors).toHaveLength(0);
});
