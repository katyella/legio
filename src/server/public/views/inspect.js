// views/inspect.js — Per-agent deep inspection view
// Exports InspectView (Preact component) and sets window.renderInspect (legacy shim)

import { h, html, useState, useEffect } from "../lib/preact-setup.js";

// ── Utility functions ──────────────────────────────────────────────────────

function formatDuration(ms) {
	if (ms < 1000) return "< 1s";
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const hh = Math.floor(m / 60);
	if (hh > 0) return hh + "h " + (m % 60) + "m";
	if (m > 0) return m + "m " + (s % 60) + "s";
	return s + "s";
}

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

function formatNumber(n) {
	if (n == null) return "\u2014";
	return Number(n).toLocaleString();
}

function truncate(str, maxLen) {
	if (!str) return "";
	return str.length <= maxLen ? str : str.slice(0, maxLen - 3) + "...";
}

function formatTimestamp(iso) {
	if (!iso) return "\u2014";
	const d = new Date(iso);
	return (
		String(d.getHours()).padStart(2, "0") +
		":" +
		String(d.getMinutes()).padStart(2, "0") +
		":" +
		String(d.getSeconds()).padStart(2, "0")
	);
}

function escapeHtml(str) {
	if (str == null) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// ── State badge config ─────────────────────────────────────────────────────

const stateBadgeClasses = {
	working: "text-green-500 bg-green-500/10",
	booting: "text-yellow-500 bg-yellow-500/10",
	stalled: "text-red-500 bg-red-500/10",
	zombie: "text-gray-500 bg-gray-500/10",
	completed: "text-blue-500 bg-blue-500/10",
};

// ── Preact component ───────────────────────────────────────────────────────

export function InspectView({ agentName }) {
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(null);

	useEffect(() => {
		if (!agentName) return;
		setLoading(true);
		setError(null);
		setData(null);
		fetch(`/api/agents/${encodeURIComponent(agentName)}/inspect`)
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((d) => {
				setData(d);
				setLoading(false);
			})
			.catch((err) => {
				setError(String(err));
				setLoading(false);
			});
	}, [agentName]);

	if (!agentName) {
		return html`
			<div class="flex items-center justify-center h-64 text-[#999]">
				Select an agent to inspect
			</div>
		`;
	}

	if (loading) {
		return html`
			<div class="flex items-center justify-center h-64 text-[#999]">
				Loading ${agentName}…
			</div>
		`;
	}

	if (error) {
		return html`
			<div class="flex items-center justify-center h-64 text-red-500">
				Failed to load agent data: ${error}
			</div>
		`;
	}

	if (!data) return null;

	const agent = data.session || {};
	const dur = agent.startedAt ? Date.now() - new Date(agent.startedAt).getTime() : 0;
	const token = data.tokenUsage || {};
	const badgeClass = stateBadgeClasses[agent.state] || "text-gray-500 bg-gray-500/10";

	const statCards = [
		{ label: "Input Tokens", value: formatNumber(token.inputTokens) },
		{ label: "Output Tokens", value: formatNumber(token.outputTokens) },
		{ label: "Cache Read", value: formatNumber(token.cacheReadTokens) },
		{ label: "Cache Created", value: formatNumber(token.cacheCreationTokens) },
		{
			label: "Est. Cost",
			value: token.estimatedCostUsd != null ? "$" + token.estimatedCostUsd.toFixed(4) : "\u2014",
		},
		{ label: "Model", value: token.modelUsed || "\u2014" },
	];

	const toolStats = [...(data.toolStats || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
	const recentToolCalls = data.recentToolCalls || [];

	return html`
		<div class="p-4 text-[#e5e5e5]">
			<!-- Header -->
			<div class="flex items-center gap-3 mb-1">
				<h2 class="text-xl font-semibold">${agent.agentName || agentName}</h2>
				<span class=${`text-sm px-2 py-0.5 rounded-sm ${badgeClass}`}>
					${agent.state || ""}
				</span>
				<span class="text-[#999] text-sm">${agent.capability || ""}</span>
				<span class="font-mono text-[#999] text-sm">${agent.beadId || ""}</span>
			</div>

			<!-- Subheader -->
			<div class="text-[#999] text-sm mb-4">
				Branch: ${agent.branchName || "\u2014"} |
				Parent: ${agent.parentAgent || "orchestrator"} |
				Duration: ${formatDuration(dur)}
			</div>

			<!-- Token stat cards -->
			<div class="grid grid-cols-3 gap-2 mb-6">
				${statCards.map(({ label, value }) => html`
					<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm p-3">
						<div class="text-[#999] text-xs mb-1">${label}</div>
						<div class="text-[#e5e5e5] font-mono text-sm">${value}</div>
					</div>
				`)}
			</div>

			<!-- Tool Stats -->
			<h3 class="text-sm font-semibold text-[#999] uppercase tracking-wide mb-2">Tool Stats</h3>
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm mb-6 overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[#2a2a2a]">
							<th class="text-left text-[#999] text-xs px-3 py-2 font-medium">Tool</th>
							<th class="text-right text-[#999] text-xs px-3 py-2 font-medium">Calls</th>
							<th class="text-right text-[#999] text-xs px-3 py-2 font-medium">Avg</th>
							<th class="text-right text-[#999] text-xs px-3 py-2 font-medium">Max</th>
						</tr>
					</thead>
					<tbody>
						${toolStats.length === 0
							? html`<tr><td colspan="4" class="text-center text-[#999] text-sm px-3 py-4">No tool stats</td></tr>`
							: toolStats.map((ts) => html`
								<tr class="border-b border-[#2a2a2a] last:border-0">
									<td class="px-3 py-2">${ts.toolName || ""}</td>
									<td class="px-3 py-2 text-right font-mono">${ts.count || 0}</td>
									<td class="px-3 py-2 text-right font-mono text-[#999]">
										${ts.avgDurationMs != null ? formatDuration(ts.avgDurationMs) : "\u2014"}
									</td>
									<td class="px-3 py-2 text-right font-mono text-[#999]">
										${ts.maxDurationMs != null ? formatDuration(ts.maxDurationMs) : "\u2014"}
									</td>
								</tr>
							`)
						}
					</tbody>
				</table>
			</div>

			<!-- Recent Tool Calls timeline -->
			<h3 class="text-sm font-semibold text-[#999] uppercase tracking-wide mb-2">Recent Tool Calls</h3>
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm">
				${recentToolCalls.length === 0
					? html`<div class="text-center text-[#999] text-sm px-3 py-4">No recent tool calls</div>`
					: recentToolCalls.map((tc) => html`
						<div class="flex items-center gap-3 px-3 py-2 border-b border-[#2a2a2a] last:border-0 text-sm">
							<span class="font-mono text-[#999] text-xs w-20 shrink-0">
								${formatTimestamp(tc.timestamp)}
							</span>
							<span class="font-semibold">${tc.toolName || ""}</span>
							<span class="text-[#999] truncate flex-1">
								${truncate(tc.args || "", 80)}
							</span>
							<span class="font-mono text-[#999] text-xs shrink-0">
								${tc.durationMs != null ? formatDuration(tc.durationMs) : "\u2014"}
							</span>
						</div>
					`)
				}
			</div>
		</div>
	`;
}

// ── Legacy global shim for the existing app.js router ─────────────────────
// This registers window.renderInspect so the current hash router in app.js
// can call it directly. Uses innerHTML (matching the existing pattern in
// components.js) to avoid requiring a Preact render root.

window.renderInspect = function (appState, el, agentName) {
	if (!agentName) {
		el.innerHTML =
			'<div class="flex items-center justify-center h-64 text-[#999]">Select an agent to inspect</div>';
		return;
	}

	if (!appState.inspectData || appState.inspectAgent !== agentName) {
		el.innerHTML = `<div class="flex items-center justify-center h-64 text-[#999]">Loading ${escapeHtml(agentName)}\u2026</div>`;
		appState.inspectAgent = agentName;
		fetch(`/api/agents/${encodeURIComponent(agentName)}/inspect`)
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((d) => {
				appState.inspectData = d;
				window.renderInspect(appState, el, agentName);
			})
			.catch((err) => {
				el.innerHTML = `<div class="flex items-center justify-center h-64 text-red-500">Failed to load agent data: ${escapeHtml(String(err))}</div>`;
			});
		return;
	}

	const data = appState.inspectData;
	const agent = data.session || {};
	const dur = agent.startedAt ? Date.now() - new Date(agent.startedAt).getTime() : 0;
	const token = data.tokenUsage || {};
	const stateClasses = {
		working: "text-green-500 bg-green-500/10",
		booting: "text-yellow-500 bg-yellow-500/10",
		stalled: "text-red-500 bg-red-500/10",
		zombie: "text-gray-500 bg-gray-500/10",
		completed: "text-blue-500 bg-blue-500/10",
	};
	const badgeClass = stateClasses[agent.state] || "text-gray-500 bg-gray-500/10";

	const statCardsHtml = [
		{ label: "Input Tokens", value: formatNumber(token.inputTokens) },
		{ label: "Output Tokens", value: formatNumber(token.outputTokens) },
		{ label: "Cache Read", value: formatNumber(token.cacheReadTokens) },
		{ label: "Cache Created", value: formatNumber(token.cacheCreationTokens) },
		{
			label: "Est. Cost",
			value:
				token.estimatedCostUsd != null ? "$" + token.estimatedCostUsd.toFixed(4) : "\u2014",
		},
		{ label: "Model", value: escapeHtml(token.modelUsed || "\u2014") },
	]
		.map(
			(c) => `
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm p-3">
			<div class="text-[#999] text-xs mb-1">${c.label}</div>
			<div class="text-[#e5e5e5] font-mono text-sm">${c.value}</div>
		</div>`,
		)
		.join("");

	const toolStats = [...(data.toolStats || [])].sort((a, b) => (b.count || 0) - (a.count || 0));
	const toolStatsRows =
		toolStats.length === 0
			? `<tr><td colspan="4" class="text-center text-[#999] text-sm px-3 py-4">No tool stats</td></tr>`
			: toolStats
					.map(
						(ts) => `
			<tr class="border-b border-[#2a2a2a] last:border-0">
				<td class="px-3 py-2">${escapeHtml(ts.toolName || "")}</td>
				<td class="px-3 py-2 text-right font-mono">${ts.count || 0}</td>
				<td class="px-3 py-2 text-right font-mono text-[#999]">${ts.avgDurationMs != null ? formatDuration(ts.avgDurationMs) : "\u2014"}</td>
				<td class="px-3 py-2 text-right font-mono text-[#999]">${ts.maxDurationMs != null ? formatDuration(ts.maxDurationMs) : "\u2014"}</td>
			</tr>`,
					)
					.join("");

	const recentToolCalls = data.recentToolCalls || [];
	const timelineHtml =
		recentToolCalls.length === 0
			? `<div class="text-center text-[#999] text-sm px-3 py-4">No recent tool calls</div>`
			: recentToolCalls
					.map(
						(tc) => `
			<div class="flex items-center gap-3 px-3 py-2 border-b border-[#2a2a2a] last:border-0 text-sm">
				<span class="font-mono text-[#999] text-xs w-20 shrink-0">${formatTimestamp(tc.timestamp)}</span>
				<span class="font-semibold">${escapeHtml(tc.toolName || "")}</span>
				<span class="text-[#999] truncate flex-1">${escapeHtml(truncate(tc.args || "", 80))}</span>
				<span class="font-mono text-[#999] text-xs shrink-0">${tc.durationMs != null ? formatDuration(tc.durationMs) : "\u2014"}</span>
			</div>`,
					)
					.join("");

	el.innerHTML = `
		<div class="p-4 text-[#e5e5e5]">
			<div class="flex items-center gap-3 mb-1">
				<h2 class="text-xl font-semibold">${escapeHtml(agent.agentName || agentName)}</h2>
				<span class="text-sm px-2 py-0.5 rounded-sm ${badgeClass}">${escapeHtml(agent.state || "")}</span>
				<span class="text-[#999] text-sm">${escapeHtml(agent.capability || "")}</span>
				<span class="font-mono text-[#999] text-sm">${escapeHtml(agent.beadId || "")}</span>
			</div>
			<div class="text-[#999] text-sm mb-4">
				Branch: ${escapeHtml(agent.branchName || "\u2014")} |
				Parent: ${escapeHtml(agent.parentAgent || "orchestrator")} |
				Duration: ${formatDuration(dur)}
			</div>
			<div class="grid grid-cols-3 gap-2 mb-6">${statCardsHtml}</div>
			<h3 class="text-sm font-semibold text-[#999] uppercase tracking-wide mb-2">Tool Stats</h3>
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm mb-6 overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-[#2a2a2a]">
							<th class="text-left text-[#999] text-xs px-3 py-2 font-medium">Tool</th>
							<th class="text-right text-[#999] text-xs px-3 py-2 font-medium">Calls</th>
							<th class="text-right text-[#999] text-xs px-3 py-2 font-medium">Avg</th>
							<th class="text-right text-[#999] text-xs px-3 py-2 font-medium">Max</th>
						</tr>
					</thead>
					<tbody>${toolStatsRows}</tbody>
				</table>
			</div>
			<h3 class="text-sm font-semibold text-[#999] uppercase tracking-wide mb-2">Recent Tool Calls</h3>
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm">${timelineHtml}</div>
		</div>`;
};
