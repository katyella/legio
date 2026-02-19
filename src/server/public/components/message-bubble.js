// Legio Web UI — MessageBubble component
// Preact+HTM component for rendering a single mail message as a styled bubble.
// No npm dependencies — uses CDN imports. Served as a static ES module.

import { h } from "https://esm.sh/preact@latest";
import htm from "https://esm.sh/htm@latest";

const html = htm.bind(h);

// Type badge color mapping (Tailwind utility classes, Spiegel dark theme)
const TYPE_COLORS = {
	status: "bg-[#333] text-[#999]",
	question: "bg-blue-900/50 text-blue-400",
	result: "bg-green-900/50 text-green-400",
	error: "bg-red-900/50 text-red-400",
	worker_done: "bg-green-900/50 text-green-400",
	merge_ready: "bg-blue-900/50 text-blue-400",
	dispatch: "bg-yellow-900/50 text-yellow-400",
	merged: "bg-green-900/50 text-green-400",
	merge_failed: "bg-red-900/50 text-red-400",
	escalation: "bg-orange-900/50 text-orange-400",
	health_check: "bg-gray-800 text-gray-400",
	assign: "bg-yellow-900/50 text-yellow-400",
};

function timeAgo(isoString) {
	if (!isoString) return "";
	const diff = Date.now() - new Date(isoString).getTime();
	if (diff < 0) return "just now";
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const hh = Math.floor(m / 60);
	if (hh < 24) return `${hh}h ago`;
	const d = Math.floor(hh / 24);
	return `${d}d ago`;
}

/**
 * MessageBubble — renders a single MailMessage as a styled bubble.
 *
 * @param {object} props
 * @param {object} props.msg          - MailMessage object
 * @param {boolean} props.isReply     - Whether this is a thread reply (indented)
 * @param {string|null} props.selectedAgent - Currently selected agent name (or null)
 * @param {object|null} props.selectedPair  - { agent1, agent2 } or null
 */
export function MessageBubble({ msg, isReply, selectedAgent, selectedPair }) {
	// Determine bubble alignment
	const isRight = selectedPair
		? msg.from === selectedPair.agent1
		: selectedAgent
			? msg.from === selectedAgent
			: false;

	// Show @mention tag only in "all messages" mode (no agent/pair filter)
	const showMention = !selectedAgent && !selectedPair;

	const typeColor = TYPE_COLORS[msg.type] || "bg-[#333] text-[#999]";
	const typeBadgeClass = `text-xs px-1.5 py-0.5 rounded ${typeColor}`;

	const hasPriority = msg.priority && msg.priority !== "normal" && msg.priority !== "low";
	const priorityBadgeClass =
		msg.priority === "urgent"
			? "text-xs px-1.5 py-0.5 rounded bg-red-900/50 text-red-400"
			: "text-xs px-1.5 py-0.5 rounded bg-orange-900/50 text-orange-400";

	const bubbleClasses = [
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm p-3 mb-2",
		isReply ? "ml-6 border-l-2 border-[#2a2a2a]" : "",
		isRight ? "ml-8" : "",
	]
		.filter(Boolean)
		.join(" ");

	return html`
		<div class=${bubbleClasses}>
			<div class="flex items-center gap-2 mb-1 flex-wrap">
				<span class="font-bold text-[#e5e5e5]">${msg.from || ""}</span>
				${showMention &&
				html`<span class="text-xs bg-[#E64415]/20 text-[#E64415] px-1 rounded"
					>@${msg.to || ""}</span
				>`}
				<span class=${typeBadgeClass}>${msg.type || ""}</span>
				${hasPriority &&
				html`<span class=${priorityBadgeClass}>${msg.priority}</span>`}
			</div>
			<div class="font-semibold text-[#e5e5e5] text-sm">${msg.subject || ""}</div>
			<div class="text-sm text-[#999] mt-1 whitespace-pre-wrap">${msg.body || ""}</div>
			<div class="text-xs text-[#666] mt-1">${timeAgo(msg.createdAt)}</div>
		</div>
	`;
}
