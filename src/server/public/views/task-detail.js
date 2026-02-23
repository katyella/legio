// views/task-detail.js — Task detail view with Overview, Agents, Communication tabs
// Exports TaskDetailView (Preact component)

import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";

// ── Utilities ──────────────────────────────────────────────────────────────

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

function formatDate(isoString) {
	if (!isoString) return "—";
	const d = new Date(isoString);
	return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms) {
	if (ms == null || ms < 0) return "—";
	if (ms < 1000) return "< 1s";
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const hh = Math.floor(m / 60);
	if (hh > 0) return hh + "h " + (m % 60) + "m";
	if (m > 0) return m + "m " + (s % 60) + "s";
	return s + "s";
}

// ── Badge helpers ──────────────────────────────────────────────────────────

function statusBadge(status) {
	const cfg = {
		open: "text-blue-400 bg-blue-400/10",
		in_progress: "text-yellow-400 bg-yellow-400/10",
		blocked: "text-red-400 bg-red-400/10",
		closed: "text-green-400 bg-green-400/10",
	};
	const cls = cfg[status] ?? "text-[#999] bg-[#2a2a2a]";
	return html`<span class=${`text-xs px-2 py-0.5 rounded-sm font-medium ${cls}`}>${status ?? "unknown"}</span>`;
}

function priorityBadge(priority) {
	if (priority == null) return null;
	const colors = ["text-red-400", "text-orange-400", "text-yellow-400", "text-blue-400", "text-[#888]"];
	const cls = colors[priority] ?? "text-[#888]";
	return html`<span class=${`text-xs font-mono ${cls}`}>P${priority}</span>`;
}

function mailTypeBadge(type) {
	const cfg = {
		status: "text-blue-400 bg-blue-400/10",
		question: "text-yellow-400 bg-yellow-400/10",
		result: "text-green-400 bg-green-400/10",
		error: "text-red-400 bg-red-400/10",
		worker_done: "text-green-400 bg-green-400/10",
		dispatch: "text-[#999] bg-[#2a2a2a]",
	};
	const cls = cfg[type] ?? "text-[#999] bg-[#2a2a2a]";
	return html`<span class=${`text-xs px-2 py-0.5 rounded-sm ${cls}`}>${type ?? "—"}</span>`;
}

const agentStateBadgeClasses = {
	working: "text-green-500 bg-green-500/10",
	booting: "text-yellow-500 bg-yellow-500/10",
	stalled: "text-red-500 bg-red-500/10",
	zombie: "text-gray-500 bg-gray-500/10",
	completed: "text-blue-500 bg-blue-500/10",
};

// ── Tab definitions ────────────────────────────────────────────────────────

const TABS = ["Overview", "Agents", "Communication"];

// ── Sub-components ─────────────────────────────────────────────────────────

function MetaCard({ label, children }) {
	return html`
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm p-3">
			<div class="text-[#999] text-xs mb-1">${label}</div>
			<div class="text-[#e5e5e5] text-sm">${children}</div>
		</div>
	`;
}

function OverviewTab({ issue }) {
	const blockedBy = Array.isArray(issue.blockedBy) ? issue.blockedBy : [];

	return html`
		<div>
			<!-- Description -->
			<h3 class="text-sm font-semibold text-[#999] uppercase tracking-wide mb-2">Description</h3>
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm p-4 mb-6">
				${
					issue.description
						? html`<p class="text-[#e5e5e5] text-sm leading-relaxed whitespace-pre-wrap">${issue.description}</p>`
						: html`<p class="text-[#555] text-sm italic">No description</p>`
				}
			</div>

			<!-- Metadata cards -->
			<h3 class="text-sm font-semibold text-[#999] uppercase tracking-wide mb-2">Metadata</h3>
			<div class="grid grid-cols-2 gap-2 mb-6 sm:grid-cols-3">
				<${MetaCard} label="Status">${statusBadge(issue.status)}</${MetaCard}>
				<${MetaCard} label="Priority">${priorityBadge(issue.priority) ?? html`<span class="text-[#555]">—</span>`}</${MetaCard}>
				<${MetaCard} label="Type">
					${issue.type ? html`<span class="bg-[#2a2a2a] rounded px-1 text-[#999] text-xs">${issue.type}</span>` : html`<span class="text-[#555]">—</span>`}
				</${MetaCard}>
				<${MetaCard} label="Assignee">
					<span class="text-[#e5e5e5]">${issue.assignee ?? "—"}</span>
				</${MetaCard}>
				<${MetaCard} label="Owner">
					<span class="text-[#e5e5e5]">${issue.owner ?? "—"}</span>
				</${MetaCard}>
				<${MetaCard} label="Created">
					<span class="text-[#e5e5e5]">${formatDate(issue.createdAt)}</span>
				</${MetaCard}>
				${
					issue.closedAt
						? html`<${MetaCard} label="Closed"><span class="text-[#e5e5e5]">${formatDate(issue.closedAt)}</${MetaCard}>`
						: null
				}
			</div>

			<!-- Blocked by -->
			${
				blockedBy.length > 0
					? html`
				<h3 class="text-sm font-semibold text-[#999] uppercase tracking-wide mb-2">Blocked By</h3>
				<div class="flex flex-wrap gap-2 mb-6">
					${blockedBy.map(
						(id) => html`
						<a
							key=${id}
							href=${"#task/" + id}
							class="font-mono text-xs bg-red-900/20 text-red-400 border border-red-900/40 rounded px-2 py-1 hover:bg-red-900/30"
						>${id}</a>
					`,
					)}
				</div>
			`
					: null
			}
		</div>
	`;
}

function AgentsTab({ agents, taskId }) {
	const filtered = agents.filter((a) => {
		const session = a.session || a;
		return (
			(session.beadId && session.beadId === taskId) ||
			(session.agentName && session.agentName.includes(taskId))
		);
	});

	// Sort: active states first, then completed
	const sorted = [...filtered].sort((a, b) => {
		const stateOrder = { working: 0, booting: 1, stalled: 2, zombie: 3, completed: 4 };
		const sa = a.session || a;
		const sb = b.session || b;
		return (stateOrder[sa.state] ?? 5) - (stateOrder[sb.state] ?? 5);
	});

	if (sorted.length === 0) {
		return html`
			<div class="flex items-center justify-center h-32 text-[#555] text-sm">
				No agents found for task ${taskId}
			</div>
		`;
	}

	return html`
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-[#2a2a2a]">
						<th class="text-left text-[#999] text-xs px-3 py-2 font-medium">Agent</th>
						<th class="text-left text-[#999] text-xs px-3 py-2 font-medium">Capability</th>
						<th class="text-left text-[#999] text-xs px-3 py-2 font-medium">State</th>
						<th class="text-left text-[#999] text-xs px-3 py-2 font-medium">Duration</th>
						<th class="text-left text-[#999] text-xs px-3 py-2 font-medium">Branch</th>
					</tr>
				</thead>
				<tbody>
					${sorted.map((a) => {
						const session = a.session || a;
						const dur = session.startedAt ? Date.now() - new Date(session.startedAt).getTime() : null;
						const badgeCls = agentStateBadgeClasses[session.state] ?? "text-gray-500 bg-gray-500/10";
						return html`
							<tr key=${session.agentName} class="border-b border-[#2a2a2a] last:border-0">
								<td class="px-3 py-2">
									<a
										href=${"#inspect/" + (session.agentName ?? "")}
										class="font-mono text-[#E64415] hover:text-[#ff6633] text-xs"
									>${session.agentName ?? "—"}</a>
								</td>
								<td class="px-3 py-2 text-[#999] text-xs">${session.capability ?? "—"}</td>
								<td class="px-3 py-2">
									<span class=${`text-xs px-2 py-0.5 rounded-sm ${badgeCls}`}>${session.state ?? "—"}</span>
								</td>
								<td class="px-3 py-2 text-[#999] text-xs font-mono">${dur != null ? formatDuration(dur) : "—"}</td>
								<td class="px-3 py-2 font-mono text-[#999] text-xs">${session.branchName ?? "—"}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
		</div>
	`;
}

function CommunicationTab({ mail, taskId }) {
	const [expandedId, setExpandedId] = useState(null);

	const filtered = mail.filter((m) => {
		const subject = (m.subject ?? "").toLowerCase();
		const body = (m.body ?? "").toLowerCase();
		const id = taskId.toLowerCase();
		return subject.includes(id) || body.includes(id);
	});

	// Sort chronologically (oldest first)
	const sorted = [...filtered].sort((a, b) => {
		const ta = a.createdAt ?? a.sentAt ?? "";
		const tb = b.createdAt ?? b.sentAt ?? "";
		return ta < tb ? -1 : ta > tb ? 1 : 0;
	});

	if (sorted.length === 0) {
		return html`
			<div class="flex items-center justify-center h-32 text-[#555] text-sm">
				No messages found for task ${taskId}
			</div>
		`;
	}

	return html`
		<div class="flex flex-col gap-1">
			${sorted.map((msg) => {
				const msgId = msg.id ?? msg.messageId ?? Math.random().toString();
				const isExpanded = expandedId === msgId;
				return html`
					<div
						key=${msgId}
						class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm overflow-hidden"
					>
						<div
							class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-[#222]"
							onClick=${() => setExpandedId(isExpanded ? null : msgId)}
						>
							<span class="text-[#555] text-xs font-mono shrink-0 w-20">
								${timeAgo(msg.createdAt ?? msg.sentAt)}
							</span>
							${mailTypeBadge(msg.type)}
							<span class="text-[#999] text-xs shrink-0">
								<span class="text-[#666]">from</span> ${msg.from ?? "—"}
								<span class="text-[#666]"> to</span> ${msg.to ?? "—"}
							</span>
							<span class="text-[#e5e5e5] text-sm flex-1 truncate">${msg.subject ?? ""}</span>
							<span class="text-[#555] text-xs shrink-0">${isExpanded ? "▲" : "▼"}</span>
						</div>
						${
							isExpanded
								? html`
							<div class="border-t border-[#2a2a2a] px-3 py-3">
								<pre class="text-[#e5e5e5] text-xs leading-relaxed whitespace-pre-wrap break-words font-mono m-0">${msg.body ?? ""}</pre>
							</div>
						`
								: null
						}
					</div>
				`;
			})}
		</div>
	`;
}

// ── Main view ──────────────────────────────────────────────────────────────

export function TaskDetailView({ taskId }) {
	const [issue, setIssue] = useState(null);
	const [agents, setAgents] = useState([]);
	const [mail, setMail] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [activeTab, setActiveTab] = useState("Overview");
	const intervalRef = useRef(null);

	const fetchAll = useCallback(async () => {
		if (!taskId) return;
		try {
			const [issueRes, agentsRes, mailRes] = await Promise.all([
				fetch(`/api/issues/${encodeURIComponent(taskId)}`).then((r) => {
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					return r.json();
				}),
				fetch("/api/agents").then((r) => (r.ok ? r.json() : [])),
				fetch("/api/mail").then((r) => {
					if (!r.ok) return [];
					return r.json().then((d) => (Array.isArray(d) ? d : (d?.recent ?? [])));
				}),
			]);
			setIssue(issueRes);
			setAgents(Array.isArray(agentsRes) ? agentsRes : []);
			setMail(Array.isArray(mailRes) ? mailRes : []);
			setLoading(false);
			setError(null);
		} catch (e) {
			setError(String(e));
			setLoading(false);
		}
	}, [taskId]);

	useEffect(() => {
		if (!taskId) return;
		setLoading(true);
		setError(null);
		fetchAll();
		intervalRef.current = setInterval(fetchAll, 5000);
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [taskId, fetchAll]);

	if (!taskId) {
		return html`
			<div class="flex items-center justify-center h-64 text-[#555]">No task selected</div>
		`;
	}

	if (loading) {
		return html`
			<div class="flex items-center justify-center h-64 text-[#999]">Loading ${taskId}…</div>
		`;
	}

	if (error) {
		return html`
			<div class="p-4">
				<a href="#tasks" class="text-[#E64415] text-sm hover:underline">← Back to Tasks</a>
				<div class="mt-4 text-red-500 text-sm">Failed to load task: ${error}</div>
			</div>
		`;
	}

	if (!issue) return null;

	const hasBlockedBy = Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0;

	return html`
		<div class="p-4 text-[#e5e5e5]">
			<!-- Back link -->
			<div class="mb-4">
				<a href="#tasks" class="text-[#999] text-sm hover:text-[#ccc] transition-colors">← Back to Tasks</a>
			</div>

			<!-- Header -->
			<div class="mb-4">
				<div class="flex items-center gap-3 flex-wrap mb-2">
					<span class="font-mono text-[#999] text-sm">${issue.id ?? taskId}</span>
					${statusBadge(issue.status)}
					${priorityBadge(issue.priority)}
					${issue.type ? html`<span class="text-xs bg-[#2a2a2a] rounded px-1 text-[#999]">${issue.type}</span>` : null}
				</div>
				<h1 class="text-xl font-semibold text-[#e5e5e5] mb-2">${issue.title ?? taskId}</h1>
				<div class="flex items-center gap-4 text-[#999] text-sm flex-wrap">
					${issue.assignee ? html`<span>Assignee: ${issue.assignee}</span>` : null}
					${issue.owner ? html`<span>Owner: ${issue.owner}</span>` : null}
					${issue.createdAt ? html`<span>Created ${timeAgo(issue.createdAt)}</span>` : null}
					${hasBlockedBy ? html`<span class="text-red-400">⚠ blocked</span>` : null}
				</div>
				${
					issue.closeReason
						? html`
					<div class="mt-2 text-[#666] text-sm italic">Close reason: ${issue.closeReason}</div>
				`
						: null
				}
			</div>

			<!-- Tabs -->
			<div class="flex gap-1 mb-4 border-b border-[#2a2a2a]">
				${TABS.map(
					(tab) => html`
					<button
						key=${tab}
						onClick=${() => setActiveTab(tab)}
						class=${
							"px-4 py-2 text-sm font-medium border-b-2 transition-colors " +
							(activeTab === tab
								? "text-white border-[#E64415]"
								: "text-[#888] border-transparent hover:text-[#ccc]")
						}
					>${tab}</button>
				`,
				)}
			</div>

			<!-- Tab content -->
			${activeTab === "Overview" ? html`<${OverviewTab} issue=${issue} />` : null}
			${activeTab === "Agents" ? html`<${AgentsTab} agents=${agents} taskId=${taskId} />` : null}
			${activeTab === "Communication" ? html`<${CommunicationTab} mail=${mail} taskId=${taskId} />` : null}
		</div>
	`;
}

export default TaskDetailView;
