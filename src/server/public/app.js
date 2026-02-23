// Legio Web UI — Core Application (Preact + HTM + Tailwind)
// ES module: imports from lib/ siblings and all views from views/.

import { html } from "htm/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { SpawnDialog } from "./components/spawn-dialog.js";
import { fetchJson } from "./lib/api.js";
import { appState, setLastUpdated } from "./lib/state.js";
import { timeAgo } from "./lib/utils.js";
import { connectWS } from "./lib/ws.js";
import { CostsView } from "./views/costs.js";
import { DashboardView } from "./views/dashboard.js";
import { InspectView } from "./views/inspect.js";
import { IssuesView } from "./views/issues.js";
import { SetupView } from "./views/setup.js";
import { StrategyView } from "./views/strategy.js";
import { TaskDetailView } from "./views/task-detail.js";

// ===== Initial Data Fetch =====

export async function initData() {
	const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	try {
		const [status, mail, agents, events, metrics, mergeQueue, issues] = await Promise.all([
			fetchJson("/api/status").catch(() => null),
			fetchJson("/api/mail").catch(() => []),
			fetchJson("/api/agents").catch(() => []),
			fetchJson(`/api/events?since=${encodeURIComponent(since24h)}&limit=200`).catch(() => []),
			fetchJson("/api/metrics").catch(() => []),
			fetchJson("/api/merge-queue").catch(() => []),
			fetchJson("/api/issues").catch(() => []),
		]);

		if (status !== null) appState.status.value = status;
		appState.agents.value = agents ?? [];
		appState.mail.value = Array.isArray(mail) ? mail : (mail?.recent ?? []);
		appState.events.value = events ?? [];
		appState.metrics.value = metrics ?? [];
		appState.mergeQueue.value = mergeQueue ?? [];
		appState.issues.value = issues ?? [];
		setLastUpdated();
	} catch (e) {
		console.error("[legio] initData error:", e);
	}
}

// ===== Hash Router Helpers =====

function parseHash(hash) {
	const withoutHash = (hash || "#dashboard").replace(/^#\/?/, "");
	const parts = withoutHash.split("/");
	return { view: parts[0] || "dashboard", param: parts[1] ?? null };
}

// ===== Router =====

function Router({ view, param }) {
	switch (view) {
		case "dashboard":
			return html`<${DashboardView} />`;
		case "costs":
			return html`<${CostsView} metrics=${appState.metrics.value} snapshots=${appState.snapshots.value} />`;
		case "tasks":
			return html`<${IssuesView} />`;
		case "task":
			return html`<${TaskDetailView} taskId=${param} />`;
		case "inspect":
			return html`<${InspectView} agentName=${param} />`;
		case "strategy":
			return html`<${StrategyView} />`;
		default:
			return html`<${DashboardView} />`;
	}
}

// ===== Layout =====

const NAV_LINKS = [
	{ href: "#dashboard", label: "Dashboard", view: "dashboard" },
	{ href: "#costs", label: "Costs", view: "costs" },
	{ href: "#tasks", label: "Tasks", view: "tasks" },
	{ href: "#strategy", label: "Strategy", view: "strategy" },
];

function Layout({ view, param }) {
	const connected = appState.connected.value;
	const lastUpdated = appState.lastUpdated.value;

	return html`
		<div class="flex flex-col h-screen bg-[#0f0f0f]">
			<nav class="flex items-center justify-between px-4 border-b border-[#2a2a2a] bg-[#1a1a1a] shrink-0">
				<div class="flex items-center">
					${NAV_LINKS.map((link) => {
						const isActive = link.view === view;
						return html`
							<a
								key=${link.view}
								href=${link.href}
								class=${
									"px-4 py-3 text-sm font-medium transition-colors border-b-2 " +
									(isActive
										? "text-white border-[#E64415]"
										: "text-[#888] border-transparent hover:text-[#ccc]")
								}
							>
								${link.label}
							</a>
						`;
					})}
				</div>
				<div class="flex items-center gap-3 pr-2">
					<span
						class=${"w-2 h-2 rounded-full " + (connected ? "bg-green-500" : "bg-[#444]")}
						title=${connected ? "WebSocket connected" : "WebSocket disconnected"}
					></span>
					${
						lastUpdated
							? html`
						<span class="text-[#555] text-xs font-mono">${timeAgo(lastUpdated)}</span>
					`
							: null
					}
				</div>
			</nav>
			<main class="flex-1 overflow-auto min-h-0">
				<${Router} key=${view} view=${view} param=${param} />
			</main>
			<${SpawnDialog} />
		</div>
	`;
}

// ===== App =====

function App() {
	const [route, setRoute] = useState(() => parseHash(location.hash));
	const [setupChecked, setSetupChecked] = useState(false);
	const [isInitialized, setIsInitialized] = useState(true); // assume initialized until checked
	const [setupStatus, setSetupStatus] = useState(null);

	useEffect(() => {
		const onHashChange = () => {
			const hash = location.hash;
			if (hash === "#issues" || hash === "issues") {
				window.location.hash = "#tasks";
				return; // will re-trigger the hash change handler
			}
			if (hash === "#command" || hash === "command") {
				window.location.hash = "#dashboard";
				return; // will re-trigger the hash change handler
			}
			if (hash === "#gateway" || hash === "gateway") {
				window.location.hash = "#dashboard";
				return; // will re-trigger the hash change handler
			}
			setRoute(parseHash(hash));
		};
		// Redirect legacy #issues hash on initial load
		if (location.hash === "#issues" || location.hash === "issues") {
			window.location.hash = "#tasks";
		}
		// Redirect legacy #command hash on initial load
		if (location.hash === "#command" || location.hash === "command") {
			window.location.hash = "#dashboard";
		}
		// Redirect legacy #gateway hash on initial load
		if (location.hash === "#gateway" || location.hash === "gateway") {
			window.location.hash = "#dashboard";
		}
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	useEffect(() => {
		connectWS();
		fetchJson("/api/setup/status")
			.then((data) => {
				setIsInitialized(data.initialized);
				setSetupStatus(data);
				setSetupChecked(true);
				if (data.initialized) initData(); // Only load data if initialized
			})
			.catch(() => {
				setSetupChecked(true);
				initData(); // Fallback: try loading data anyway
			});
	}, []);

	if (!setupChecked)
		return html`<div class="flex items-center justify-center h-screen bg-[#0f0f0f] text-[#555] text-sm">Loading...</div>`;
	if (!isInitialized)
		return html`<${SetupView}
		onInitialized=${() => {
			setIsInitialized(true);
			initData();
		}}
		projectRoot=${setupStatus?.projectRoot ?? null}
	/>`;

	return html`<${Layout} view=${route.view} param=${route.param} />`;
}

// ===== Mount =====

document.addEventListener("DOMContentLoaded", () => {
	render(html`<${App} />`, document.getElementById("app"));
});
