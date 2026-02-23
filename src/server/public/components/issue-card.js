// IssueCard — reusable kanban card component
// Used by views/issues.js

import { h, html } from "../lib/preact-setup.js";

// Maps priority number → left border color (hex, for inline style)
const priorityBorderColors = {
	0: "#ef4444",
	1: "#f97316",
	2: "#eab308",
	3: "#3b82f6",
	4: "#6b7280",
};

function timeAgo(isoString) {
	if (!isoString) return "";
	const diff = Date.now() - new Date(isoString).getTime();
	if (diff < 0) return "just now";
	const s = Math.floor(diff / 1000);
	if (s < 60) return s + "s ago";
	const m = Math.floor(s / 60);
	if (m < 60) return m + "m ago";
	const hh = Math.floor(m / 60);
	if (hh < 24) return hh + "h ago";
	return Math.floor(hh / 24) + "d ago";
}

function truncate(str, maxLen) {
	if (!str) return "";
	return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + "...";
}

export function IssueCard({ issue }) {
	const borderColor = priorityBorderColors[issue.priority] ?? "#6b7280";
	const hasBlockedBy = Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0;
	const isClosed = issue.status === "closed";

	function handleClick() {
		if (isClosed) return;
		location.hash = "task/" + issue.id;
	}

	return html`
		<div
			class=${`bg-[#1a1a1a] border border-[#2a2a2a] border-l-4 rounded-sm p-3${isClosed ? " opacity-50" : " cursor-pointer hover:border-[#3a3a3a] hover:bg-[#222]"}`}
			style=${{ borderLeftColor: borderColor }}
			onClick=${isClosed ? undefined : handleClick}
		>
			<div class="flex items-start justify-between gap-2 mb-1">
				<span class="flex items-center gap-1">
					${hasBlockedBy ? html`<span class="text-xs">⚠️</span>` : null}
					<span class=${`text-xs font-mono${hasBlockedBy ? " text-red-400" : " text-[#999]"}`}>${issue.id || ""}</span>
					${isClosed ? html`<span class="text-xs bg-green-900/40 text-green-400 rounded px-1">Closed</span>` : null}
				</span>
				${issue.priority != null ? html`<span class="text-[#999] text-xs">P${issue.priority}</span>` : null}
			</div>
			<div class=${`text-[#e5e5e5] font-medium text-sm mb-1${isClosed ? " line-through" : ""}`}>
				${truncate(issue.title || "", 60)}
			</div>
			${
				isClosed && issue.closeReason
					? html`
				<div class="text-[#666] text-xs mb-1 italic">
					${truncate(issue.closeReason, 80)}
				</div>
			`
					: null
			}
			${
				issue.description
					? html`
				<div class="text-[#999] text-xs mb-2 leading-relaxed">
					${truncate(issue.description, 120)}
				</div>
			`
					: null
			}
			<div class="flex items-center gap-2 flex-wrap">
				${issue.type ? html`<span class="text-xs bg-[#2a2a2a] rounded px-1 text-[#999]">${issue.type}</span>` : null}
				${issue.assignee ? html`<span class="text-[#999] text-xs">${issue.assignee}</span>` : null}
				${issue.createdAt ? html`<span class="text-[#999] text-xs">${timeAgo(issue.createdAt)}</span>` : null}
			</div>
			${
				hasBlockedBy
					? html`
				<div class="mt-1 text-xs text-red-500">
					blocked by: ${issue.blockedBy.join(", ")}
				</div>
			`
					: null
			}
		</div>
	`;
}

export default IssueCard;
