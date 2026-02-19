// Legio Web UI — WebSocket Client
// Auto-reconnecting WebSocket that pushes snapshots into Preact signals.

import { appState, setConnected, setLastUpdated } from "./state.js";

let ws = null;
let reconnectTimer = null;

function handleSnapshot(d) {
	if (d.agents !== undefined) appState.agents.value = d.agents;
	// WS sends mail as { unreadCount, recent }; REST API sends flat MailMessage[].
	// Normalize to a flat array in both cases.
	if (d.mail !== undefined) {
		appState.mail.value = Array.isArray(d.mail) ? d.mail : d.mail.recent || [];
	}
	if (d.mergeQueue !== undefined) appState.mergeQueue.value = d.mergeQueue;
	if (d.metrics !== undefined) appState.metrics.value = d.metrics;
	if (d.snapshots !== undefined) appState.snapshots.value = d.snapshots;
	if (d.runs !== undefined) appState.runs.value = d.runs;
	if (d.events !== undefined) appState.events.value = d.events;
	if (d.errors !== undefined) appState.errors.value = d.errors;
	if (d.config !== undefined) appState.config.value = d.config;
	if (d.status !== undefined) appState.status.value = d.status;
	if (d.autopilot !== undefined) appState.autopilot.value = d.autopilot;
	setLastUpdated();
}

export function connectWS() {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	ws = new WebSocket(`ws://${location.host}/ws`);

	ws.addEventListener("open", () => {
		setConnected(true);
	});

	ws.addEventListener("message", (event) => {
		let msg;
		try {
			msg = JSON.parse(event.data);
		} catch (_e) {
			console.warn("[legio] unparseable WS message:", event.data);
			return;
		}
		if (msg.type === "snapshot") {
			handleSnapshot(msg.data || {});
		}
	});

	ws.addEventListener("close", () => {
		setConnected(false);
		reconnectTimer = setTimeout(connectWS, 3000);
	});

	ws.addEventListener("error", (event) => {
		console.error("[legio] WebSocket error:", event);
	});
}

export function requestRefresh() {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "refresh" }));
	}
}
