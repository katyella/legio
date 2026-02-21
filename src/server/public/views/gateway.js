// views/gateway.js — Gateway chat view
// Provides start/stop controls and a chat interface for the legio gateway process.
// Polls GET /api/terminal/capture?agent=gateway for terminal output when running.

import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";

const POLL_INTERVAL_MS = 2500;

export function GatewayView() {
	const [running, setRunning] = useState(false);
	const [tmuxSession, setTmuxSession] = useState(null);
	const [statusLoading, setStatusLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState(false);
	const [actionError, setActionError] = useState("");
	const [text, setText] = useState("");
	const [sendError, setSendError] = useState("");
	const [sending, setSending] = useState(false);
	const [termOutput, setTermOutput] = useState("");
	const pollRef = useRef(null);
	const outputRef = useRef(null);

	// Fetch gateway status
	const fetchStatus = useCallback(async () => {
		try {
			const res = await fetch("/api/gateway/status");
			if (res.ok) {
				const data = await res.json();
				setRunning(data.running);
				setTmuxSession(data.tmuxSession ?? null);
			}
		} catch {
			// ignore
		} finally {
			setStatusLoading(false);
		}
	}, []);

	// Poll terminal output
	const fetchTermOutput = useCallback(async () => {
		try {
			const res = await fetch("/api/terminal/capture?agent=gateway&lines=100");
			if (res.ok) {
				const data = await res.json();
				setTermOutput(typeof data.output === "string" ? data.output : "");
				// Auto-scroll to bottom
				if (outputRef.current) {
					outputRef.current.scrollTop = outputRef.current.scrollHeight;
				}
			}
		} catch {
			// ignore
		}
	}, []);

	// Initial status fetch
	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	// Start/stop polling based on running state
	useEffect(() => {
		if (running) {
			fetchTermOutput();
			pollRef.current = setInterval(fetchTermOutput, POLL_INTERVAL_MS);
		} else {
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
			setTermOutput("");
		}
		return () => {
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};
	}, [running, fetchTermOutput]);

	const handleStart = useCallback(async () => {
		setActionLoading(true);
		setActionError("");
		try {
			const res = await fetch("/api/gateway/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			if (res.ok) {
				setRunning(true);
				await fetchStatus();
			} else {
				const err = await res.json().catch(() => ({}));
				setActionError(err.error || "Failed to start gateway");
			}
		} catch (e) {
			setActionError(e.message || "Failed to start gateway");
		} finally {
			setActionLoading(false);
		}
	}, [fetchStatus]);

	const handleStop = useCallback(async () => {
		setActionLoading(true);
		setActionError("");
		try {
			const res = await fetch("/api/gateway/stop", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			if (res.ok) {
				setRunning(false);
				setTmuxSession(null);
			} else {
				const err = await res.json().catch(() => ({}));
				setActionError(err.error || "Failed to stop gateway");
			}
		} catch (e) {
			setActionError(e.message || "Failed to stop gateway");
		} finally {
			setActionLoading(false);
		}
	}, []);

	const handleSend = useCallback(async () => {
		const trimmed = text.trim();
		if (!trimmed) return;
		setSendError("");
		setSending(true);
		try {
			const res = await fetch("/api/gateway/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: trimmed }),
			});
			if (res.ok) {
				setText("");
				// Fetch output shortly after to show response
				setTimeout(fetchTermOutput, 600);
			} else {
				const err = await res.json().catch(() => ({}));
				setSendError(err.error || "Send failed");
			}
		} catch (e) {
			setSendError(e.message || "Send failed");
		} finally {
			setSending(false);
		}
	}, [text, fetchTermOutput]);

	const handleKeyDown = useCallback(
		(e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend],
	);

	if (statusLoading) {
		return html`
			<div class="flex items-center justify-center h-full bg-[#0f0f0f] text-[#555] text-sm">
				Checking gateway status...
			</div>
		`;
	}

	return html`
		<div class="flex flex-col h-full bg-[#0f0f0f]">

			<!-- Header bar -->
			<div class="flex items-center gap-3 px-4 py-3 border-b border-[#2a2a2a] bg-[#1a1a1a] shrink-0">
				<span class="text-sm font-semibold text-[#e5e5e5]">Gateway</span>
				<!-- Status indicator -->
				<span class=${`w-2 h-2 rounded-full shrink-0 ${running ? "bg-green-500" : "bg-[#444]"}`}
					title=${running ? "Running" : "Stopped"}
				></span>
				<span class=${`text-xs ${running ? "text-green-400" : "text-[#555]"}`}>
					${running ? (tmuxSession ? `Running (${tmuxSession})` : "Running") : "Stopped"}
				</span>
				<span class="flex-1"></span>
				${
					running
						? html`<button
							onClick=${handleStop}
							disabled=${actionLoading}
							class="text-xs px-3 py-1 rounded border border-[#444] text-[#e5e5e5] bg-transparent hover:bg-[#2a2a2a] disabled:opacity-50 cursor-pointer"
						>
							${actionLoading ? "Stopping..." : "Stop Gateway"}
						</button>`
						: html`<button
							onClick=${handleStart}
							disabled=${actionLoading}
							class="text-xs px-3 py-1 rounded bg-[#E64415] hover:bg-[#cc3d12] text-white disabled:opacity-50 cursor-pointer border-none"
						>
							${actionLoading ? "Starting..." : "Start Gateway"}
						</button>`
				}
			</div>

			${actionError && html`<div class="px-4 py-2 text-xs text-red-400 bg-[#1a0a0a] border-b border-[#3a1a1a]">${actionError}</div>`}

			${
				!running
					? html`
						<div class="flex flex-col items-center justify-center flex-1 gap-3 text-[#555]">
							<p class="text-sm">Gateway is not running.</p>
							<button
								onClick=${handleStart}
								disabled=${actionLoading}
								class="text-sm px-4 py-2 rounded bg-[#E64415] hover:bg-[#cc3d12] text-white disabled:opacity-50 cursor-pointer border-none"
							>
								${actionLoading ? "Starting..." : "Start Gateway"}
							</button>
						</div>
					`
					: html`
						<!-- Terminal output area -->
						<div
							ref=${outputRef}
							class="flex-1 overflow-y-auto p-4 font-mono text-xs text-[#e5e5e5] whitespace-pre-wrap min-h-0"
							style="background:#0a0a0a"
						>
							${termOutput || html`<span class="text-[#555]">No output yet...</span>`}
						</div>

						<!-- Chat input -->
						<div class="border-t border-[#2a2a2a] p-3 shrink-0">
							<div class="flex gap-2 items-end">
								<textarea
									placeholder="Send text to gateway... (Ctrl+Enter to send)"
									rows="2"
									value=${text}
									onInput=${(e) => setText(e.target.value)}
									onKeyDown=${handleKeyDown}
									class="flex-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415] resize-none"
								/>
								<button
									onClick=${handleSend}
									disabled=${sending || !text.trim()}
									class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none self-end"
								>
									${sending ? "..." : "Send"}
								</button>
							</div>
							${sendError && html`<span class="text-xs text-red-400 mt-1 block">${sendError}</span>`}
						</div>
					`
			}
		</div>
	`;
}
