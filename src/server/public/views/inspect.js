// views/inspect.js — Per-agent deep inspection view
// Exports InspectView (Preact component)

import { h, html, useState, useEffect, useRef, useCallback } from "../lib/preact-setup.js";

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

// Strip ANSI escape sequences from terminal output before display
function stripAnsi(str) {
	return str.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
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
	// Agent data state
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(null);

	// Terminal state
	const [termOutput, setTermOutput] = useState("");
	const [termInput, setTermInput] = useState("");
	const [termSending, setTermSending] = useState(false);
	const [termError, setTermError] = useState("");
	const [termConnected, setTermConnected] = useState(false);
	const termOutputRef = useRef(null);
	const isNearBottomRef = useRef(true);
	const termIntervalRef = useRef(null);

	// Fetch agent inspect data on mount / agent change
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

	// Smart scroll: only scroll to bottom when user is near the bottom
	const scrollToBottomIfNear = useCallback(() => {
		const el = termOutputRef.current;
		if (el && isNearBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, []);

	const handleOutputScroll = useCallback(() => {
		const el = termOutputRef.current;
		if (!el) return;
		isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
	}, []);

	// Fetch terminal capture for this agent
	const fetchTermCapture = useCallback(async () => {
		if (!agentName) return;
		try {
			const res = await fetch(
				`/api/terminal/capture?agent=${encodeURIComponent(agentName)}&lines=80`,
			);
			if (!res.ok) {
				setTermConnected(false);
				setTermError(`Capture failed: HTTP ${res.status}`);
				return;
			}
			const d = await res.json();
			setTermConnected(true);
			setTermError("");
			setTermOutput(stripAnsi(d.output || ""));
			requestAnimationFrame(scrollToBottomIfNear);
		} catch (e) {
			setTermConnected(false);
			setTermError(e.message || "Failed to reach server");
		}
	}, [agentName, scrollToBottomIfNear]);

	// Terminal polling every 3 seconds
	useEffect(() => {
		if (!agentName) return;
		fetchTermCapture();
		termIntervalRef.current = setInterval(fetchTermCapture, 3000);
		return () => {
			if (termIntervalRef.current) clearInterval(termIntervalRef.current);
		};
	}, [fetchTermCapture, agentName]);

	// Send text to agent's tmux session
	const handleTermSend = useCallback(async () => {
		const text = termInput.trim();
		if (!text || !agentName) return;
		setTermSending(true);
		setTermError("");
		try {
			const res = await fetch("/api/terminal/send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, agent: agentName }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || `Send failed: HTTP ${res.status}`);
			}
			setTermInput("");
			setTimeout(fetchTermCapture, 400);
		} catch (e) {
			setTermError(e.message || "Send failed");
		} finally {
			setTermSending(false);
		}
	}, [termInput, agentName, fetchTermCapture]);

	const handleTermKeyDown = useCallback(
		(e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleTermSend();
			}
		},
		[handleTermSend],
	);

	const handleTermClear = useCallback(() => setTermOutput(""), []);

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

	const inputCls =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415]";

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
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm mb-6">
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

			<!-- Terminal section -->
			<div class="flex items-center justify-between mb-2">
				<h3 class="text-sm font-semibold text-[#999] uppercase tracking-wide">Terminal</h3>
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-1.5">
						<span
							class=${"w-2 h-2 rounded-full " + (termConnected ? "bg-green-500" : "bg-[#555]")}
						></span>
						<span class=${"text-xs font-mono " + (termConnected ? "text-green-400" : "text-[#555]")}>
							${termConnected ? "connected" : "disconnected"}
						</span>
					</div>
					<button
						onClick=${handleTermClear}
						class="text-xs text-[#666] hover:text-[#999] bg-transparent border-none cursor-pointer font-mono"
					>
						clear
					</button>
				</div>
			</div>
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm mb-2">
				<div
					ref=${termOutputRef}
					onScroll=${handleOutputScroll}
					class="max-h-[40vh] overflow-y-auto p-3"
				>
					${termOutput
						? html`<pre
								class="text-[#e5e5e5] text-xs leading-relaxed whitespace-pre-wrap break-words m-0 font-mono"
							>${termOutput}</pre>`
						: html`<div class="text-[#444] text-sm font-mono text-center py-4">
								No output
							</div>`}
				</div>
				${termError
					? html`<div class="px-3 py-1.5 bg-[#1a0a0a] border-t border-red-900">
							<span class="text-xs text-red-400 font-mono">${termError}</span>
						</div>`
					: null}
				<div class="border-t border-[#2a2a2a] p-3">
					<div class="flex items-center gap-2">
						<span class="text-[#E64415] font-mono text-sm shrink-0 select-none">$</span>
						<input
							type="text"
							placeholder="Type a command or prompt..."
							value=${termInput}
							onInput=${(e) => setTermInput(e.target.value)}
							onKeyDown=${handleTermKeyDown}
							disabled=${termSending}
							class=${"flex-1 " + inputCls + " font-mono disabled:opacity-50"}
						/>
						<button
							onClick=${handleTermSend}
							disabled=${termSending || !termInput.trim()}
							class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none font-mono shrink-0"
						>
							${termSending ? "…" : "Send"}
						</button>
					</div>
				</div>
			</div>
		</div>
	`;
}
