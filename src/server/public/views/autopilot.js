// Legio Web UI — AutopilotView component
// Preact+HTM component for the autopilot control panel.
// Displays status, start/stop controls, configuration, and recent actions.
// No npm dependencies — uses importmap bare specifiers. Served as a static ES module.

import { html, useState, useEffect, useCallback } from "../lib/preact-setup.js";

// Action type → color class mapping
const ACTION_COLORS = {
	merge: "text-green-500",
	mail_processed: "text-blue-400",
	worktree_cleaned: "text-yellow-500",
	error: "text-red-500",
};

function actionColor(type) {
	return ACTION_COLORS[type] ?? "text-gray-500";
}

function formatTime(iso) {
	if (!iso) return "—";
	return new Date(iso).toLocaleTimeString();
}

function formatDuration(iso) {
	if (!iso) return null;
	const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
	return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function StatusCard({ state, loading, onStart, onStop }) {
	const running = state?.running ?? false;
	const since = state?.startedAt ?? null;
	const ticks = state?.tickCount ?? 0;

	return html`
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-4 flex flex-col gap-3">
			<span class="text-xs font-bold uppercase tracking-wider text-gray-400">Status</span>

			<div class="flex items-center gap-2">
				<span class=${"w-2.5 h-2.5 rounded-full shrink-0 " + (running ? "bg-green-500" : "bg-[#444]")}></span>
				<span class=${"text-sm font-mono font-medium " + (running ? "text-green-400" : "text-gray-500")}>
					${running ? "Running" : "Stopped"}
				</span>
			</div>

			${running && since ? html`
				<div class="text-xs text-gray-500 font-mono">
					Since: ${formatTime(since)}
					${formatDuration(since) ? html` (${formatDuration(since)})` : null}
				</div>
			` : null}

			<div class="text-xs text-gray-500 font-mono">
				Ticks: ${ticks}
			</div>

			<div class="mt-1">
				${running
					? html`
						<button
							onClick=${onStop}
							disabled=${loading}
							class="px-4 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-sm cursor-pointer border-none"
						>
							${loading ? "Stopping…" : "Stop"}
						</button>
					`
					: html`
						<button
							onClick=${onStart}
							disabled=${loading}
							class="px-4 py-1.5 text-sm font-medium bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-sm cursor-pointer border-none"
						>
							${loading ? "Starting…" : "Start"}
						</button>
					`}
			</div>
		</div>
	`;
}

function ConfigCard({ config }) {
	if (!config) {
		return html`
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-4 flex flex-col gap-3">
				<span class="text-xs font-bold uppercase tracking-wider text-gray-400">Configuration</span>
				<span class="text-xs text-gray-600 font-mono">Not available</span>
			</div>
		`;
	}

	const rows = [
		["Interval", config.intervalMs != null ? `${Math.round(config.intervalMs / 1000)}s` : "—"],
		["Auto-merge", config.autoMerge ? "✓" : "✗"],
		["Clean worktrees", config.cleanWorktrees ? "✓" : "✗"],
	];

	return html`
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-4 flex flex-col gap-3">
			<span class="text-xs font-bold uppercase tracking-wider text-gray-400">Configuration</span>
			<div class="flex flex-col gap-1.5">
				${rows.map(([key, val]) => html`
					<div key=${key} class="flex items-center justify-between text-xs font-mono">
						<span class="text-gray-500">${key}</span>
						<span class="text-gray-300">${val}</span>
					</div>
				`)}
			</div>
		</div>
	`;
}

function ActionLog({ actions }) {
	if (!actions || actions.length === 0) {
		return html`
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-4">
				<span class="text-xs font-bold uppercase tracking-wider text-gray-400">Recent Actions</span>
				<div class="mt-3 text-xs text-gray-600 font-mono">No actions yet</div>
			</div>
		`;
	}

	return html`
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded p-4">
			<span class="text-xs font-bold uppercase tracking-wider text-gray-400">Recent Actions</span>
			<div class="mt-2 flex flex-col">
				${actions.map((action, i) => html`
					<div key=${i} class="flex items-center gap-3 px-2 py-1 text-sm font-mono hover:bg-[#222] rounded">
						<span class="text-gray-500 shrink-0 text-xs">${formatTime(action.at)}</span>
						<span class=${actionColor(action.type)}>●</span>
						<span class="text-gray-300 text-xs">${action.details ?? action.type}</span>
					</div>
				`)}
			</div>
		</div>
	`;
}

export function AutopilotView({ autopilot = null }) {
	const [state, setState] = useState(autopilot);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(null);

	const fetchStatus = useCallback(async () => {
		try {
			const res = await fetch("/api/autopilot/status");
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			setState(await res.json());
		} catch (e) {
			setError(e.message ?? "Failed to fetch autopilot status");
		}
	}, []);

	// Fetch on mount if no prop data; also refresh when prop changes
	useEffect(() => {
		if (autopilot !== null) {
			setState(autopilot);
		} else {
			fetchStatus();
		}
	}, [autopilot, fetchStatus]);

	const handleStart = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/autopilot/start", { method: "POST" });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			setState(await res.json());
		} catch (e) {
			setError(e.message ?? "Failed to start autopilot");
		} finally {
			setLoading(false);
		}
	}, []);

	const handleStop = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/autopilot/stop", { method: "POST" });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? `HTTP ${res.status}`);
			}
			setState(await res.json());
		} catch (e) {
			setError(e.message ?? "Failed to stop autopilot");
		} finally {
			setLoading(false);
		}
	}, []);

	return html`
		<div class="flex flex-col h-full bg-[#0f0f0f]">

			<!-- Header -->
			<div class="px-4 py-3 border-b border-[#2a2a2a] bg-[#1a1a1a] shrink-0 flex items-center justify-between">
				<span class="text-sm font-mono font-medium text-[#e5e5e5] uppercase tracking-widest">Autopilot</span>
				<button
					onClick=${fetchStatus}
					disabled=${loading}
					class="text-xs text-[#666] hover:text-[#999] bg-transparent border-none cursor-pointer font-mono disabled:opacity-50"
				>
					refresh
				</button>
			</div>

			<!-- Error banner -->
			${error ? html`
				<div class="px-4 py-2 bg-[#1a0a0a] border-b border-red-900 shrink-0">
					<span class="text-xs text-red-400 font-mono">${error}</span>
				</div>
			` : null}

			<!-- Body -->
			<div class="flex-1 overflow-auto min-h-0 p-4">
				${state === null ? html`
					<div class="flex items-center justify-center h-full text-[#444] text-sm font-mono">
						Loading autopilot status…
					</div>
				` : html`
					<div class="grid grid-cols-10 gap-4 mb-4">
						<div class="col-span-4">
							<${StatusCard}
								state=${state}
								loading=${loading}
								onStart=${handleStart}
								onStop=${handleStop}
							/>
						</div>
						<div class="col-span-6">
							<${ConfigCard} config=${state.config ?? null} />
						</div>
					</div>
					<${ActionLog} actions=${state.actions ?? []} />
				`}
			</div>
		</div>
	`;
}
