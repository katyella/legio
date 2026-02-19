// dashboard.js — Dashboard view component (Preact+HTM)
// 4-panel grid: Agents table, Recent Mail, Merge Queue, Metrics strip.

import { html } from "../lib/preact-setup.js";
import { formatDuration, timeAgo, truncate } from "../lib/utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_ORDER = { working: 0, booting: 1, stalled: 2, completed: 3, zombie: 4 };

const STATE_ICON = {
	working: "●",
	booting: "◐",
	stalled: "⚠",
	completed: "✓",
	zombie: "○",
};

const STATE_COLOR = {
	working: "text-green-500",
	booting: "text-yellow-500",
	stalled: "text-red-500",
	completed: "text-gray-500",
	zombie: "text-gray-600",
};

const PRIORITY_COLOR = {
	low: "text-gray-500",
	normal: "text-blue-400",
	high: "text-yellow-500",
	urgent: "text-red-500",
};

const MERGE_STATUS_COLOR = {
	pending: "text-yellow-500",
	merging: "text-green-500",
	merged: "text-gray-500",
	conflict: "text-red-500",
	failed: "text-red-500",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortAgents(agents) {
	return [...agents].sort((a, b) => {
		const aOrder = STATE_ORDER[a.state] ?? 3;
		const bOrder = STATE_ORDER[b.state] ?? 3;
		if (aOrder !== bOrder) return aOrder - bOrder;
		return (a.agentName || "").localeCompare(b.agentName || "");
	});
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AgentsTable({ agents }) {
	const sorted = sortAgents(agents);

	return html`
		<div class="bg-surface border border-border rounded-sm col-span-10">
			<div class="border-b border-border px-4 py-2 text-xs font-bold uppercase tracking-wider text-gray-400">
				Agents
			</div>
			<div class="overflow-x-auto overflow-y-auto max-h-[60vh]">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-border text-left text-xs text-gray-400">
							<th class="px-4 py-2">State</th>
							<th class="px-4 py-2">Name</th>
							<th class="px-4 py-2">Capability</th>
							<th class="px-4 py-2">Task</th>
							<th class="px-4 py-2">Duration</th>
						</tr>
					</thead>
					<tbody>
						${sorted.length === 0
							? html`<tr>
									<td colspan="5" class="px-4 py-6 text-center text-gray-500">No agents</td>
								</tr>`
							: sorted.map(
									(agent) => html`
										<tr key=${agent.agentName} class="border-b border-border/50 hover:bg-white/5">
											<td class="px-4 py-2">
												<span class=${STATE_COLOR[agent.state] || "text-gray-400"}>
													${STATE_ICON[agent.state] || "?"}
												</span>
											</td>
											<td class="px-4 py-2">
												<a
													href=${`#inspect/${agent.agentName}`}
													class="text-blue-400 hover:text-blue-300"
												>
													${agent.agentName}
												</a>
											</td>
											<td class="px-4 py-2 text-gray-400">${agent.capability || ""}</td>
											<td class="px-4 py-2 font-mono text-xs text-gray-400">${agent.beadId || ""}</td>
											<td class="px-4 py-2 font-mono text-xs text-gray-400">
												${agent.startedAt
													? formatDuration(Date.now() - new Date(agent.startedAt).getTime())
													: "—"}
											</td>
										</tr>
									`,
								)}
					</tbody>
				</table>
			</div>
		</div>
	`;
}

function RecentMail({ mail }) {
	const sorted = [...mail]
		.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
		.slice(0, 10);

	return html`
		<div class="bg-surface border border-border rounded-sm col-span-6">
			<div class="border-b border-border px-4 py-2 text-xs font-bold uppercase tracking-wider text-gray-400">
				Recent Mail
			</div>
			<div class="p-2 space-y-1 overflow-y-auto max-h-[40vh]">
				${sorted.length === 0
					? html`<div class="px-2 py-6 text-center text-gray-500">No messages</div>`
					: sorted.map(
							(msg) => html`
								<div
									key=${msg.id}
									class="flex items-center gap-3 px-2 py-1 text-sm hover:bg-white/5 rounded-sm"
								>
									<span class=${PRIORITY_COLOR[msg.priority || "normal"] || "text-blue-400"}>●</span>
									<span class="text-gray-400 shrink-0">${msg.from || ""} → ${msg.to || ""}</span>
									<span class="flex-1 truncate">${truncate(msg.subject || "", 40)}</span>
									<span class="text-gray-500 shrink-0 text-xs">${timeAgo(msg.createdAt)}</span>
								</div>
							`,
						)}
			</div>
		</div>
	`;
}

function MergeQueue({ mergeQueue }) {
	return html`
		<div class="bg-surface border border-border rounded-sm col-span-4">
			<div class="border-b border-border px-4 py-2 text-xs font-bold uppercase tracking-wider text-gray-400">
				Merge Queue
			</div>
			<div class="p-2 space-y-1 overflow-y-auto max-h-[40vh]">
				${mergeQueue.length === 0
					? html`<div class="px-2 py-6 text-center text-gray-500">Queue is empty</div>`
					: mergeQueue.map(
							(entry) => html`
								<div
									key=${entry.agentName + entry.branchName}
									class="flex items-center gap-3 px-2 py-1 text-sm hover:bg-white/5 rounded-sm"
								>
									<span class=${MERGE_STATUS_COLOR[entry.status] || "text-gray-400"}>●</span>
									<span class="shrink-0">${entry.agentName || ""}</span>
									<span class="flex-1 truncate font-mono text-xs text-gray-400">
										${entry.branchName || ""}
									</span>
									<span class="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-xs text-gray-400">
										${entry.status || ""}
									</span>
								</div>
							`,
						)}
			</div>
		</div>
	`;
}

function MetricsStrip({ agents, mergeQueue, status }) {
	const totalSessions = agents.length;
	const activeCount = agents.filter((a) => a.state === "working" || a.state === "booting").length;
	const completedCount = agents.filter((a) => a.state === "completed").length;
	const unreadMail = status?.unreadMailCount ?? 0;
	const pendingMerges = status?.mergeQueueCount ?? mergeQueue.length;

	const stats = [
		{ label: "Sessions", value: totalSessions },
		{ label: "Active", value: activeCount },
		{ label: "Completed", value: completedCount },
		{ label: "Unread Mail", value: unreadMail },
		{ label: "Pending Merges", value: pendingMerges },
	];

	return html`
		<div class="bg-surface border border-border rounded-sm col-span-10">
			<div class="border-b border-border px-4 py-2 text-xs font-bold uppercase tracking-wider text-gray-400">
				Metrics
			</div>
			<div class="flex flex-wrap gap-8 px-4 py-3">
				${stats.map(
					({ label, value }) => html`
						<span key=${label} class="text-sm text-gray-400">
							${label}:${" "}<strong class="text-white">${value}</strong>
						</span>
					`,
				)}
			</div>
		</div>
	`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function DashboardView({ agents = [], mail = [], mergeQueue = [], status = null }) {
	return html`
		<div class="grid grid-cols-10 gap-4 p-4">
			<${AgentsTable} agents=${agents} />
			<${RecentMail} mail=${mail} />
			<${MergeQueue} mergeQueue=${mergeQueue} />
			<${MetricsStrip} agents=${agents} mergeQueue=${mergeQueue} status=${status} />
		</div>
	`;
}
