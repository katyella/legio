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
