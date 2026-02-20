// Legio Web UI — MessageBubble + ActivityCard components
// Conversational-style message rendering with agent capability color coding.
// No npm dependencies — uses shared preact-setup.js for version consistency.

import { html } from "../lib/preact-setup.js";
import { agentColor, timeAgo } from "../lib/utils.js";

/**
 * MessageBubble — renders a single mail message as a conversational bubble.
 *
 * @param {object} props
 * @param {object} props.msg          - Message object { from, to, body, subject, createdAt, type, priority, read }
 * @param {string} [props.capability] - Agent capability for color coding ("coordinator", "builder", etc.)
 * @param {boolean} [props.isUser]    - True for user-sent messages (right-aligned, accent color)
 * @param {boolean} [props.showName]  - Show sender name + avatar + timestamp header (default true)
 * @param {boolean} [props.compact]   - Tighter padding for grouped messages (default false)
 */
export function MessageBubble({
	msg,
	capability,
	isUser = false,
	showName = true,
	compact = false,
}) {
	const colors = isUser
		? {
				bg: "bg-[#E64415]/10",
				border: "border-[#E64415]",
				text: "text-[#E64415]",
				dot: "bg-[#E64415]",
				avatar: "💬",
			}
		: agentColor(capability);

	// Priority overrides border color
	const borderColor =
		msg.priority === "urgent"
			? "border-red-500"
			: msg.priority === "high"
				? "border-orange-500"
				: colors.border;

	const bubbleClasses = [
		"max-w-[80%]",
		"border border-[#2a2a2a] border-l-2",
		borderColor,
		colors.bg,
		"rounded-sm",
		compact ? "py-1 px-3 mb-0.5" : "p-3 mb-2",
		isUser ? "ml-auto" : "",
	]
		.filter(Boolean)
		.join(" ");

	return html`
		<div class=${bubbleClasses}>
			${
				showName &&
				html`<div class="flex items-center gap-1.5 mb-1">
				<span class="text-base leading-none flex-shrink-0">${colors.avatar}</span>
				<span class=${`text-xs font-semibold ${colors.text}`}>${msg.from || ""}</span>
				<span class="text-xs text-[#555]">${timeAgo(msg.createdAt)}</span>
			</div>`
			}
			<div class="text-sm text-[#e5e5e5] whitespace-pre-wrap break-words">${msg.body || ""}</div>
		</div>
	`;
}

/**
 * Generate a human-readable summary for a mail-type activity message.
 */
function activitySummary(event) {
	if (event.summary) return event.summary;
	switch (event.type) {
		case "dispatch":
			return `Dispatched ${event.to || ""} for ${event.subject || ""}`;
		case "worker_done":
			return `${event.from || event.agent || ""} completed work`;
		case "merge_ready":
			return `${event.from || event.agent || ""} ready to merge`;
		case "merged":
			return `Branch merged: ${event.subject || ""}`;
		case "merge_failed":
			return `Merge failed: ${event.subject || ""}`;
		case "spawned":
			return `Agent spawned: ${event.agent || ""}`;
		case "state_change":
			return `${event.agent || ""}: ${event.from || ""} → ${event.to || ""}`;
		case "removed":
			return `Agent removed: ${event.agent || ""}`;
		default:
			return event.subject || event.type || "";
	}
}

/**
 * ActivityCard — compact centered card for agent activity events.
 *
 * @param {object} props
 * @param {object} props.event      - Activity event or mail message with activity type
 * @param {string} [props.capability] - Agent capability for color coding
 */
export function ActivityCard({ event, capability }) {
	const colors = agentColor(capability ?? event.capability);
	const summary = activitySummary(event);
	const ts = event.timestamp || event.createdAt;

	return html`
		<div
			class="mx-auto max-w-[70%] flex items-center gap-1.5 px-3 py-1 mb-1 rounded bg-[#1a1a1a] border border-[#2a2a2a]"
		>
			<span class="text-xs leading-none flex-shrink-0">${colors.avatar}</span>
			<span class="text-xs text-[#666] truncate">${summary}</span>
			<span class="text-xs text-[#444] flex-shrink-0 ml-auto">${timeAgo(ts)}</span>
		</div>
	`;
}
