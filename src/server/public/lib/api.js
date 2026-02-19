// Legio Web UI — Fetch Helpers
// Thin wrappers around the Fetch API. No Preact dependencies.

/**
 * Fetch a URL as JSON. Throws on non-OK HTTP status.
 */
export async function fetchJson(url) {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} for ${url}`);
	}
	return res.json();
}

/**
 * POST JSON to a URL. Throws on non-OK HTTP status, including error body.
 */
export async function postJson(url, body) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		let msg = `HTTP ${res.status}`;
		try {
			const err = await res.json();
			if (err.error) msg = err.error;
		} catch (_e) {
			// ignore parse failure — use default message
		}
		throw new Error(msg);
	}
	return res.json();
}
