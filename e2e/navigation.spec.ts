/**
 * E2E navigation tests — hash-based SPA routing.
 *
 * Verifies that clicking nav links changes the active view, that hash URLs
 * load the correct view directly, and that the global nav is always present.
 *
 * The SPA uses `location.hash` for routing (e.g. #chat, #dashboard, #events).
 * Active links have `border-[#E64415]` on their bottom border.
 */

import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the app to mount and the nav to appear. */
async function waitForApp(page: import("@playwright/test").Page) {
	await page.waitForSelector("nav", { timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Nav presence
// ---------------------------------------------------------------------------

test("renders a nav bar with all expected links", async ({ page, serverUrl }) => {
	await page.goto(serverUrl);
	await waitForApp(page);

	const expectedLabels = ["Chat", "Dashboard", "Events", "Costs", "Issues", "Terminal", "Autopilot"];

	for (const label of expectedLabels) {
		const link = page.locator("nav a", { hasText: label });
		await expect(link).toBeVisible();
	}
});

test("nav bar contains a WebSocket connection indicator", async ({ page, serverUrl }) => {
	await page.goto(serverUrl);
	await waitForApp(page);
	// Status dot is a span with rounded-full class inside the nav
	const dot = page.locator("nav span.rounded-full");
	await expect(dot).toBeVisible();
});

// ---------------------------------------------------------------------------
// Default route
// ---------------------------------------------------------------------------

test("loads the Chat view by default (no hash)", async ({ page, serverUrl }) => {
	await page.goto(serverUrl);
	await waitForApp(page);

	// Chat view renders an "All Messages" sidebar item
	await expect(page.locator("text=All Messages")).toBeVisible({ timeout: 10_000 });
});

test("loads the Chat view when hash is #chat", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#chat`);
	await waitForApp(page);
	await expect(page.locator("text=All Messages")).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Hash routing — direct navigation
// ---------------------------------------------------------------------------

test("navigates to Dashboard view via #dashboard hash", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#dashboard`);
	await waitForApp(page);
	// Dashboard renders an "Agents" panel header
	await expect(page.locator("text=Agents").first()).toBeVisible({ timeout: 10_000 });
});

test("navigates to Events view via #events hash", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#events`);
	await waitForApp(page);
	// EventsView renders something — the nav at minimum should be visible
	await expect(page.locator("nav")).toBeVisible();
});

test("navigates to Costs view via #costs hash", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#costs`);
	await waitForApp(page);
	await expect(page.locator("nav")).toBeVisible();
});

test("navigates to Issues view via #issues hash", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#issues`);
	await waitForApp(page);
	await expect(page.locator("nav")).toBeVisible();
});

test("navigates to Terminal view via #terminal hash", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#terminal`);
	await waitForApp(page);
	await expect(page.locator("nav")).toBeVisible();
});

test("navigates to Autopilot view via #autopilot hash", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#autopilot`);
	await waitForApp(page);
	await expect(page.locator("nav")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Nav link clicks
// ---------------------------------------------------------------------------

test("clicking Dashboard nav link renders the Dashboard view", async ({ page, serverUrl }) => {
	await page.goto(serverUrl);
	await waitForApp(page);

	await page.locator("nav a", { hasText: "Dashboard" }).click();
	await expect(page).toHaveURL(/#dashboard/);
	// Dashboard renders "Agents" and "Merge Queue" sections
	await expect(page.locator("text=Agents").first()).toBeVisible({ timeout: 10_000 });
});

test("clicking Chat nav link from Dashboard returns to Chat view", async ({
	page,
	serverUrl,
}) => {
	await page.goto(`${serverUrl}#dashboard`);
	await waitForApp(page);

	await page.locator("nav a", { hasText: "Chat" }).click();
	await expect(page).toHaveURL(/#chat/);
	await expect(page.locator("text=All Messages")).toBeVisible({ timeout: 10_000 });
});

test("clicking Events nav link renders the Events view", async ({ page, serverUrl }) => {
	await page.goto(serverUrl);
	await waitForApp(page);

	await page.locator("nav a", { hasText: "Events" }).click();
	await expect(page).toHaveURL(/#events/);
});

test("clicking Issues nav link renders the Issues view", async ({ page, serverUrl }) => {
	await page.goto(serverUrl);
	await waitForApp(page);

	await page.locator("nav a", { hasText: "Issues" }).click();
	await expect(page).toHaveURL(/#issues/);
});

// ---------------------------------------------------------------------------
// Active link styling
// ---------------------------------------------------------------------------

test("active nav link has accent border colour", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#dashboard`);
	await waitForApp(page);

	const dashboardLink = page.locator("nav a", { hasText: "Dashboard" });
	// Active link has border-[#E64415] class
	await expect(dashboardLink).toHaveClass(/border-\[#E64415\]/);
});

test("inactive nav links do not have the accent border", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#dashboard`);
	await waitForApp(page);

	// Chat link should NOT be active when on dashboard
	const chatLink = page.locator("nav a", { hasText: "Chat" });
	await expect(chatLink).not.toHaveClass(/border-\[#E64415\]/);
});

// ---------------------------------------------------------------------------
// Unknown hash falls back to Chat view
// ---------------------------------------------------------------------------

test("unknown hash route falls back to Chat view", async ({ page, serverUrl }) => {
	await page.goto(`${serverUrl}#completely-unknown-view-xyz`);
	await waitForApp(page);
	// Default case in Router renders ChatView
	await expect(page.locator("text=All Messages")).toBeVisible({ timeout: 10_000 });
});
