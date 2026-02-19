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

// ===== Agent Color Coding =====
// Each agent capability gets a distinct color applied to borders, badges, and dots.
// coordinator=blue, lead=green, builder=purple, scout=orange, reviewer=teal

const AGENT_COLORS = {
	coordinator: {
		bg: "bg-blue-500/10",
		border: "border-blue-500",
		text: "text-blue-400",
		dot: "bg-blue-500",
	},
	lead: {
		bg: "bg-green-500/10",
		border: "border-green-500",
		text: "text-green-400",
		dot: "bg-green-500",
	},
	builder: {
		bg: "bg-purple-500/10",
		border: "border-purple-500",
		text: "text-purple-400",
		dot: "bg-purple-500",
	},
	scout: {
		bg: "bg-orange-500/10",
		border: "border-orange-500",
		text: "text-orange-400",
		dot: "bg-orange-500",
	},
	reviewer: {
		bg: "bg-teal-500/10",
		border: "border-teal-500",
		text: "text-teal-400",
		dot: "bg-teal-500",
	},
};

const DEFAULT_AGENT_COLOR = {
	bg: "bg-gray-500/10",
	border: "border-gray-500",
	text: "text-gray-400",
	dot: "bg-gray-500",
};

/**
 * Return the color set for a given agent capability.
 * Returns DEFAULT_AGENT_COLOR if capability is falsy or not recognized.
 */
export function agentColor(capability) {
	if (!capability) return DEFAULT_AGENT_COLOR;
	return AGENT_COLORS[capability.toLowerCase()] ?? DEFAULT_AGENT_COLOR;
}

/**
 * Infer agent capability from agent name or agents array.
 * Rules (in priority order):
 *   1. "coordinator" or "orchestrator" → "coordinator"
 *   2. Found in agents array → return agent.capability
 *   3. Name pattern: -lead → "lead", -builder → "builder", -scout → "scout",
 *      review- prefix or -reviewer → "reviewer"
 *   4. null if no match
 */
export function inferCapability(agentName, agents) {
	if (!agentName) return null;
	const lower = agentName.toLowerCase();
	if (lower === "coordinator" || lower === "orchestrator") return "coordinator";
	if (agents && agents.length > 0) {
		const found = agents.find((a) => a.agentName === agentName || a.name === agentName);
		if (found?.capability) return found.capability;
	}
	if (lower.endsWith("-lead")) return "lead";
	if (lower.endsWith("-builder")) return "builder";
	if (lower.endsWith("-scout")) return "scout";
	if (lower.startsWith("review-") || lower.endsWith("-reviewer")) return "reviewer";
	return null;
}

/** Mail types that represent agent activity events (not conversational messages). */
export const ACTIVITY_MAIL_TYPES = new Set([
	"dispatch",
	"worker_done",
	"merge_ready",
	"merged",
	"merge_failed",
	"health_check",
	"assign",
]);

/**
 * Returns true if the given message is an activity-type message.
 */
export function isActivityMessage(msg) {
	return ACTIVITY_MAIL_TYPES.has(msg?.type);
}
