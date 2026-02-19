// Legio Web UI — Utility Functions
// Pure functions with no external dependencies.

/**
 * Format a duration in milliseconds to a human-readable string.
 * e.g. 500 -> "< 1s", 5000 -> "5s", 90000 -> "1m 30s", 3700000 -> "1h 1m"
 */
export function formatDuration(ms) {
	if (ms < 1000) return "< 1s";
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (h > 0) return `${h}h ${m % 60}m`;
	if (m > 0) return `${m}m ${s % 60}s`;
	return `${s}s`;
}

/**
 * Return a human-readable relative time from an ISO date string.
 * e.g. "2m ago", "1h ago", "3d ago"
 */
export function timeAgo(isoString) {
	if (!isoString) return "";
	const diff = Date.now() - new Date(isoString).getTime();
	if (diff < 0) return "just now";
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

/**
 * Truncate a string to maxLen characters, appending "..." if needed.
 */
export function truncate(str, maxLen) {
	if (!str) return "";
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 3)}...`;
}

/**
 * Escape HTML special characters to prevent XSS in template literals.
 * Always use this before inserting user-controlled content into innerHTML.
 */
export function escapeHtml(str) {
	if (str == null) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Return a Unicode icon for an agent state.
 */
export function stateIcon(agentState) {
	switch (agentState) {
		case "working":
			return "●";
		case "booting":
			return "◐";
		case "stalled":
			return "⚠";
		case "zombie":
			return "○";
		case "completed":
			return "✓";
		default:
			return "?";
	}
}

/**
 * Return a Tailwind text color class for an agent state.
 */
export function stateColor(agentState) {
	switch (agentState) {
		case "working":
			return "text-green-500";
		case "booting":
			return "text-yellow-500";
		case "stalled":
			return "text-red-500";
		case "zombie":
			return "text-gray-500";
		case "completed":
			return "text-blue-500";
		default:
			return "text-gray-500";
	}
}

/**
 * Return a Tailwind text color class for a message priority.
 */
export function priorityColor(priority) {
	switch (priority) {
		case "urgent":
			return "text-red-500";
		case "high":
			return "text-orange-400";
		case "normal":
			return "text-gray-300";
		case "low":
			return "text-gray-500";
		default:
			return "text-gray-300";
	}
}
