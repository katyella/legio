// views/strategy.js — CTO strategy recommendations view
// Renders recommendations as cards with approve/dismiss actions.

import { html, useState, useEffect } from "../lib/preact-setup.js";
import { fetchJson, postJson } from "../lib/api.js";

// ── Priority badge ──────────────────────────────────────────────────────────

function PriorityBadge({ priority }) {
	const colors = {
		critical: "bg-red-500/20 text-red-400 border-red-500/30",
		high: "bg-orange-500/20 text-orange-400 border-orange-500/30",
		medium: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
		low: "bg-blue-500/20 text-blue-400 border-blue-500/30",
	};
	return html`<span class=${"text-xs px-2 py-0.5 rounded border " + (colors[priority] || "bg-[#2a2a2a] text-[#999] border-[#444]")}>${priority}</span>`;
}

// ── Strategy card ───────────────────────────────────────────────────────────

function StrategyCard({ rec, onAction }) {
	const [acting, setActing] = useState(false);

	async function handleAction(action) {
		setActing(true);
		try {
			await onAction(rec.id, action);
		} finally {
			setActing(false);
		}
	}

	const isPending = rec.status === "pending";

	return html`
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm p-4">
			<div class="flex items-center gap-2 mb-2 flex-wrap">
				<${PriorityBadge} priority=${rec.priority} />
				<span class="text-xs bg-[#2a2a2a] text-[#999] rounded px-2 py-0.5">${rec.effort}</span>
				<span class="text-xs bg-[#2a2a2a] text-[#999] rounded px-2 py-0.5">${rec.category}</span>
				${!isPending && html`
					<span class=${"text-xs ml-auto " + (rec.status === "approved" ? "text-green-400" : "text-[#555]")}>
						${rec.status === "approved" ? "Approved" : "Dismissed"}
					</span>
				`}
			</div>
			<h3 class="text-[#e5e5e5] font-medium text-sm mb-2">${rec.title}</h3>
			<p class="text-[#999] text-xs mb-2 whitespace-pre-wrap">${rec.rationale}</p>
			${rec.suggestedFiles && rec.suggestedFiles.length > 0 && html`
				<div class="text-[#555] text-xs font-mono mb-3">
					${rec.suggestedFiles.join(", ")}
				</div>
			`}
			${isPending && html`
				<div class="flex justify-end gap-2 mt-2">
					<button
						class="px-3 py-1 text-xs rounded-sm border border-[#2a2a2a] text-[#999] hover:border-[#444] hover:text-[#ccc] disabled:opacity-50"
						onClick=${() => handleAction("dismiss")}
						disabled=${acting}
					>Dismiss</button>
					<button
						class="px-3 py-1 text-xs rounded-sm border border-green-600 text-green-400 hover:bg-green-600/10 disabled:opacity-50"
						onClick=${() => handleAction("approve")}
						disabled=${acting}
					>Approve</button>
				</div>
			`}
		</div>
	`;
}

// ── StrategyView ────────────────────────────────────────────────────────────

export function StrategyView() {
	const [recommendations, setRecommendations] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [filter, setFilter] = useState("all");

	useEffect(() => {
		fetchJson("/api/strategy")
			.then((data) => {
				setRecommendations(data);
				setLoading(false);
			})
			.catch((err) => {
				setError(err.message);
				setLoading(false);
			});
	}, []);

	async function handleAction(id, action) {
		await postJson(`/api/strategy/${id}/${action}`, {});
		const updated = await fetchJson("/api/strategy");
		setRecommendations(updated);
	}

	const filtered =
		filter === "all" ? recommendations : recommendations.filter((r) => r.status === filter);

	if (loading) return html`<div class="p-4 text-[#555]">Loading...</div>`;
	if (error) return html`<div class="p-4 text-red-400">Error: ${error}</div>`;

	const filterButtons = ["all", "pending", "approved", "dismissed"];

	return html`
		<div class="p-4">
			<div class="flex items-center gap-2 mb-4">
				${filterButtons.map((f) => html`
					<button
						key=${f}
						class=${filter === f
							? "px-2 py-1 text-xs rounded-sm border border-[#E64415] text-[#E64415] bg-[#E64415]/10"
							: "px-2 py-1 text-xs rounded-sm border border-[#2a2a2a] text-[#999] hover:border-[#444]"}
						onClick=${() => setFilter(f)}
					>${f.charAt(0).toUpperCase() + f.slice(1)}</button>
				`)}
				<span class="text-[#555] text-xs ml-auto">${recommendations.length} recommendations</span>
			</div>
			${filtered.length === 0
				? html`<div class="text-[#999] text-sm text-center py-8">No recommendations</div>`
				: html`<div class="flex flex-col gap-3">
						${filtered.map((rec) => html`<${StrategyCard} key=${rec.id} rec=${rec} onAction=${handleAction} />`)}
					</div>`
			}
		</div>
	`;
}
