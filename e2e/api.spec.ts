/**
 * E2E tests for REST API endpoints.
 *
 * Exercises the live server (started by fixtures.ts) with real HTTP requests.
 * Uses Playwright's APIRequestContext rather than a browser page — these tests
 * verify the JSON contract, not the UI.
 *
 * All tests run against an empty .legio/ directory (no seeded databases),
 * so they verify graceful-empty behaviour: endpoints return [] / null / ok
 * instead of 500 errors when stores haven't been initialised.
 */

import { expect, test } from "./fixtures";

// ---------------------------------------------------------------------------
// Health & config
// ---------------------------------------------------------------------------

test("GET /api/health returns 200 with ok:true and a timestamp", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/health`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(body.ok).toBe(true);
	expect(typeof body.timestamp).toBe("string");
	expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0);
});

test("GET /api/config returns 200 with project config", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/config`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	// The server is started with a temp root that has a config.yaml
	expect(typeof body.project).toBe("object");
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

test("GET /api/agents returns 200 with empty array when no sessions exist", async ({
	request,
	serverUrl,
}) => {
	const res = await request.get(`${serverUrl}/api/agents`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

test("GET /api/agents/active returns 200 with empty array", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/agents/active`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

test("GET /api/agents/:name returns 404 for unknown agent", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/agents/no-such-agent`);
	expect(res.status()).toBe(404);
	const body = await res.json();
	expect(typeof body.error).toBe("string");
});

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

test("GET /api/mail returns 200 with empty array when no mail exists", async ({
	request,
	serverUrl,
}) => {
	const res = await request.get(`${serverUrl}/api/mail`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

test("GET /api/mail/conversations returns 200 with empty array", async ({
	request,
	serverUrl,
}) => {
	const res = await request.get(`${serverUrl}/api/mail/conversations`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

test("GET /api/mail/unread returns 400 when agent param is missing", async ({
	request,
	serverUrl,
}) => {
	const res = await request.get(`${serverUrl}/api/mail/unread`);
	expect(res.status()).toBe(400);
});

test("GET /api/mail/unread returns 200 empty array for known agent", async ({
	request,
	serverUrl,
}) => {
	const res = await request.get(`${serverUrl}/api/mail/unread?agent=coordinator`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

test("POST /api/mail/send creates a mail message and returns 201", async ({
	request,
	serverUrl,
}) => {
	const res = await request.post(`${serverUrl}/api/mail/send`, {
		data: {
			from: "e2e-agent",
			to: "coordinator",
			subject: "E2E test message",
			body: "Sent from Playwright e2e test",
		},
	});
	expect(res.status()).toBe(201);
	const body = await res.json();
	expect(body.from).toBe("e2e-agent");
	expect(body.to).toBe("coordinator");
	expect(body.subject).toBe("E2E test message");
	expect(typeof body.id).toBe("string");
	expect(body.read).toBe(false);
});

test("POST /api/mail/send returns 400 when required fields are missing", async ({
	request,
	serverUrl,
}) => {
	const res = await request.post(`${serverUrl}/api/mail/send`, {
		data: { from: "e2e-agent" }, // missing to, subject, body
	});
	expect(res.status()).toBe(400);
	const body = await res.json();
	expect(typeof body.error).toBe("string");
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test("GET /api/events returns 400 when since param is missing", async ({
	request,
	serverUrl,
}) => {
	const res = await request.get(`${serverUrl}/api/events`);
	expect(res.status()).toBe(400);
});

test("GET /api/events with since param returns 200 with empty array", async ({
	request,
	serverUrl,
}) => {
	const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const res = await request.get(
		`${serverUrl}/api/events?since=${encodeURIComponent(since)}`,
	);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

test("GET /api/events/errors returns 200 with empty array", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/events/errors`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

test("GET /api/metrics returns 200 with empty array", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/metrics`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

test("GET /api/runs returns 200 with empty array", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/runs`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

test("GET /api/runs/active returns 200 with null when no active run", async ({
	request,
	serverUrl,
}) => {
	const res = await request.get(`${serverUrl}/api/runs/active`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(body).toBeNull();
});

// ---------------------------------------------------------------------------
// Merge queue
// ---------------------------------------------------------------------------

test("GET /api/merge-queue returns 200 with empty array", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/merge-queue`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

test("GET /api/issues returns 200 with JSON array", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/issues`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

test("GET /api/issues/ready returns 200 with JSON array", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/issues/ready`);
	expect(res.ok()).toBe(true);
	const body = await res.json();
	expect(Array.isArray(body)).toBe(true);
});

// ---------------------------------------------------------------------------
// Method validation
// ---------------------------------------------------------------------------

test("POST to read-only endpoint returns 405", async ({ request, serverUrl }) => {
	const res = await request.post(`${serverUrl}/api/health`);
	expect(res.status()).toBe(405);
});

test("Unknown /api/* path returns 404", async ({ request, serverUrl }) => {
	const res = await request.get(`${serverUrl}/api/no-such-route`);
	expect(res.status()).toBe(404);
	const body = await res.json();
	expect(body.error).toBe("Not found");
});

// ---------------------------------------------------------------------------
// Static / SPA fallback
// ---------------------------------------------------------------------------

test("GET / returns the SPA index.html (200)", async ({ request, serverUrl }) => {
	const res = await request.get(serverUrl);
	expect(res.ok()).toBe(true);
	const body = await res.text();
	expect(body).toContain("<!DOCTYPE html>");
});

test("GET /unknown-route returns 200 (SPA hash-routing fallback)", async ({
	request,
	serverUrl,
}) => {
	const res = await request.get(`${serverUrl}/this-path-does-not-exist`);
	expect(res.ok()).toBe(true);
});
