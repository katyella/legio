// Legio Web UI — TerminalView component
// Preact+HTM component providing a terminal-like interface for interacting
// with the coordinator's Claude Code session from the browser.
// No npm dependencies — uses importmap bare specifiers. Served as a static ES module.

import { html } from "htm/preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";

// Strip ANSI escape sequences from terminal output before display
function stripAnsi(str) {
	return str.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
}

/**
 * TerminalView — browser terminal interface for agent tmux sessions.
 *
 * - Polls GET /api/terminal/capture every 2.5 seconds for pane output
 * - POSTs to /api/terminal/send on input submit
 * - Agent selector defaults to "coordinator"
 * - Handles fetch failures gracefully (shows error, does not crash)
 */
export function TerminalView() {
	const [output, setOutput] = useState("");
	const [input, setInput] = useState("");
	const [agent, setAgent] = useState("coordinator");
	const [agentList, setAgentList] = useState(["coordinator"]);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState("");
	const [connected, setConnected] = useState(false);
	const [lastRefresh, setLastRefresh] = useState(null);

	const outputRef = useRef(null);
	const isNearBottomRef = useRef(true);
	const intervalRef = useRef(null);

	// Smart scroll: scroll to bottom only when user is near the bottom
	const scrollToBottomIfNear = useCallback(() => {
		const el = outputRef.current;
		if (el && isNearBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, []);

	const handleOutputScroll = useCallback(() => {
		const el = outputRef.current;
		if (!el) return;
		isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
	}, []);

	// Fetch the current terminal capture from the backend
	const fetchCapture = useCallback(async () => {
		try {
			const res = await fetch(
				`/api/terminal/capture?agent=${encodeURIComponent(agent)}&lines=100`,
			);
			if (!res.ok) {
				setConnected(false);
				setError(`Capture failed: HTTP ${res.status}`);
				return;
			}
			const data = await res.json();
			setConnected(true);
			setError("");
			setOutput(stripAnsi(data.output || ""));
			setLastRefresh(data.timestamp || new Date().toISOString());
			requestAnimationFrame(scrollToBottomIfNear);
		} catch (e) {
			setConnected(false);
			setError(e.message || "Failed to reach server");
		}
	}, [agent, scrollToBottomIfNear]);

	// Fetch agent list from /api/agents on mount
	useEffect(() => {
		fetch("/api/agents")
			.then((r) => r.json())
			.then((data) => {
				if (Array.isArray(data) && data.length > 0) {
					const names = data.map((a) => a.agentName).filter(Boolean);
					if (names.length > 0) setAgentList(names);
				}
			})
			.catch(() => {
				// API not yet available — keep default ["coordinator"]
			});
	}, []);

	// Auto-refresh every 2.5 seconds; restart interval when agent changes
	useEffect(() => {
		fetchCapture();
		intervalRef.current = setInterval(fetchCapture, 2500);
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [fetchCapture]);

	// Send input text to the targeted agent's tmux session
	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text) return;
		setSending(true);
		setError("");
		try {
			const res = await fetch("/api/terminal/send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, agent }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.error || `Send failed: HTTP ${res.status}`);
			}
			setInput("");
			// Refresh output shortly after sending so the response appears quickly
			setTimeout(fetchCapture, 400);
		} catch (e) {
			setError(e.message || "Send failed");
		} finally {
			setSending(false);
		}
	}, [input, agent, fetchCapture]);

	const handleKeyDown = useCallback(
		(e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend],
	);

	const handleClear = useCallback(() => setOutput(""), []);

	const inputCls =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415]";

	return html`
		<div class="flex flex-col h-full bg-[#0f0f0f]">

			<!-- Toolbar -->
			<div class="flex items-center justify-between px-4 py-2 border-b border-[#2a2a2a] bg-[#1a1a1a] shrink-0">
				<div class="flex items-center gap-3">
					<span class="text-[#e5e5e5] text-sm font-mono font-medium">Terminal</span>

					<!-- Agent selector -->
					<select
						value=${agent}
						onChange=${(e) => setAgent(e.target.value)}
						class="bg-[#0f0f0f] border border-[#2a2a2a] rounded px-2 py-0.5 text-xs text-[#e5e5e5] outline-none focus:border-[#E64415]"
					>
						${agentList.map(
							(name) => html`<option key=${name} value=${name}>${name}</option>`,
						)}
					</select>

					<!-- Connected / disconnected indicator -->
					<div class="flex items-center gap-1.5">
						<span
							class=${"w-2 h-2 rounded-full " + (connected ? "bg-green-500" : "bg-[#555]")}
						></span>
						<span class=${"text-xs font-mono " + (connected ? "text-green-400" : "text-[#555]")}>
							${connected ? "connected" : "disconnected"}
						</span>
					</div>
				</div>

				<div class="flex items-center gap-3">
					${lastRefresh
						? html`<span class="text-xs text-[#555] font-mono">
								${new Date(lastRefresh).toLocaleTimeString()}
							</span>`
						: null}
					<button
						onClick=${handleClear}
						class="text-xs text-[#666] hover:text-[#999] bg-transparent border-none cursor-pointer font-mono"
					>
						clear
					</button>
				</div>
			</div>

			<!-- Terminal output area -->
			<div
				ref=${outputRef}
				onScroll=${handleOutputScroll}
				class="flex-1 overflow-y-auto min-h-0 bg-[#0a0a0a] p-4"
			>
				${output
					? html`<pre
							class="text-[#e5e5e5] text-xs leading-relaxed whitespace-pre-wrap break-words m-0 font-mono"
						>${output}</pre>`
					: html`<div class="flex items-center justify-center h-full text-[#444] text-sm font-mono">
							No output — select an agent to begin
						</div>`}
			</div>

			<!-- Error bar (hidden when no error) -->
			${error
				? html`<div class="px-4 py-1.5 bg-[#1a0a0a] border-t border-red-900 shrink-0">
						<span class="text-xs text-red-400 font-mono">${error}</span>
					</div>`
				: null}

			<!-- Input row -->
			<div class="border-t border-[#2a2a2a] p-3 bg-[#0f0f0f] shrink-0">
				<div class="flex items-center gap-2">
					<span class="text-[#E64415] font-mono text-sm shrink-0 select-none">$</span>
					<input
						type="text"
						placeholder="Type a command or prompt..."
						value=${input}
						onInput=${(e) => setInput(e.target.value)}
						onKeyDown=${handleKeyDown}
						disabled=${sending}
						class=${"flex-1 " + inputCls + " font-mono disabled:opacity-50"}
					/>
					<button
						onClick=${handleSend}
						disabled=${sending || !input.trim()}
						class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none font-mono shrink-0"
					>
						${sending ? "…" : "Send"}
					</button>
				</div>
			</div>

		</div>
	`;
}
