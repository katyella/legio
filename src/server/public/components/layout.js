// Legio Web UI — Layout components
// App shell: NavBar, WsIndicator, Layout wrapper.
// No npm dependencies — uses CDN imports. Served as a static ES module.

import { h } from "https://esm.sh/preact@latest";
import htm from "https://esm.sh/htm@latest";

const html = htm.bind(h);

const NAV_LINKS = [
	{ label: "Chat", hash: "/" },
	{ label: "Dashboard", hash: "dashboard" },
	{ label: "Events", hash: "events" },
	{ label: "Costs", hash: "costs" },
	{ label: "Issues", hash: "issues" },
];

/**
 * WsIndicator — shows WebSocket connection state.
 *
 * @param {object} props
 * @param {boolean} props.connected - Whether the WebSocket is connected
 */
export function WsIndicator({ connected }) {
	return html`
		<div class="flex items-center gap-1.5 text-xs">
			<span
				class=${`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
			></span>
			<span class=${connected ? "text-green-400" : "text-red-400"}>
				${connected ? "connected" : "disconnected"}
			</span>
		</div>
	`;
}

/**
 * NavBar — horizontal top navigation bar.
 *
 * @param {object} props
 * @param {string} props.currentView - Active view name (matches NAV_LINKS hash)
 * @param {boolean} props.wsConnected - WebSocket connection state
 */
export function NavBar({ currentView, wsConnected }) {
	return html`
		<nav class="bg-[#0f0f0f] border-b border-[#2a2a2a] px-4 h-12 flex items-center justify-between">
			<div class="flex items-center gap-6">
				<span class="font-bold text-[#e5e5e5] text-sm tracking-wide">legio</span>
				<div class="flex items-center gap-0">
					${NAV_LINKS.map(
						(link) => html`
							<a
								key=${link.hash}
								href=${`#${link.hash}`}
								class=${[
									"px-3 h-12 flex items-center text-sm transition-colors",
									currentView === link.hash
										? "text-[#E64415] border-b-2 border-[#E64415]"
										: "text-[#999] hover:text-[#e5e5e5]",
								].join(" ")}
							>
								${link.label}
							</a>
						`,
					)}
				</div>
			</div>
			<${WsIndicator} connected=${wsConnected} />
		</nav>
	`;
}

/**
 * Layout — app shell wrapping children with NavBar on top.
 *
 * @param {object} props
 * @param {string} props.currentView - Active view name passed to NavBar
 * @param {boolean} props.wsConnected - WebSocket connection state
 * @param {*} props.children - Page content
 */
export function Layout({ currentView, wsConnected, children }) {
	return html`
		<div class="min-h-screen bg-[#0f0f0f] text-[#e5e5e5]">
			<${NavBar} currentView=${currentView} wsConnected=${wsConnected} />
			<main class="max-w-7xl mx-auto px-4 py-6">${children}</main>
		</div>
	`;
}
