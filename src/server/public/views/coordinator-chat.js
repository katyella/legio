// Legio Web UI — CoordinatorChat standalone component
// Refactored from command.js CoordinatorChat with persistent message history.
// Fetches /api/coordinator/chat/history on mount, sends via /api/coordinator/chat.

import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";
import { agentActivityLog, appState } from "../lib/state.js";
import { agentColor, groupActivityMessages, isActivityMessage, timeAgo } from "../lib/utils.js";

function stripAnsi(str) {
	return str.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
}

function diffCapture(baselineText, currentText) {
	const baselineLines = baselineText.trimEnd().split("\n");
	const currentLines = currentText.trimEnd().split("\n");
	const anchorLen = Math.min(3, baselineLines.length);
	const anchor = baselineLines.slice(-anchorLen);

	// Search for the anchor sequence in current capture (prefer latest match)
	for (let i = currentLines.length - anchorLen; i >= 0; i--) {
		let match = true;
		for (let j = 0; j < anchorLen; j++) {
			if (currentLines[i + j] !== anchor[j]) {
				match = false;
				break;
			}
		}
		if (match) {
			return currentLines.slice(i + anchorLen).join("\n");
		}
	}
	// Baseline scrolled off — show tail
	return currentLines.slice(-20).join("\n");
}

// Slash commands available in coordinator chat
const SLASH_COMMANDS = [
	{ cmd: "/status", desc: "Show agent status overview" },
	{ cmd: "/merge", desc: "Merge a completed branch" },
	{ cmd: "/nudge", desc: "Send a nudge to a stalled agent" },
	{ cmd: "/mail", desc: "Send mail to an agent" },
	{ cmd: "/help", desc: "Show available commands" },
];

// Map a persisted chat history message to the feed format
function mapHistoryMessage(msg) {
	return {
		id: msg.id,
		from: msg.role === "user" ? "you" : "coordinator",
		to: msg.role === "user" ? "coordinator" : "you",
		body: msg.content,
		createdAt: msg.createdAt,
		_persisted: true,
	};
}

// ===== CoordinatorChat =====

export function CoordinatorChat({ mail, headless }) {
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");
	const [pendingMessages, setPendingMessages] = useState([]);
	const [historyMessages, setHistoryMessages] = useState([]);
	const [thinking, setThinking] = useState(false);
	const [streamText, setStreamText] = useState("");
	const [dropdown, setDropdown] = useState({
		visible: false,
		items: [],
		selectedIndex: 0,
		type: "mention",
	});
	const feedRef = useRef(null);
	const isNearBottomRef = useRef(true);
	const prevFromCoordCountRef = useRef(0);
	const prevHistoryFromCoordCountRef = useRef(0);
	const inputRef = useRef(null);
	const pendingCursorRef = useRef(null);
	const baselineCaptureRef = useRef(null);

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5]" +
		" placeholder-[#666] outline-none focus:border-[#E64415]";

	// Load history on mount and poll for new messages
	useEffect(() => {
		let cancelled = false;

		async function fetchHistory() {
			try {
				const data = await fetchJson("/api/coordinator/chat/history?limit=100");
				if (!cancelled) {
					const msgs = Array.isArray(data) ? data : (data?.messages ?? []);
					setHistoryMessages(msgs.map(mapHistoryMessage));
				}
			} catch (_err) {
				// non-fatal — history may not be available yet
			}
		}

		fetchHistory();
		const interval = setInterval(fetchHistory, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	// Filter coordinator-related mail messages, sorted oldest first
	const coordMessages = [...mail]
		.filter(
			(m) =>
				m.from === "orchestrator" ||
				m.from === "coordinator" ||
				m.to === "orchestrator" ||
				m.to === "coordinator",
		)
		.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

	// Count messages FROM coordinator in mail — used to detect coordinator responses
	const fromCoordCount = coordMessages.filter(
		(m) => m.from === "orchestrator" || m.from === "coordinator",
	).length;

	// Count coordinator responses in history
	const historyFromCoordCount = historyMessages.filter((m) => m.from === "coordinator").length;

	// Detect new coordinator responses in mail → clear thinking + deduplicate pending
	useEffect(() => {
		if (fromCoordCount > prevFromCoordCountRef.current) {
			setThinking(false);
			setPendingMessages((prev) =>
				prev.filter(
					(pm) =>
						!coordMessages.some(
							(rm) =>
								rm.body === pm.body &&
								Math.abs(
									new Date(rm.createdAt).getTime() - new Date(pm.createdAt).getTime(),
								) < 60000,
						),
				),
			);
		}
		prevFromCoordCountRef.current = fromCoordCount;
	}, [fromCoordCount]); // eslint-disable-line react-hooks/exhaustive-deps

	// Detect new coordinator responses in history → clear thinking + deduplicate pending
	useEffect(() => {
		if (historyFromCoordCount > prevHistoryFromCoordCountRef.current) {
			setThinking(false);
			setPendingMessages((prev) =>
				prev.filter(
					(pm) =>
						!historyMessages.some(
							(hm) =>
								hm.from === "coordinator" &&
								hm.body === pm.body &&
								Math.abs(
									new Date(hm.createdAt).getTime() - new Date(pm.createdAt).getTime(),
								) < 60000,
						),
				),
			);
		}
		prevHistoryFromCoordCountRef.current = historyFromCoordCount;
	}, [historyFromCoordCount]); // eslint-disable-line react-hooks/exhaustive-deps

	// Poll terminal capture while coordinator is thinking (tmux mode only).
	// In headless mode, streaming is handled by the always-on effect below.
	useEffect(() => {
		if (!thinking) {
			if (!headless) {
				setStreamText("");
				baselineCaptureRef.current = null;
			}
			return;
		}

		// HEADLESS MODE: streaming handled by always-on effect; skip tmux polling
		if (headless) return;

		let cancelled = false;

		async function pollCapture() {
			try {
				const res = await fetch("/api/terminal/capture?agent=coordinator&lines=80");
				if (!res.ok || cancelled) return;
				const data = await res.json();
				const output = stripAnsi(data.output || "");

				if (baselineCaptureRef.current === null) {
					baselineCaptureRef.current = output;
					return;
				}

				const delta = diffCapture(baselineCaptureRef.current, output);
				if (!cancelled && delta.trim()) {
					setStreamText(delta);
				}
			} catch (_err) {
				// non-fatal — capture may fail if coordinator tmux not ready
			}
		}

		pollCapture();
		const interval = setInterval(pollCapture, 1500);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [thinking, headless]);

	// Always-on coordinator output stream for headless mode
	useEffect(() => {
		if (!headless) return;
		const handler = (e) => {
			setStreamText((prev) => {
				const combined = prev + e.detail.text;
				const lines = combined.split("\n");
				return lines.length > 100 ? lines.slice(-100).join("\n") : combined;
			});
		};
		window.addEventListener("coordinator-output", handler);
		return () => window.removeEventListener("coordinator-output", handler);
	}, [headless]);

	// Transform agent activity log entries into feed-compatible objects
	const activityEntries = agentActivityLog.value.map((event, i) => ({
		...event,
		id: `activity-${i}-${event.timestamp}`,
		createdAt: event.timestamp,
		_isAgentActivity: true,
	}));

	// Merge all message sources:
	// - historyMessages: persisted chat (user + coordinator responses)
	// - pendingMessages: optimistic, not yet confirmed
	// - activityEntries: agent lifecycle events
	// - coordMessages: legio mail involving orchestrator/coordinator
	// Deduplicate by id (each source uses unique id prefixes).
	const seenIds = new Set();
	const allMessages = [];
	for (const msg of [
		...historyMessages,
		...pendingMessages,
		...activityEntries,
		...coordMessages,
	]) {
		if (!seenIds.has(msg.id)) {
			seenIds.add(msg.id);
			allMessages.push(msg);
		}
	}
	allMessages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	const groupedMessages = groupActivityMessages(allMessages);

	// Auto-scroll to bottom when near bottom
	useEffect(() => {
		const feed = feedRef.current;
		if (feed && isNearBottomRef.current) {
			feed.scrollTop = feed.scrollHeight;
		}
	});

	// Restore cursor position after programmatic input update (e.g., after @-mention insertion)
	useEffect(() => {
		if (pendingCursorRef.current !== null && inputRef.current) {
			const pos = pendingCursorRef.current;
			pendingCursorRef.current = null;
			inputRef.current.setSelectionRange(pos, pos);
		}
	});

	const handleFeedScroll = useCallback(() => {
		const feed = feedRef.current;
		if (!feed) return;
		isNearBottomRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 50;
	}, []);

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || sending) return;
		setSendError("");
		setSending(true);

		// Optimistic: show user message immediately before the POST completes
		const pendingId = `pending-${Date.now()}`;
		const pending = {
			id: pendingId,
			from: "you",
			to: "coordinator",
			body: text,
			createdAt: new Date().toISOString(),
			status: "sending",
		};
		setPendingMessages((prev) => [...prev, pending]);

		try {
			// POST to persistence endpoint — backend handles both saving AND terminal forwarding
			const saved = await postJson("/api/coordinator/chat", { text });
			// Add confirmed message to history (avoid duplicate if polling already added it)
			setHistoryMessages((prev) => {
				if (prev.some((m) => m.id === saved.id)) return prev;
				return [...prev, mapHistoryMessage(saved)];
			});
			// Remove the optimistic pending message
			setPendingMessages((prev) => prev.filter((m) => m.id !== pendingId));
			setInput("");
			setThinking(true);
		} catch (err) {
			setSendError(err.message || "Send failed");
			// Remove the pending message on send failure
			setPendingMessages((prev) => prev.filter((m) => m.id !== pendingId));
		} finally {
			setSending(false);
		}
	}, [input, sending]);

	// Detect @-mention and /command triggers from input text and update dropdown state
	const handleInput = useCallback((e) => {
		const value = e.target.value;
		setInput(value);
		const cursorPos = e.target.selectionStart ?? value.length;
		const textBeforeCursor = value.slice(0, cursorPos);

		// Check for @-mention trigger — scan backward from cursor to find @
		const atIdx = textBeforeCursor.lastIndexOf("@");
		if (atIdx !== -1) {
			const triggerText = textBeforeCursor.slice(atIdx + 1);
			// Only trigger if no spaces in the mention text (mentions are single tokens)
			if (!triggerText.includes(" ")) {
				const agents = appState.agents.value ?? [];
				const filter = triggerText.toLowerCase();
				const filtered = agents.filter((a) => {
					const name = (a.agentName ?? a.name ?? "").toLowerCase();
					return !filter || name.includes(filter);
				});
				if (filtered.length > 0) {
					setDropdown({ visible: true, items: filtered, selectedIndex: 0, type: "mention" });
					return;
				}
			}
		}

		// Check for /command trigger — only when input starts with / and no space yet
		if (value.startsWith("/") && value.indexOf(" ") === -1) {
			const filter = value.slice(1).toLowerCase();
			const filtered = SLASH_COMMANDS.filter((c) => !filter || c.cmd.slice(1).startsWith(filter));
			if (filtered.length > 0) {
				setDropdown({ visible: true, items: filtered, selectedIndex: 0, type: "command" });
				return;
			}
		}

		// No trigger active — close dropdown if it was open
		setDropdown((prev) => (prev.visible ? { ...prev, visible: false } : prev));
	}, []);

	// Insert the selected dropdown item into the input
	const selectDropdownItem = useCallback(
		(item) => {
			if (dropdown.type === "mention") {
				const cursorPos = inputRef.current?.selectionStart ?? input.length;
				const textBefore = input.slice(0, cursorPos);
				const atIdx = textBefore.lastIndexOf("@");
				const name = item.agentName ?? item.name ?? "";
				const inserted = `@${name} `;
				const newValue = input.slice(0, atIdx) + inserted + input.slice(cursorPos);
				pendingCursorRef.current = atIdx + inserted.length;
				setInput(newValue);
			} else {
				// Slash command — replace the /filter prefix with the selected command
				setInput(`${item.cmd} `);
			}
			setDropdown({ visible: false, items: [], selectedIndex: 0, type: "mention" });
			inputRef.current?.focus();
		},
		[dropdown.type, input],
	);

	const handleKeyDown = useCallback(
		(e) => {
			// When dropdown is open, arrow keys and Enter navigate/select; Escape dismisses
			if (dropdown.visible) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setDropdown((prev) => ({
						...prev,
						selectedIndex: Math.min(prev.selectedIndex + 1, prev.items.length - 1),
					}));
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setDropdown((prev) => ({
						...prev,
						selectedIndex: Math.max(prev.selectedIndex - 1, 0),
					}));
					return;
				}
				if (e.key === "Enter") {
					e.preventDefault();
					const item = dropdown.items[dropdown.selectedIndex];
					if (item !== undefined) selectDropdownItem(item);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					setDropdown({ visible: false, items: [], selectedIndex: 0, type: "mention" });
					return;
				}
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		},
		[dropdown, handleSend, selectDropdownItem],
	);

	return html`
		<div class="flex flex-col h-full min-h-0">
			<!-- Header -->
			<div class="px-3 py-2 border-b border-[#2a2a2a] shrink-0">
				<span class="text-sm font-medium text-[#e5e5e5]">Coordinator</span>
				<span class="ml-2 text-xs text-[#555]">Recent messages</span>
			</div>

			<!-- Message feed -->
			<div
				class="flex-1 overflow-y-auto p-3 min-h-0 flex flex-col gap-2"
				ref=${feedRef}
				onScroll=${handleFeedScroll}
			>
				${
					groupedMessages.length === 0
						? html`
							<div class="flex items-center justify-center h-full text-[#666] text-sm">
								No coordinator messages yet
							</div>
						`
						: groupedMessages.map((msg) => {
								const isFromUser = msg.from === "you";
								const isSending = msg.status === "sending";
								const isCommand = isFromUser && (msg.body ?? "").startsWith("/");

								// Agent lifecycle events → compact centered inline card
								if (msg._isAgentActivity) {
									const colors = agentColor(msg.capability);
									const ts = msg.timestamp || msg.createdAt;
									return html`
										<div key=${msg.id}
											class="mx-auto max-w-[70%] flex items-center gap-1.5 px-3 py-1 mb-1 rounded bg-[#1a1a1a] border border-[#2a2a2a]">
											<span class="text-xs leading-none flex-shrink-0">${colors.avatar}</span>
											<span class="text-xs text-[#666] truncate">${msg.summary || msg.type || ""}</span>
											<span class="text-xs text-[#444] flex-shrink-0 ml-auto">${timeAgo(ts)}</span>
										</div>
									`;
								}

								// Protocol messages → compact one-liner
								if (isActivityMessage(msg)) {
									return html`
										<div
											key=${msg.id}
											class="flex items-center gap-2 px-2 py-1 rounded bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#666]"
										>
											<span
												class="px-1.5 py-0.5 rounded font-mono bg-[#2a2a2a] text-[#888] shrink-0"
											>
												${msg.type}
											</span>
											<span class="flex-1 truncate min-w-0">
												${msg.subject || msg.body || ""}
											</span>
											<span class="shrink-0">${timeAgo(msg.createdAt)}</span>
										</div>
									`;
								}

								// Conversational messages (left for coord/agents, right for user)
								return html`
									<div
										key=${msg.id}
										class=${`flex ${isFromUser ? "justify-end" : "justify-start"}`}
									>
										<div
											class=${
												"max-w-[85%] rounded px-3 py-2 text-sm " +
												(isFromUser
													? "bg-[#E64415]/20 text-[#e5e5e5] border border-[#E64415]/30" +
														(isSending ? " opacity-70" : "")
													: "bg-[#1a1a1a] text-[#e5e5e5] border border-[#2a2a2a]")
											}
										>
											<div class="flex items-center gap-1 mb-1">
												<span class="text-xs text-[#999]">
													${isFromUser ? "You" : msg.from || "unknown"}
												</span>
												<span class="text-xs text-[#555]">
													${isSending ? "\u00b7 sending\u2026" : `\u00b7 ${timeAgo(msg.createdAt)}`}
												</span>
											</div>
											<div class="text-[#e5e5e5] whitespace-pre-wrap break-words">
												${
													isCommand
														? html`<span
																class="text-xs px-1 py-0.5 rounded bg-[#2a2a2a] text-[#888] font-mono mr-1"
															>cmd</span
														><span class="font-mono">${msg.body || ""}</span>`
														: msg.body || ""
												}
											</div>
										</div>
									</div>
								`;
							})
				}
				${
					thinking || (headless && streamText)
						? html`
							<div class="flex justify-start">
								<div class="max-w-[85%] rounded px-3 py-2 text-sm bg-[#1a1a1a] text-[#e5e5e5] border border-[#2a2a2a]">
									<div class="flex items-center gap-1 mb-1">
										<span class="text-xs text-[#999]">coordinator</span>
										<span class="text-xs text-[#555] animate-pulse">\u00b7 working\u2026</span>
									</div>
									${
										streamText
											? html`<pre class="text-[#ccc] whitespace-pre-wrap break-words font-mono text-xs max-h-48 overflow-y-auto">${streamText}</pre>`
											: html`<div class="flex items-center gap-2 text-sm text-[#666]">
											<span class="animate-pulse">\u25cf\u25cf\u25cf</span>
										</div>`
									}
								</div>
							</div>
						`
						: null
				}
			</div>

			<!-- Input area -->
			<div class="border-t border-[#2a2a2a] p-3 shrink-0">
				<div class="relative">
					${
						dropdown.visible
							? html`
								<div
									class="absolute bottom-full left-0 right-0 mb-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded shadow-lg max-h-48 overflow-y-auto z-50"
								>
									${dropdown.items.map(
										(item, i) =>
											html`
											<div
												key=${
													dropdown.type === "mention"
														? (item.agentName ?? item.name ?? String(i))
														: item.cmd
												}
												class=${
													"flex items-center gap-2 px-3 py-2 cursor-pointer text-sm text-[#e5e5e5] " +
													(i === dropdown.selectedIndex ? "bg-[#E64415]/20" : "hover:bg-[#2a2a2a]")
												}
												onMouseDown=${(e) => {
													e.preventDefault();
													selectDropdownItem(item);
												}}
											>
												${
													dropdown.type === "mention"
														? html`
															<span class="flex-1 font-mono">
																@${item.agentName ?? item.name ?? ""}
															</span>
															${
																item.capability
																	? html`<span
																				class="text-xs px-1.5 py-0.5 rounded bg-[#2a2a2a] text-[#888] shrink-0"
																			>
																				${item.capability}
																			</span>`
																	: null
															}
														`
														: html`
															<span class="flex-1 font-mono">${item.cmd}</span>
															<span class="text-xs text-[#666] shrink-0">${item.desc}</span>
														`
												}
											</div>
										`,
									)}
								</div>
							`
							: null
					}
					<div class="flex gap-2">
						<input
							ref=${inputRef}
							type="text"
							placeholder="Send command to coordinator\u2026"
							value=${input}
							onInput=${handleInput}
							onKeyDown=${handleKeyDown}
							disabled=${sending}
							class=${`${inputClass} flex-1 min-w-0`}
						/>
						<button
							onClick=${handleSend}
							disabled=${sending || !input.trim()}
							class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none shrink-0"
						>
							${sending ? "\u2026" : "Send"}
						</button>
					</div>
				</div>
				${sendError ? html`<div class="text-xs text-red-400 mt-1">${sendError}</div>` : null}
			</div>
		</div>
	`;
}
