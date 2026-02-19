// Legio Web UI — Core Application (Preact + HTM + Tailwind)
// ES module: imports from lib/ siblings and all views from views/.

import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { appState, setLastUpdated } from './lib/state.js';
import { ChatView } from './views/chat.js';
import { DashboardView } from './views/dashboard.js';
import { EventsView } from './views/events.js';
import { IssuesView } from './views/issues.js';
import { InspectView } from './views/inspect.js';
import { CostsView } from './views/costs.js';
import { TerminalView } from './views/terminal.js';
import { connectWS } from './lib/ws.js';
import { fetchJson } from './lib/api.js';
import { timeAgo } from './lib/utils.js';
import { AutopilotView } from './views/autopilot.js';

// ===== Initial Data Fetch =====

export async function initData() {
	const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	try {
		const [status, mail, agents, events, metrics, mergeQueue, issues] = await Promise.all([
			fetchJson('/api/status').catch(() => null),
			fetchJson('/api/mail').catch(() => []),
			fetchJson('/api/agents').catch(() => []),
			fetchJson(`/api/events?since=${encodeURIComponent(since24h)}&limit=200`).catch(() => []),
			fetchJson('/api/metrics').catch(() => []),
			fetchJson('/api/merge-queue').catch(() => []),
			fetchJson('/api/issues').catch(() => []),
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
		console.error('[legio] initData error:', e);
	}
}

// ===== Hash Router Helpers =====

function parseHash(hash) {
	const withoutHash = (hash || '#chat').replace(/^#\/?/, '');
	const parts = withoutHash.split('/');
	return { view: parts[0] || 'chat', param: parts[1] ?? null };
}

// ===== Router =====

function Router({ view, param }) {
	const chatState = {
		mail: appState.mail.value,
		agents: appState.agents.value,
		issues: appState.issues.value,
	};
	switch (view) {
		case 'chat':      return html`<${ChatView} state=${chatState} />`;
		case 'dashboard': return html`<${DashboardView} agents=${appState.agents.value} mail=${appState.mail.value} mergeQueue=${appState.mergeQueue.value} status=${appState.status.value} />`;
		case 'events':    return html`<${EventsView} events=${appState.events.value} />`;
		case 'costs':     return html`<${CostsView} metrics=${appState.metrics.value} snapshots=${appState.snapshots.value} />`;
		case 'issues':    return html`<${IssuesView} issues=${appState.issues.value} />`;
		case 'inspect':   return html`<${InspectView} agentName=${param} />`;
		case 'terminal':  return html`<${TerminalView} />`;
		case 'autopilot': return html`<${AutopilotView} />`;
		default:          return html`<${ChatView} />`;
	}
}

// ===== Layout =====

const NAV_LINKS = [
	{ href: '#chat',      label: 'Chat',      view: 'chat' },
	{ href: '#dashboard', label: 'Dashboard', view: 'dashboard' },
	{ href: '#events',    label: 'Events',    view: 'events' },
	{ href: '#costs',     label: 'Costs',     view: 'costs' },
	{ href: '#issues',    label: 'Issues',    view: 'issues' },
	{ href: '#terminal',  label: 'Terminal',  view: 'terminal' },
	{ href: '#autopilot', label: 'Autopilot', view: 'autopilot' },
];

function Layout({ view, param }) {
	const connected = appState.connected.value;
	const lastUpdated = appState.lastUpdated.value;

	return html`
		<div class="flex flex-col h-screen bg-[#0f0f0f]">
			<nav class="flex items-center justify-between px-4 border-b border-[#2a2a2a] bg-[#1a1a1a] shrink-0">
				<div class="flex items-center">
					${NAV_LINKS.map(link => {
						const isActive = link.view === view;
						return html`
							<a
								key=${link.view}
								href=${link.href}
								class=${'px-4 py-3 text-sm font-medium transition-colors border-b-2 ' +
									(isActive
										? 'text-white border-[#E64415]'
										: 'text-[#888] border-transparent hover:text-[#ccc]')}
							>
								${link.label}
							</a>
						`;
					})}
				</div>
				<div class="flex items-center gap-3 pr-2">
					<span
						class=${'w-2 h-2 rounded-full ' + (connected ? 'bg-green-500' : 'bg-[#444]')}
						title=${connected ? 'WebSocket connected' : 'WebSocket disconnected'}
					></span>
					${lastUpdated ? html`
						<span class="text-[#555] text-xs font-mono">${timeAgo(lastUpdated)}</span>
					` : null}
				</div>
			</nav>
			<main class="flex-1 overflow-auto min-h-0">
				<${Router} view=${view} param=${param} />
			</main>
		</div>
	`;
}

// ===== App =====

function App() {
	const [route, setRoute] = useState(() => parseHash(location.hash));

	useEffect(() => {
		const onHashChange = () => setRoute(parseHash(location.hash));
		window.addEventListener('hashchange', onHashChange);
		return () => window.removeEventListener('hashchange', onHashChange);
	}, []);

	useEffect(() => {
		initData();
		connectWS();
	}, []);

	return html`<${Layout} view=${route.view} param=${route.param} />`;
}

// ===== Mount =====

document.addEventListener('DOMContentLoaded', () => {
	render(html`<${App} />`, document.getElementById('app'));
});
