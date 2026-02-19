// EventsView — Live event feed with agent and level filters
// Preact+HTM component, no build step required.

import { html, useCallback, useMemo, useState } from "../lib/preact-setup.js";
import { truncate } from "../lib/utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso) {
	if (!iso) return "—";
	const d = new Date(iso);
	return [d.getHours(), d.getMinutes(), d.getSeconds()]
		.map((n) => String(n).padStart(2, "0"))
		.join(":");
}

const EVENT_TYPE_COLORS = {
	tool_start: "text-blue-400",
	tool_end: "text-blue-400",
	session_start: "text-green-400",
	session_end: "text-green-400",
	mail_sent: "text-purple-400",
	mail_received: "text-purple-400",
	spawn: "text-yellow-400",
	error: "text-red-500",
	custom: "text-gray-400",
};

const EVENT_TYPE_LABELS = {
	tool_start: "TOOL+",
	tool_end: "TOOL-",
	session_start: "SESS+",
	session_end: "SESS-",
	mail_sent: "MAIL>",
	mail_received: "MAIL<",
	spawn: "SPAWN",
	error: "ERROR",
	custom: "CUSTOM",
};

function eventDetail(event) {
	if (event.eventType === "tool_start" || event.eventType === "tool_end") {
		const args = event.toolArgs ? ` ${truncate(event.toolArgs, 80)}` : "";
		return `${event.toolName || ""}${args}`;
	}
	if (event.eventType === "error") {
		return truncate(event.data || "", 120);
	}
	return truncate(event.data || event.eventType || "", 100);
}

// ---------------------------------------------------------------------------
// EventsView
// ---------------------------------------------------------------------------

export function EventsView({ events }) {
	const [agentFilter, setAgentFilter] = useState("");
	const [levelFilter, setLevelFilter] = useState("");

	const safeEvents = events || [];

	const agentNames = useMemo(
		() => [...new Set(safeEvents.map((e) => e.agentName).filter(Boolean))].sort(),
		[safeEvents],
	);

	const filtered = useMemo(() => {
		let result = safeEvents;
		if (agentFilter) result = result.filter((e) => e.agentName === agentFilter);
		if (levelFilter) result = result.filter((e) => e.level === levelFilter);
		return [...result].sort(
			(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		);
	}, [safeEvents, agentFilter, levelFilter]);

	const onAgentChange = useCallback((e) => setAgentFilter(e.target.value), []);
	const onLevelChange = useCallback((e) => setLevelFilter(e.target.value), []);

	const dropdownClass =
		"bg-surface border border-border rounded-sm px-3 py-1.5 text-sm text-gray-200 focus:outline-none";

	return html`
		<div class="flex flex-col gap-3 h-full">
			<!-- Filter Bar -->
			<div class="flex flex-row gap-3 items-center">
				<select class=${dropdownClass} value=${agentFilter} onChange=${onAgentChange}>
					<option value="">All Agents</option>
					${agentNames.map((name) => html`<option key=${name} value=${name}>${name}</option>`)}
				</select>
				<select class=${dropdownClass} value=${levelFilter} onChange=${onLevelChange}>
					<option value="">All Levels</option>
					<option value="debug">Debug</option>
					<option value="info">Info</option>
					<option value="warn">Warn</option>
					<option value="error">Error</option>
				</select>
			</div>

			<!-- Event Feed -->
			<div class="flex flex-col gap-0.5 overflow-y-auto min-h-0 flex-1">
				${
					filtered.length === 0
						? html`<div class="text-gray-500 text-center py-8">No events</div>`
						: filtered.map((event) => {
								const colorClass = EVENT_TYPE_COLORS[event.eventType] || "text-gray-400";
								const label =
									EVENT_TYPE_LABELS[event.eventType] || event.eventType?.toUpperCase() || "?";
								const detail = eventDetail(event);
								return html`
							<div
								key=${event.id}
								class="flex flex-row gap-3 items-baseline text-sm py-0.5 hover:bg-white/5 rounded-sm"
							>
								<span class="font-mono text-gray-500 text-xs shrink-0 w-20">
									${formatTimestamp(event.createdAt)}
								</span>
								<span class=${`font-mono text-xs shrink-0 w-14 ${colorClass}`}>
									${label}
								</span>
								<span class="text-gray-300 shrink-0 min-w-0 max-w-[120px] truncate">
									${event.agentName || ""}
								</span>
								<span class="text-gray-400 truncate min-w-0">${detail}</span>
							</div>
						`;
							})
				}
			</div>
		</div>
	`;
}
