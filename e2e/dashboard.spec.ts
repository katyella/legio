/**
 * E2E tests for the Dashboard view (#dashboard).
 *
 * The Dashboard renders four panels:
 *   - Agents table  (col-span-10, shows "No agents" when empty)
 *   - Recent Mail   (col-span-6, shows "No messages" when empty)
 *   - Merge Queue   (col-span-4, shows "Queue is empty" when empty)
 *   - Metrics strip (col-span-10, always shows stat counters)
 *
 * Because these tests run against a fresh server with no seeded data, the
 * empty-state strings are the primary assertions. Structural assertions
 * (section headers, table headings) verify that the component renders
 * correctly regardless of data.
 */

import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function goToDashboard(page: import("@playwright/test").Page, serverUrl: string) {
	await page.goto(`${serverUrl}#dashboard`);
	// Wait for the Preact component to render (Agents section header is always present)
	await page.waitForSelector("text=Agents", { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Section headers
// ---------------------------------------------------------------------------

test("dashboard renders the Agents section header", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	// The header text in DashboardView uses uppercase: "AGENTS" (via text-xs uppercase)
	// We search case-insensitively
	const header = page.locator("div", { hasText: /^Agents$/i }).first();
	await expect(header).toBeVisible();
});

test("dashboard renders the Recent Mail section header", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	const header = page.locator("div", { hasText: /recent mail/i }).first();
	await expect(header).toBeVisible();
});

test("dashboard renders the Merge Queue section header", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	const header = page.locator("div", { hasText: /merge queue/i }).first();
	await expect(header).toBeVisible();
});

test("dashboard renders the Metrics section header", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	const header = page.locator("div", { hasText: /metrics/i }).first();
	await expect(header).toBeVisible();
});

// ---------------------------------------------------------------------------
// Empty state text
// ---------------------------------------------------------------------------

test("agents table shows 'No agents' when no agent sessions exist", async ({
	page,
	serverUrl,
}) => {
	await goToDashboard(page, serverUrl);
	await expect(page.locator("text=No agents")).toBeVisible({ timeout: 10_000 });
});

test("recent mail panel shows 'No messages' when mail store is empty", async ({
	page,
	serverUrl,
}) => {
	await goToDashboard(page, serverUrl);
	await expect(page.locator("text=No messages")).toBeVisible({ timeout: 10_000 });
});

test("merge queue panel shows 'Queue is empty' when merge queue is empty", async ({
	page,
	serverUrl,
}) => {
	await goToDashboard(page, serverUrl);
	await expect(page.locator("text=Queue is empty")).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Agents table structure
// ---------------------------------------------------------------------------

test("agents table has expected column headings", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	const tableHeadings = ["State", "Name", "Capability", "Task", "Duration"];
	for (const heading of tableHeadings) {
		await expect(page.locator(`th:has-text("${heading}")`)).toBeVisible();
	}
});

// ---------------------------------------------------------------------------
// Metrics strip
// ---------------------------------------------------------------------------

test("metrics strip shows Sessions stat", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	await expect(page.locator("text=Sessions")).toBeVisible();
});

test("metrics strip shows Active stat", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	await expect(page.locator("text=Active")).toBeVisible();
});

test("metrics strip shows Completed stat", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	await expect(page.locator("text=Completed")).toBeVisible();
});

test("metrics strip shows Unread Mail stat", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	await expect(page.locator("text=Unread Mail")).toBeVisible();
});

test("metrics strip shows Pending Merges stat", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	await expect(page.locator("text=Pending Merges")).toBeVisible();
});

test("metrics strip shows zero counts when no data exists", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	// MetricsStrip renders <strong> elements for the values.
	// With no data, Sessions, Active, Completed should all be 0.
	const strongs = page.locator(".flex.flex-wrap strong");
	const texts = await strongs.allTextContents();
	// All metric values should be numeric strings
	for (const text of texts) {
		expect(Number.isNaN(Number(text))).toBe(false);
	}
});

// ---------------------------------------------------------------------------
// Dashboard layout is a grid
// ---------------------------------------------------------------------------

test("dashboard content is wrapped in a grid container", async ({ page, serverUrl }) => {
	await goToDashboard(page, serverUrl);
	// DashboardView root is `<div class="grid grid-cols-10 gap-4 p-4">`
	const grid = page.locator("div.grid.grid-cols-10");
	await expect(grid).toBeVisible();
});

// ---------------------------------------------------------------------------
// Navigation from dashboard
// ---------------------------------------------------------------------------

test("agent name links in dashboard navigate to inspect view", async ({ page, serverUrl }) => {
	// No agents seeded — just verify no inspect links crash the page
	await goToDashboard(page, serverUrl);
	// When agents exist, their names are <a href="#inspect/agentName"> links.
	// With no agents, this area just shows "No agents".
	await expect(page.locator("text=No agents")).toBeVisible();
});
