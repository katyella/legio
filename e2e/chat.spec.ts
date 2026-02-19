/**
 * E2E tests for the Chat view (#chat).
 *
 * The Chat view has three panels:
 *   1. Sidebar  — "All Messages" item + task groups + General section
 *   2. Feed     — message list (shows "No messages yet" when empty)
 *   3. Input    — From / To / Subject / Body fields + type selector + Send button
 *
 * Tests run against a fresh server with no seeded data, so they test
 * structural rendering and the form interaction path.
 */

import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function goToChat(page: import("@playwright/test").Page, serverUrl: string) {
	await page.goto(`${serverUrl}#chat`);
	// "All Messages" is always rendered in the sidebar
	await page.waitForSelector("text=All Messages", { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

test("chat sidebar renders 'All Messages' item", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	await expect(page.locator("text=All Messages")).toBeVisible();
});

test("'All Messages' item is selected by default (has accent border)", async ({
	page,
	serverUrl,
}) => {
	await goToChat(page, serverUrl);
	const allMessages = page.locator("div", { hasText: /^All Messages$/ }).first();
	// Active item has class `border-l-2 border-[#E64415]`
	await expect(allMessages).toHaveClass(/border-\[#E64415\]/);
});

test("chat sidebar does not show task groups when no agents have tasks", async ({
	page,
	serverUrl,
}) => {
	await goToChat(page, serverUrl);
	// Without any agents with beadIds, the "Tasks" section header is absent
	const tasksHeader = page.locator("div", { hasText: /^tasks$/i });
	await expect(tasksHeader).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Feed area
// ---------------------------------------------------------------------------

test("feed shows 'No messages yet' when mail store is empty", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	await expect(page.locator("text=No messages yet")).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Chat input form structure
// ---------------------------------------------------------------------------

test("chat input area renders From and To fields", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	await expect(page.locator("input[placeholder='From']")).toBeVisible();
	await expect(page.locator("input[placeholder='To']")).toBeVisible();
});

test("chat input area renders Subject field", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	await expect(page.locator("input[placeholder='Subject']")).toBeVisible();
});

test("chat input area renders message body textarea", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	await expect(page.locator("textarea[placeholder='Message body...']")).toBeVisible();
});

test("chat input area renders message type selector", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	const select = page.locator("select");
	await expect(select).toBeVisible();
	// Expected options: status, question, result, error
	for (const opt of ["status", "question", "result", "error"]) {
		await expect(select.locator(`option[value="${opt}"]`)).toHaveCount(1);
	}
});

test("chat input area renders Send button", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	await expect(page.locator("button", { hasText: "Send" })).toBeVisible();
});

test("From field is pre-filled with 'orchestrator'", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	const fromInput = page.locator("input[placeholder='From']");
	await expect(fromInput).toHaveValue("orchestrator");
});

test("To field is empty by default", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	const toInput = page.locator("input[placeholder='To']");
	await expect(toInput).toHaveValue("");
});

// ---------------------------------------------------------------------------
// Send validation
// ---------------------------------------------------------------------------

test("clicking Send without From/To shows an error", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	// Clear the pre-filled From field
	await page.locator("input[placeholder='From']").fill("");
	await page.locator("button", { hasText: "Send" }).click();
	// Error message: "From and To are required."
	await expect(page.locator("text=From and To are required.")).toBeVisible({ timeout: 5_000 });
});

test("clicking Send with From but no To shows an error", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	// From is already filled; leave To empty
	await page.locator("button", { hasText: "Send" }).click();
	await expect(page.locator("text=From and To are required.")).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Successful send via the live API
// ---------------------------------------------------------------------------

test("filling all fields and clicking Send creates a message", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);

	await page.locator("input[placeholder='To']").fill("coordinator");
	await page.locator("input[placeholder='Subject']").fill("E2E test subject");
	await page.locator("textarea[placeholder='Message body...']").fill("Hello from e2e");

	await page.locator("button", { hasText: "Send" }).click();

	// After a successful send, body and subject are cleared
	await expect(page.locator("input[placeholder='Subject']")).toHaveValue("", {
		timeout: 10_000,
	});
	await expect(page.locator("textarea[placeholder='Message body...']")).toHaveValue("");
});

// ---------------------------------------------------------------------------
// Header context label
// ---------------------------------------------------------------------------

test("chat main area header shows 'All Messages' when nothing is selected", async ({
	page,
	serverUrl,
}) => {
	await goToChat(page, serverUrl);
	// The header area inside the main chat panel shows the context label
	// Using a slightly more specific selector to avoid ambiguity with the sidebar
	const header = page.locator("div.border-b span.font-semibold", { hasText: "All Messages" });
	await expect(header).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Feed area is scrollable
// ---------------------------------------------------------------------------

test("feed container has overflow-y-auto for scrollability", async ({ page, serverUrl }) => {
	await goToChat(page, serverUrl);
	// The feed div has class overflow-y-auto
	const feed = page.locator("div.overflow-y-auto.p-4");
	await expect(feed).toBeVisible();
});
