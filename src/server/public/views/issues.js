// views/issues.js — Kanban board for beads issues
// Exports IssuesView (Preact component) and sets window.renderIssues (legacy shim)

import { h, html, useState } from "../lib/preact-setup.js";
import { IssueCard } from "../components/issue-card.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
	if (str == null) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function truncate(str, maxLen) {
	if (!str) return "";
	return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + "...";
}

// Priority border colors (hex) for the inline-style approach used by shim
const priorityBorderHex = {
	0: "#ef4444",
	1: "#f97316",
	2: "#eab308",
	3: "#3b82f6",
	4: "#6b7280",
};

// Separate issues into the 4 kanban columns
function categorize(issues) {
	const open = [];
	const inProgress = [];
	const blocked = [];
	const closed = [];
	for (const issue of issues) {
		const status = issue.status || "";
		const hasBlockers = Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0;
		if (status === "in_progress") inProgress.push(issue);
		else if (status === "closed") closed.push(issue);
		else if (status === "open" && hasBlockers) blocked.push(issue);
		else open.push(issue);
	}
	return { open, inProgress, blocked, closed };
}

// ── Preact sub-component: Column ───────────────────────────────────────────

function Column({ title, issues, borderClass }) {
	return html`
		<div class="flex-1 min-w-[240px] flex flex-col">
			<div class=${`border-t-2 ${borderClass} bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm px-3 py-2 mb-2 flex items-center gap-2`}>
				<span class="text-[#e5e5e5] text-sm font-medium">${title}</span>
				<span class="bg-[#2a2a2a] text-[#999] text-xs rounded-full px-2">${issues.length}</span>
			</div>
			<div class="flex flex-col gap-2">
				${issues.length === 0
					? html`<div class="text-[#999] text-sm text-center py-4">No issues</div>`
					: issues.map((issue) => html`<${IssueCard} key=${issue.id} issue=${issue} />`)}
			</div>
		</div>
	`;
}

// ── Preact component: IssuesView ───────────────────────────────────────────

export function IssuesView({ issues = [] }) {
	// null = show all priorities
	const [priorityFilter, setPriorityFilter] = useState(null);

	const filtered =
		priorityFilter == null ? issues : issues.filter((i) => i.priority === priorityFilter);

	const { open, inProgress, blocked, closed } = categorize(filtered);

	const filterButtons = [null, 0, 1, 2, 3, 4];

	return html`
		<div class="p-4">
			<!-- Priority filter bar -->
			<div class="flex items-center gap-2 mb-4">
				${filterButtons.map((p) => {
					const active = priorityFilter === p;
					const label = p == null ? "All" : "P" + p;
					return html`
						<button
							key=${label}
							class=${active
								? "px-2 py-1 text-xs rounded-sm border border-[#E64415] text-[#E64415] bg-[#E64415]/10"
								: "px-2 py-1 text-xs rounded-sm border border-[#2a2a2a] text-[#999] hover:border-[#444]"}
							onClick=${() => setPriorityFilter(p)}
						>
							${label}
						</button>
					`;
				})}
			</div>

			<!-- Kanban board -->
			<div class="flex gap-4 overflow-x-auto pb-4">
				<${Column} title="Open" issues=${open} borderClass="border-blue-500" />
				<${Column} title="In Progress" issues=${inProgress} borderClass="border-yellow-500" />
				<${Column} title="Blocked" issues=${blocked} borderClass="border-red-500" />
				<${Column} title="Closed" issues=${closed} borderClass="border-green-500" />
			</div>
		</div>
	`;
}

// ── Legacy global shim for the existing app.js router ─────────────────────
// Uses innerHTML to render the kanban board without requiring a Preact root.

function renderIssueCardHtml(issue) {
	const borderColor = priorityBorderHex[issue.priority] ?? "#6b7280";
	const hasBlockedBy = Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0;
	return `
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] border-l-4 rounded-sm p-3" style="border-left-color: ${borderColor}">
			<div class="flex items-start justify-between gap-2 mb-1">
				<span class="text-[#999] text-xs font-mono">${escapeHtml(issue.id || "")}</span>
				${issue.priority != null ? `<span class="text-[#999] text-xs">P${issue.priority}</span>` : ""}
			</div>
			<div class="text-[#e5e5e5] font-medium text-sm mb-2">${escapeHtml(truncate(issue.title || "", 60))}</div>
			<div class="flex items-center gap-2 flex-wrap">
				${issue.type ? `<span class="text-xs bg-[#2a2a2a] rounded px-1 text-[#999]">${escapeHtml(issue.type)}</span>` : ""}
				${issue.assignee ? `<span class="text-[#999] text-xs">${escapeHtml(issue.assignee)}</span>` : ""}
			</div>
			${hasBlockedBy ? `<div class="mt-1 text-xs text-red-500">blocked by: ${escapeHtml(issue.blockedBy.join(", "))}</div>` : ""}
		</div>`;
}

function renderColumnHtml(title, issues, borderClass) {
	const cards =
		issues.length === 0
			? `<div class="text-[#999] text-sm text-center py-4">No issues</div>`
			: issues.map(renderIssueCardHtml).join("");
	return `
		<div class="flex-1 min-w-[240px]">
			<div class="border-t-2 ${borderClass} bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm px-3 py-2 mb-2 flex items-center gap-2">
				<span class="text-[#e5e5e5] text-sm font-medium">${escapeHtml(title)}</span>
				<span class="bg-[#2a2a2a] text-[#999] text-xs rounded-full px-2">${issues.length}</span>
			</div>
			<div class="flex flex-col gap-2">${cards}</div>
		</div>`;
}

window.renderIssues = function (appState, el) {
	const issues = appState.issues || [];
	const priorityFilter = el.dataset.priorityFilter || "all";

	const filtered =
		priorityFilter === "all"
			? issues
			: issues.filter((i) => String(i.priority) === priorityFilter);

	const { open, inProgress, blocked, closed } = categorize(filtered);

	const filterButtons = [
		{ key: "all", label: "All" },
		{ key: "0", label: "P0" },
		{ key: "1", label: "P1" },
		{ key: "2", label: "P2" },
		{ key: "3", label: "P3" },
		{ key: "4", label: "P4" },
	];

	const filterBtnsHtml = filterButtons
		.map(({ key, label }) => {
			const active = priorityFilter === key;
			const cls = active
				? "border-[#E64415] text-[#E64415] bg-[#E64415]/10"
				: "border-[#2a2a2a] text-[#999]";
			return `<button class="px-2 py-1 text-xs rounded-sm border ${cls}" data-priority="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
		})
		.join("");

	const columnsHtml = [
		renderColumnHtml("Open", open, "border-blue-500"),
		renderColumnHtml("In Progress", inProgress, "border-yellow-500"),
		renderColumnHtml("Blocked", blocked, "border-red-500"),
		renderColumnHtml("Closed", closed, "border-green-500"),
	].join("");

	el.innerHTML = `
		<div class="p-4">
			<div class="flex items-center gap-2 mb-4">${filterBtnsHtml}</div>
			<div class="flex gap-4 overflow-x-auto pb-4">${columnsHtml}</div>
		</div>`;

	// Wire up filter button click handlers
	el.querySelectorAll("button[data-priority]").forEach((btn) => {
		btn.addEventListener("click", () => {
			el.dataset.priorityFilter = btn.getAttribute("data-priority") || "all";
			window.renderIssues(appState, el);
		});
	});
};
