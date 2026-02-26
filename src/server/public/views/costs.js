// CostsView — Usage report with charts, tables, and live snapshots
// Preact+HTM component, no build step required.

import { fetchJson } from "../lib/api.js";
import { html, useCallback, useEffect, useMemo, useState } from "../lib/preact-setup.js";
import { timeAgo } from "../lib/utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_WINDOWS = [
	{ label: "All Time", value: null },
	{ label: "Last Hour", value: 60 * 60 * 1000 },
	{ label: "Last 24h", value: 24 * 60 * 60 * 1000 },
	{ label: "Last 7d", value: 7 * 24 * 60 * 60 * 1000 },
	{ label: "Last 30d", value: 30 * 24 * 60 * 60 * 1000 },
];

const MODEL_COLORS = {
	opus: "bg-blue-500",
	sonnet: "bg-green-500",
	haiku: "bg-yellow-500",
	unknown: "bg-gray-500",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatNumber(n) {
	if (n == null) return "—";
	return Number(n).toLocaleString();
}

function formatCost(n) {
	if (n == null) return "—";
	return `$${Number(n).toFixed(4)}`;
}

function formatCostShort(n) {
	if (n == null) return "—";
	return `$${Number(n).toFixed(2)}`;
}

function formatDateShort(dateStr) {
	if (!dateStr) return "";
	const d = String(dateStr).split("T")[0]; // "2026-02-21"
	const parts = d.split("-");
	if (parts.length < 3) return d;
	return `${parts[1]}/${parts[2]}`; // "02/21"
}

function modelColor(model) {
	if (!model) return MODEL_COLORS.unknown;
	const lower = String(model).toLowerCase();
	if (lower.includes("opus")) return MODEL_COLORS.opus;
	if (lower.includes("sonnet")) return MODEL_COLORS.sonnet;
	if (lower.includes("haiku")) return MODEL_COLORS.haiku;
	return MODEL_COLORS.unknown;
}

// ---------------------------------------------------------------------------
// StatCard
// ---------------------------------------------------------------------------

function StatCard({ label, value }) {
	return html`
		<div class="bg-surface border border-border rounded-sm p-4 flex-1 min-w-0">
			<div class="text-xs text-gray-500 uppercase tracking-wider mb-1">${label}</div>
			<div class="text-2xl font-mono text-white">${value}</div>
		</div>
	`;
}

// ---------------------------------------------------------------------------
// ModelBreakdown
// ---------------------------------------------------------------------------

function ModelBreakdown({ modelData }) {
	if (!modelData || modelData.length === 0) {
		return html`<div class="text-center text-gray-500 py-8">No model data</div>`;
	}

	const sorted = [...modelData].sort(
		(a, b) => (b.estimatedCostUsd || 0) - (a.estimatedCostUsd || 0),
	);
	const maxCost = sorted[0]?.estimatedCostUsd ?? 0;

	return html`
		<div class="flex flex-col gap-3">
			${sorted.map((row) => {
				const ioTokens = (row.inputTokens || 0) + (row.outputTokens || 0);
				const pct = maxCost > 0 ? ((row.estimatedCostUsd || 0) / maxCost) * 100 : 0;
				const color = modelColor(row.model);
				return html`
					<div key=${row.model || "unknown"} class="flex items-center gap-3">
						<div class="flex items-center gap-2 w-[140px] shrink-0">
							<div class=${`${color} w-2 h-2 rounded-full shrink-0`}></div>
							<span class="text-sm text-gray-300 truncate">${row.model || "unknown"}</span>
						</div>
						<div class="flex-1 bg-white/5 rounded-sm h-5 overflow-hidden">
							<div
								class=${`${color} h-full rounded-sm`}
								style=${`width: ${pct.toFixed(1)}%`}
							></div>
						</div>
						<span class="font-mono text-xs text-gray-400 w-28 text-right shrink-0">
							${formatNumber(ioTokens)} tok
						</span>
						<span class="font-mono text-sm text-gray-300 w-20 text-right shrink-0">
							${formatCost(row.estimatedCostUsd)}
						</span>
					</div>
				`;
			})}
			<!-- Legend details -->
			<div class="flex flex-wrap gap-x-6 gap-y-1 mt-1">
				${sorted.map(
					(row) => html`
						<div key=${row.model} class="text-xs text-gray-500">
							${row.model || "unknown"}: ${row.sessions ?? 0} session${row.sessions === 1 ? "" : "s"}
						</div>
					`,
				)}
			</div>
		</div>
	`;
}

// ---------------------------------------------------------------------------
// DateChart
// ---------------------------------------------------------------------------

function DateChart({ dateData }) {
	if (!dateData || dateData.length === 0) {
		return html`<div class="text-center text-gray-500 py-8">No date data</div>`;
	}

	const maxCost = Math.max(...dateData.map((d) => d.estimatedCostUsd || 0));
	const maxHeight = 160; // px

	return html`
		<div class="overflow-x-auto">
			<div class="flex items-end gap-1 min-w-0" style="min-height: ${maxHeight + 32}px">
				${dateData.map((d) => {
					const cost = d.estimatedCostUsd || 0;
					const barH = maxCost > 0 ? Math.max(2, Math.round((cost / maxCost) * maxHeight)) : 2;
					return html`
						<div
							key=${d.date}
							class="flex flex-col items-center gap-1 shrink-0"
							style="min-width: 40px"
							title=${`${d.date}: ${formatCost(cost)} (${d.sessions ?? 0} sessions)`}
						>
							<span class="text-xs font-mono text-gray-500">${formatCostShort(cost)}</span>
							<div
								class="w-6 bg-blue-500 rounded-t-sm"
								style=${`height: ${barH}px`}
							></div>
							<span class="text-xs text-gray-500 rotate-0">${formatDateShort(d.date)}</span>
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

// ---------------------------------------------------------------------------
// AgentBarChart
// ---------------------------------------------------------------------------

function AgentBarChart({ metrics }) {
	const agentCosts = useMemo(() => {
		const map = new Map();
		for (const m of metrics) {
			const name = m.agentName || "unknown";
			const cost = m.estimatedCostUsd || 0;
			map.set(name, (map.get(name) || 0) + cost);
		}
		return Array.from(map.entries())
			.map(([name, cost]) => ({ name, cost }))
			.sort((a, b) => b.cost - a.cost);
	}, [metrics]);

	if (agentCosts.length === 0) {
		return html`<div class="text-center text-gray-500 py-8">No cost data</div>`;
	}

	const maxCost = agentCosts[0]?.cost ?? 0;

	return html`
		<div class="flex flex-col gap-2">
			${agentCosts.map(({ name, cost }) => {
				const pct = maxCost > 0 ? (cost / maxCost) * 100 : 0;
				return html`
					<div key=${name} class="flex items-center gap-3">
						<a
							href=${`#inspect/${encodeURIComponent(name)}`}
							class="text-blue-400 hover:text-blue-300 text-sm w-[140px] shrink-0 truncate"
						>
							${name}
						</a>
						<div class="flex-1 bg-white/5 rounded-sm h-5 overflow-hidden">
							<div
								class="bg-blue-500 h-full rounded-sm"
								style=${`width: ${pct.toFixed(1)}%`}
							></div>
						</div>
						<span class="font-mono text-sm text-gray-300 w-20 text-right shrink-0">
							${formatCost(cost)}
						</span>
					</div>
				`;
			})}
		</div>
	`;
}

// ---------------------------------------------------------------------------
// TokenDistribution
// ---------------------------------------------------------------------------

function TokenDistribution({ totals }) {
	const totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheCreated;

	if (totalTokens === 0) {
		return html`<div class="text-center text-gray-500 py-4">No token data</div>`;
	}

	const segments = [
		{ label: "Input", value: totals.input, color: "bg-blue-500" },
		{ label: "Output", value: totals.output, color: "bg-green-500" },
		{ label: "Cache Read", value: totals.cacheRead, color: "bg-yellow-500" },
		{ label: "Cache Created", value: totals.cacheCreated, color: "bg-purple-500" },
	].filter((s) => s.value > 0);

	return html`
		<div>
			<!-- Segmented bar -->
			<div class="flex h-6 rounded-sm overflow-hidden gap-px">
				${segments.map((s) => {
					const pct = (s.value / totalTokens) * 100;
					return html`
						<div
							key=${s.label}
							class=${s.color}
							style=${`width: ${pct.toFixed(2)}%`}
							title=${`${s.label}: ${formatNumber(s.value)} (${pct.toFixed(1)}%)`}
						></div>
					`;
				})}
			</div>
			<!-- Legend -->
			<div class="flex flex-wrap gap-x-6 gap-y-2 mt-3">
				${segments.map((s) => {
					const pct = ((s.value / totalTokens) * 100).toFixed(1);
					return html`
						<div key=${s.label} class="flex items-center gap-2 text-sm">
							<div class=${`${s.color} w-3 h-3 rounded-full shrink-0`}></div>
							<span class="text-gray-400">${s.label}</span>
							<span class="font-mono text-gray-300">${formatNumber(s.value)}</span>
							<span class="text-gray-500">${pct}%</span>
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

// ---------------------------------------------------------------------------
// CapabilityChart
// ---------------------------------------------------------------------------

function CapabilityChart({ metrics }) {
	const capCosts = useMemo(() => {
		const map = new Map();
		for (const m of metrics) {
			const cap = m.capability || "unknown";
			const cost = m.estimatedCostUsd || 0;
			map.set(cap, (map.get(cap) || 0) + cost);
		}
		return Array.from(map.entries())
			.map(([cap, cost]) => ({ cap, cost }))
			.sort((a, b) => b.cost - a.cost);
	}, [metrics]);

	// Only show if more than one capability
	if (capCosts.length <= 1) return null;

	const maxCost = capCosts[0]?.cost ?? 0;

	return html`
		<div class="flex flex-col gap-2">
			${capCosts.map(({ cap, cost }) => {
				const pct = maxCost > 0 ? (cost / maxCost) * 100 : 0;
				return html`
					<div key=${cap} class="flex items-center gap-3">
						<span class="text-sm text-gray-400 w-[140px] shrink-0 truncate">${cap}</span>
						<div class="flex-1 bg-white/5 rounded-sm h-5 overflow-hidden">
							<div
								class="bg-blue-400 h-full rounded-sm"
								style=${`width: ${pct.toFixed(1)}%`}
							></div>
						</div>
						<span class="font-mono text-sm text-gray-300 w-20 text-right shrink-0">
							${formatCost(cost)}
						</span>
					</div>
				`;
			})}
		</div>
	`;
}

// ---------------------------------------------------------------------------
// CostsView
// ---------------------------------------------------------------------------

export function CostsView({ metrics: initialMetrics, snapshots }) {
	const [groupByCapability, setGroupByCapability] = useState(false);
	const [timeWindow, setTimeWindow] = useState(null); // null = all time
	const [filteredMetrics, setFilteredMetrics] = useState(null);
	const [modelData, setModelData] = useState([]);
	const [dateData, setDateData] = useState([]);
	const [loading, setLoading] = useState(false);
	const [agentExpanded, setAgentExpanded] = useState(() => {
		const names = new Set(
			(Array.isArray(initialMetrics) ? initialMetrics : []).map((m) => m.agentName || "unknown"),
		);
		return names.size <= 5;
	});
	const [detailExpanded, setDetailExpanded] = useState(
		() => !initialMetrics || initialMetrics.length < 10,
	);

	const onToggleGroup = useCallback(() => setGroupByCapability((v) => !v), []);

	// When timeWindow changes, fetch filtered data from all 3 endpoints
	useEffect(() => {
		const sinceIso = timeWindow !== null ? new Date(Date.now() - timeWindow).toISOString() : null;
		const enc = sinceIso ? encodeURIComponent(sinceIso) : null;

		const metricsUrl = enc ? `/api/metrics?since=${enc}&limit=1000` : "/api/metrics?limit=1000";
		const modelUrl = enc ? `/api/metrics/by-model?since=${enc}` : "/api/metrics/by-model";
		const dateUrl = enc ? `/api/metrics/by-date?since=${enc}` : "/api/metrics/by-date";

		setLoading(true);
		Promise.all([
			fetchJson(metricsUrl).catch(() => []),
			fetchJson(modelUrl).catch(() => []),
			fetchJson(dateUrl).catch(() => []),
		]).then(([metrics, byModel, byDate]) => {
			setFilteredMetrics(Array.isArray(metrics) ? metrics : []);
			setModelData(Array.isArray(byModel) ? byModel : []);
			setDateData(Array.isArray(byDate) ? byDate : []);
			setLoading(false);
		});
	}, [timeWindow]);

	// Use filteredMetrics (always fetched), fall back to initialMetrics before first fetch completes
	const safeMetrics = Array.isArray(filteredMetrics)
		? filteredMetrics
		: Array.isArray(initialMetrics)
			? initialMetrics
			: [];
	const safeSnapshots = snapshots || [];

	// Compute overall totals
	const totals = useMemo(
		() =>
			safeMetrics.reduce(
				(acc, m) => {
					acc.input += m.inputTokens || 0;
					acc.output += m.outputTokens || 0;
					acc.cacheRead += m.cacheReadTokens || 0;
					acc.cacheCreated += m.cacheCreationTokens || 0;
					if (m.estimatedCostUsd != null) {
						acc.cost = (acc.cost ?? 0) + m.estimatedCostUsd;
					}
					return acc;
				},
				{ input: 0, output: 0, cacheRead: 0, cacheCreated: 0, cost: null },
			),
		[safeMetrics],
	);

	const sessionCount = safeMetrics.length;
	const ioTokens = totals.input + totals.output;
	const cacheTokens = totals.cacheRead + totals.cacheCreated;
	const avgCost = totals.cost != null && sessionCount > 0 ? totals.cost / sessionCount : null;

	// Group by capability when requested
	const grouped = useMemo(() => {
		if (!groupByCapability) return null;
		const map = new Map();
		for (const m of safeMetrics) {
			const cap = m.capability || "unknown";
			if (!map.has(cap)) map.set(cap, []);
			map.get(cap).push(m);
		}
		return map;
	}, [safeMetrics, groupByCapability]);

	const thClass = "text-gray-500 uppercase text-xs tracking-wider text-left px-3 py-2 font-normal";
	const tdClass = "px-3 py-2 border-b border-border text-sm";
	const tdMono = `${tdClass} font-mono`;

	function MetricRow({ m }) {
		return html`
			<tr class="hover:bg-white/5">
				<td class=${tdClass}>
					<a
						href=${`#inspect/${encodeURIComponent(m.agentName || "")}`}
						class="text-blue-400 hover:text-blue-300"
					>
						${m.agentName || "—"}
					</a>
				</td>
				<td class=${`text-gray-400 ${tdClass}`}>${m.capability || ""}</td>
				<td class=${tdMono}>${formatNumber(m.inputTokens)}</td>
				<td class=${tdMono}>${formatNumber(m.outputTokens)}</td>
				<td class=${tdMono}>${formatNumber(m.cacheReadTokens)}</td>
				<td class=${tdMono}>${formatNumber(m.cacheCreationTokens)}</td>
				<td class=${tdMono}>${m.estimatedCostUsd != null ? formatCost(m.estimatedCostUsd) : "—"}</td>
			</tr>
		`;
	}

	function SubtotalRow({ label, rows }) {
		const sub = rows.reduce(
			(acc, m) => {
				acc.input += m.inputTokens || 0;
				acc.output += m.outputTokens || 0;
				acc.cacheRead += m.cacheReadTokens || 0;
				acc.cacheCreated += m.cacheCreationTokens || 0;
				if (m.estimatedCostUsd != null) {
					acc.cost = (acc.cost ?? 0) + m.estimatedCostUsd;
				}
				return acc;
			},
			{ input: 0, output: 0, cacheRead: 0, cacheCreated: 0, cost: null },
		);
		return html`
			<tr class="bg-white/5 text-gray-400">
				<td class=${`font-medium ${tdClass}`} colspan="2">${label} subtotal</td>
				<td class=${tdMono}>${formatNumber(sub.input)}</td>
				<td class=${tdMono}>${formatNumber(sub.output)}</td>
				<td class=${tdMono}>${formatNumber(sub.cacheRead)}</td>
				<td class=${tdMono}>${formatNumber(sub.cacheCreated)}</td>
				<td class=${tdMono}>${sub.cost != null ? formatCost(sub.cost) : "—"}</td>
			</tr>
		`;
	}

	function TableBody() {
		if (safeMetrics.length === 0) {
			return html`
				<tr>
					<td colspan="7" class="text-gray-500 text-center py-8">No metrics yet</td>
				</tr>
			`;
		}
		if (grouped) {
			const rows = [];
			for (const [cap, capMetrics] of grouped) {
				for (const m of capMetrics) {
					rows.push(html`<${MetricRow} key=${m.agentName + cap} m=${m} />`);
				}
				rows.push(html`<${SubtotalRow} key=${`sub-${cap}`} label=${cap} rows=${capMetrics} />`);
			}
			return html`${rows}`;
		}
		return html`${safeMetrics.map((m) => html`<${MetricRow} key=${m.agentName} m=${m} />`)}`;
	}

	// Determine if capability chart should show
	const uniqueCaps = new Set(safeMetrics.map((m) => m.capability || "unknown"));
	const agentCount = useMemo(
		() => new Set(safeMetrics.map((m) => m.agentName || "unknown")).size,
		[safeMetrics],
	);

	return html`
		<div class="flex flex-col gap-6 p-6">
			<!-- Time Window Selector -->
			<div class="flex items-center justify-between">
				<div class="text-gray-500 uppercase text-xs tracking-wider">Cost Analysis</div>
				<div class="flex items-center gap-2">
					${loading ? html`<span class="text-xs text-gray-500">Loading...</span>` : null}
					<select
						class="text-sm bg-surface border border-border rounded-sm px-3 py-1.5 text-gray-300 focus:outline-none focus:border-blue-500"
						value=${String(timeWindow)}
						onChange=${(e) => {
							const val = e.target.value;
							setTimeWindow(val === "null" ? null : Number(val));
						}}
					>
						${TIME_WINDOWS.map(
							(w) => html`
								<option key=${String(w.value)} value=${String(w.value)}>
									${w.label}
								</option>
							`,
						)}
					</select>
				</div>
			</div>

			<!-- Summary Stat Cards -->
			<div class="flex gap-4">
				<${StatCard}
					label="Total Cost"
					value=${totals.cost != null ? formatCostShort(totals.cost) : "—"}
				/>
				<${StatCard}
					label="Input/Output"
					value=${formatNumber(ioTokens)}
				/>
				<${StatCard}
					label="Cache"
					value=${formatNumber(cacheTokens)}
				/>
				<${StatCard}
					label="Sessions"
					value=${String(sessionCount)}
				/>
				<${StatCard}
					label="Avg Cost/Session"
					value=${avgCost != null ? formatCostShort(avgCost) : "—"}
				/>
			</div>

			<!-- Model Usage Breakdown (show when data available) -->
			${
				modelData.length > 0
					? html`
					<div class="bg-surface border border-border rounded-sm p-4">
						<div class="text-gray-500 uppercase text-xs tracking-wider mb-4">Model Usage</div>
						<${ModelBreakdown} modelData=${modelData} />
					</div>
				`
					: null
			}

			<!-- Cost by Agent Bar Chart -->
			<div class="bg-surface border border-border rounded-sm p-4">
				<div
					class="flex items-center justify-between cursor-pointer"
					onClick=${() => setAgentExpanded((v) => !v)}
				>
					<div class="text-gray-500 uppercase text-xs tracking-wider">Cost by Agent</div>
					<span class="text-gray-500 text-sm">${agentExpanded ? "▾" : "▸"}</span>
				</div>
				${
					agentExpanded
						? html`<div class="mt-4"><${AgentBarChart} metrics=${safeMetrics} /></div>`
						: html`<div class="text-sm text-gray-500 mt-2">${agentCount} agent${agentCount === 1 ? "" : "s"} — ${totals.cost != null ? formatCostShort(totals.cost) : "—"} total</div>`
				}
			</div>

			<!-- Date Chart (show when data available) -->
			${
				dateData.length > 0
					? html`
					<div class="bg-surface border border-border rounded-sm p-4">
						<div class="text-gray-500 uppercase text-xs tracking-wider mb-4">Daily Cost Trend</div>
						<${DateChart} dateData=${dateData} />
					</div>
				`
					: null
			}

			<!-- Token Distribution -->
			<div class="bg-surface border border-border rounded-sm p-4">
				<div class="text-gray-500 uppercase text-xs tracking-wider mb-4">Token Distribution</div>
				<${TokenDistribution} totals=${totals} />
			</div>

			<!-- Cost by Capability (only if more than one capability) -->
			${
				uniqueCaps.size > 1
					? html`
					<div class="bg-surface border border-border rounded-sm p-4">
						<div class="text-gray-500 uppercase text-xs tracking-wider mb-4">Cost by Capability</div>
						<${CapabilityChart} metrics=${safeMetrics} />
					</div>
				`
					: null
			}

			<!-- Detailed Costs Table -->
			<div class="bg-surface border border-border rounded-sm p-4">
				<div class=${`flex items-center gap-3 ${detailExpanded ? "mb-4" : ""}`}>
					<div
						class="flex items-center gap-2 cursor-pointer"
						onClick=${() => setDetailExpanded((v) => !v)}
					>
						<span class="text-gray-500 uppercase text-xs tracking-wider">Detailed Breakdown</span>
						<span class="text-gray-500 text-sm">${detailExpanded ? "▾" : "▸"}</span>
					</div>
					${
						detailExpanded
							? html`
							<button
								class=${
									"text-sm px-3 py-1.5 rounded-sm border border-border ml-auto " +
									(groupByCapability
										? "bg-white/10 text-gray-200"
										: "bg-surface text-gray-400 hover:text-gray-200")
								}
								onClick=${onToggleGroup}
							>
								${groupByCapability ? "Ungroup" : "Group by Capability"}
							</button>
						`
							: null
					}
				</div>

				${
					detailExpanded
						? html`
						<div class="overflow-x-auto">
							<table class="w-full text-sm border-collapse">
								<thead>
									<tr class="border-b border-border">
										<th class=${thClass}>Agent</th>
										<th class=${thClass}>Capability</th>
										<th class=${thClass}>Input Tokens</th>
										<th class=${thClass}>Output Tokens</th>
										<th class=${thClass}>Cache Read</th>
										<th class=${thClass}>Cache Created</th>
										<th class=${thClass}>Est. Cost</th>
									</tr>
								</thead>
								<tbody>
									<${TableBody} />
								</tbody>
								<tfoot class="border-t border-border">
									<tr class="text-gray-300 font-medium">
										<td class=${`border-b-0 ${tdClass}`} colspan="2">Total</td>
										<td class=${`border-b-0 ${tdMono}`}>${formatNumber(totals.input)}</td>
										<td class=${`border-b-0 ${tdMono}`}>${formatNumber(totals.output)}</td>
										<td class=${`border-b-0 ${tdMono}`}>${formatNumber(totals.cacheRead)}</td>
										<td class=${`border-b-0 ${tdMono}`}>${formatNumber(totals.cacheCreated)}</td>
										<td class=${`border-b-0 ${tdMono}`}>
											${totals.cost != null ? formatCost(totals.cost) : "—"}
										</td>
									</tr>
								</tfoot>
							</table>
						</div>
					`
						: null
				}
			</div>

			<!-- Live Snapshots (only when data exists) -->
			${
				safeSnapshots.length > 0
					? html`
					<div class="bg-surface border border-border rounded-sm p-4">
						<div class="text-gray-500 uppercase text-xs tracking-wider mb-3">
							Active Agent Token Usage
						</div>
						<div class="flex flex-col gap-2">
							${safeSnapshots.map(
								(s) => html`
									<div
										key=${s.agentName}
										class="flex flex-row gap-4 items-baseline text-sm py-1 border-b border-border last:border-0"
									>
										<span class="text-gray-200 min-w-[120px]">${s.agentName || ""}</span>
										<span class="font-mono text-gray-300">
											${formatNumber((s.inputTokens || 0) + (s.outputTokens || 0))} tokens
										</span>
										<span class="text-gray-500">${s.modelUsed || ""}</span>
										<span class="text-gray-500 ml-auto">${timeAgo(s.createdAt)}</span>
									</div>
								`,
							)}
						</div>
					</div>
				`
					: null
			}
		</div>
	`;
}
