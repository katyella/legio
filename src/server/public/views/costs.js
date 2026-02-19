// CostsView — Usage report with charts, tables, and live snapshots
// Preact+HTM component, no build step required.

import { html, useCallback, useMemo, useState } from "../lib/preact-setup.js";
import { timeAgo } from "../lib/utils.js";

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
								style=${"width: " + pct.toFixed(1) + "%"}
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
							style=${"width: " + pct.toFixed(2) + "%"}
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
								style=${"width: " + pct.toFixed(1) + "%"}
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

export function CostsView({ metrics, snapshots }) {
	const [groupByCapability, setGroupByCapability] = useState(false);

	const safeMetrics = metrics || [];
	const safeSnapshots = snapshots || [];

	const onToggleGroup = useCallback(() => setGroupByCapability((v) => !v), []);

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
	const totalTokens = totals.input + totals.output;
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

	return html`
		<div class="flex flex-col gap-6 p-6">
			<!-- Summary Stat Cards -->
			<div class="flex gap-4">
				<${StatCard}
					label="Total Cost"
					value=${totals.cost != null ? formatCostShort(totals.cost) : "—"}
				/>
				<${StatCard}
					label="Total Tokens"
					value=${formatNumber(totalTokens)}
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

			<!-- Cost by Agent Bar Chart -->
			<div class="bg-surface border border-border rounded-sm p-4">
				<div class="text-gray-500 uppercase text-xs tracking-wider mb-4">Cost by Agent</div>
				<${AgentBarChart} metrics=${safeMetrics} />
			</div>

			<!-- Token Distribution -->
			<div class="bg-surface border border-border rounded-sm p-4">
				<div class="text-gray-500 uppercase text-xs tracking-wider mb-4">Token Distribution</div>
				<${TokenDistribution} totals=${totals} />
			</div>

			<!-- Cost by Capability (only if more than one capability) -->
			${uniqueCaps.size > 1
				? html`
					<div class="bg-surface border border-border rounded-sm p-4">
						<div class="text-gray-500 uppercase text-xs tracking-wider mb-4">Cost by Capability</div>
						<${CapabilityChart} metrics=${safeMetrics} />
					</div>
				`
				: null}

			<!-- Detailed Costs Table -->
			<div class="bg-surface border border-border rounded-sm p-4">
				<div class="flex items-center gap-3 mb-4">
					<div class="text-gray-500 uppercase text-xs tracking-wider">Detailed Breakdown</div>
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
				</div>

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
			</div>

			<!-- Live Snapshots (only when data exists) -->
			${safeSnapshots.length > 0
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
				: null}
		</div>
	`;
}
