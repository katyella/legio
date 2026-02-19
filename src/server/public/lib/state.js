// Legio Web UI — Reactive State (Preact Signals)
// All UI state lives here as signals so components re-render automatically.

import { computed, signal } from "@preact/signals";

export const appState = {
	agents: signal([]),
	mail: signal([]),
	mergeQueue: signal([]),
	metrics: signal([]),
	snapshots: signal([]),
	runs: signal({ active: null, list: [] }),
	events: signal([]),
	errors: signal([]),
	issues: signal([]),
	audit: signal([]),
	config: signal(null),
	status: signal(null),
	autopilot: signal(null),
	connected: signal(false),
	lastUpdated: signal(null),
	selectedAgent: signal(null),
	inspectAgent: signal(null),
	inspectData: signal(null),
	selectedPair: signal(null),
	collapsedThreads: signal(new Set()),
};

export function setConnected(value) {
	appState.connected.value = value;
}

export function setLastUpdated() {
	appState.lastUpdated.value = new Date().toISOString();
}

// Computed: agents that are working or booting
export const activeAgents = computed(() =>
	appState.agents.value.filter((a) => a.state === "working" || a.state === "booting"),
);

// Computed: count of unread mail messages
export const unreadMailCount = computed(() => appState.mail.value.filter((m) => !m.readAt).length);

// Agent activity events detected from WebSocket snapshot diffs
export const agentActivityLog = signal([]);

/**
 * Compare two agent arrays and append activity events to agentActivityLog.
 * Detects: spawned (new agent), state_change, removed.
 * Keeps a max of 200 entries (trims from front).
 */
export function recordAgentDiff(prevAgents, nextAgents) {
	const prevMap = new Map((prevAgents ?? []).map((a) => [a.agentName ?? a.name, a]));
	const nextMap = new Map((nextAgents ?? []).map((a) => [a.agentName ?? a.name, a]));
	const events = [];
	const timestamp = new Date().toISOString();

	for (const [name, next] of nextMap) {
		const prev = prevMap.get(name);
		if (!prev) {
			events.push({
				type: "spawned",
				agent: name,
				capability: next.capability ?? null,
				beadId: next.beadId ?? next.taskId ?? null,
				timestamp,
			});
		} else if (prev.state !== next.state) {
			events.push({
				type: "state_change",
				agent: name,
				capability: next.capability ?? null,
				from: prev.state,
				to: next.state,
				beadId: next.beadId ?? next.taskId ?? null,
				timestamp,
			});
		}
	}

	for (const [name, prev] of prevMap) {
		if (!nextMap.has(name)) {
			events.push({
				type: "removed",
				agent: name,
				capability: prev.capability ?? null,
				beadId: prev.beadId ?? prev.taskId ?? null,
				timestamp,
			});
		}
	}

	if (events.length === 0) return;

	const combined = [...agentActivityLog.value, ...events];
	agentActivityLog.value = combined.length > 200 ? combined.slice(combined.length - 200) : combined;
}
