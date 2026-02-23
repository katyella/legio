// coordinator-chat.js — CoordinatorChat standalone component
// Extracted from dashboard.js: chat feed separated from terminal capture output.
// Layout: header → chat feed (scrollable) → TerminalPanel (collapsible) → input area

import { fetchJson, postJson } from "../lib/api.js";
import { renderMarkdown } from "../lib/markdown.js";
import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";
import { agentActivityLog, appState } from "../lib/state.js";
import {
	agentColor,
	groupActivityMessages,
	groupSummaryLabel,
	isActivityMessage,
	timeAgo,
} from "../lib/utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
	const ts = msg.createdAt.endsWith("Z") ? msg.createdAt : msg.createdAt + "Z";
	return {
		id: msg.id,
		from: msg.role === "user" ? "you" : "coordinator",
		to: msg.role === "user" ? "coordinator" : "you",
		body: msg.content,
		createdAt: ts,
		_persisted: true,
	};
}

// ---------------------------------------------------------------------------
// TerminalPanel — collapsible terminal capture sub-component
// ---------------------------------------------------------------------------

function TerminalPanel({ chatTarget, thinking }) {
	const [expanded, setExpanded] = useState(false);
	const [streamText, setStreamText] = useState("");
	const baselineCaptureRef = useRef(null);
	const terminalRef = useRef(null);

	// Reset when chatTarget changes
	useEffect(() => {
		setStreamText("");
		baselineCaptureRef.current = null;
	}, [chatTarget]);

	// Poll terminal capture when thinking OR expanded; clear when neither
	useEffect(() => {
		if (!thinking && !expanded) {
			setStreamText("");
			baselineCaptureRef.current = null;
			return;
		}

		let cancelled = false;

		async function pollCapture() {
			try {
				const res = await fetch(`/api/terminal/capture?agent=${chatTarget}&lines=80`);
				if (!res.ok || cancelled) return;
				const data = await res.json();
				const output = stripAnsi(data.output || "");

				if (thinking) {
					// Streaming mode: diff against baseline to show new output
					if (baselineCaptureRef.current === null) {
						baselineCaptureRef.current = output;
						return;
					}
					const delta = diffCapture(baselineCaptureRef.current, output);
					if (!cancelled && delta.trim()) {
						setStreamText(delta);
					}
				} else {
					// Expanded viewer mode: show full terminal capture directly
					if (!cancelled && output.trim()) {
						setStreamText(output);
					}
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
	}, [thinking, expanded, chatTarget]);

	// Auto-scroll terminal to bottom when new output arrives
	useEffect(() => {
		const el = terminalRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [streamText]);

	return html`
		<div class="border-t border-[#2a2a2a] shrink-0">
			<div
				class="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/5"
				onClick=${() => setExpanded((prev) => !prev)}
			>
				<span
					class=${"w-2 h-2 rounded-full flex-shrink-0 " +
						(thinking ? "bg-yellow-500 animate-pulse" : "bg-[#333]")}
				></span>
				<span class="text-xs text-[#666]">Terminal</span>
				${thinking ? html`<span class="text-xs text-yellow-500 animate-pulse">active</span>` : null}
				<span class="ml-auto text-xs text-[#444]">${expanded ? "\u25b2" : "\u25bc"}</span>
			</div>
			${
				expanded
					? html`
					<div ref=${terminalRef} class="max-h-[200px] overflow-y-auto px-3 pb-2">
						${
							streamText
								? html`<pre class="text-xs text-[#ccc] font-mono whitespace-pre-wrap break-words">${streamText}</pre>`
								: html`<div class="text-xs text-[#444] py-1 italic">No output yet</div>`
						}
					</div>
				`
					: null
			}
		</div>
	`;
}

// ---------------------------------------------------------------------------
// CoordinatorChat — main export
// ---------------------------------------------------------------------------

export function CoordinatorChat({ mail, coordRunning, gwRunning }) {
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");
	const [pendingMessages, setPendingMessages] = useState([]);
	const [historyMessages, setHistoryMessages] = useState([]);
	const [thinking, setThinking] = useState(false);
	const [dropdown, setDropdown] = useState({
		visible: false,
		items: [],
		selectedIndex: 0,
		type: "mention",
	});
	const feedRef = useRef(null);
	const isNearBottomRef = useRef(true);
	const prevFromTargetCountRef = useRef(0);
	const prevHistoryFromCoordCountRef = useRef(0);
	const inputRef = useRef(null);
	const pendingCursorRef = useRef(null);
	const manualSelectionRef = useRef(false);
	const [chatTarget, setChatTarget] = useState("coordinator");
	const neitherRunning = !coordRunning && !gwRunning;

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5]" +
		" placeholder-[#666] outline-none focus:border-[#E64415]";

	// Load coordinator chat history on mount and poll for updates
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

	// Filter target-related messages, sorted oldest first
	const coordMessages = [...mail]
		.filter((m) =>
			chatTarget === "coordinator"
				? m.from === "orchestrator" ||
					m.from === "coordinator" ||
					m.to === "orchestrator" ||
					m.to === "coordinator"
				: m.from === "gateway" || m.to === "gateway",
		)
		.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

	// Count of messages FROM active target — used to detect responses
	const fromTargetCount = coordMessages.filter((m) =>
		chatTarget === "coordinator"
			? m.from === "orchestrator" || m.from === "coordinator"
			: m.from === "gateway",
	).length;

	// Count coordinator responses in history
	const historyFromCoordCount = historyMessages.filter((m) => m.from === "coordinator").length;

	// Consume pendingChatContext from issue click-through
	useEffect(() => {
		const ctx = appState.pendingChatContext.value;
		if (!ctx) return;
		setInput(`Discuss issue ${ctx.issueId}: ${ctx.title}\n${ctx.description || ""}`);
		appState.pendingChatContext.value = null;
		inputRef.current?.focus();
	}, [appState.pendingChatContext.value]); // eslint-disable-line react-hooks/exhaustive-deps

	// Auto-select the only running target (skipped if user manually selected one)
	useEffect(() => {
		if (coordRunning && gwRunning) {
			manualSelectionRef.current = false;
			return;
		}
		if (manualSelectionRef.current) return;
		if (coordRunning && !gwRunning) {
			setChatTarget("coordinator");
		} else if (!coordRunning && gwRunning) {
			setChatTarget("gateway");
		}
	}, [coordRunning, gwRunning]);

	// Reset thinking state when chat target switches
	useEffect(() => {
		prevFromTargetCountRef.current = 0;
		setThinking(false);
	}, [chatTarget]);

	// Detect new target responses in mail → clear thinking + deduplicate pending
	useEffect(() => {
		if (fromTargetCount > prevFromTargetCountRef.current) {
			setThinking(false);
			setPendingMessages((prev) =>
				prev.filter(
					(pm) =>
						!coordMessages.some(
							(rm) =>
								rm.body === pm.body &&
								Math.abs(new Date(rm.createdAt).getTime() - new Date(pm.createdAt).getTime()) <
									60000,
						),
				),
			);
		}
		prevFromTargetCountRef.current = fromTargetCount;
	}, [fromTargetCount]); // eslint-disable-line react-hooks/exhaustive-deps

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

	// Transform agent activity log entries into feed-compatible objects
	const activityEntries = agentActivityLog.value.map((event, i) => ({
		...event,
		id: `activity-${i}-${event.timestamp}`,
		createdAt: event.timestamp,
		_isAgentActivity: true,
	}));

	// Merge all message sources, deduplicate by id, sort oldest first
	const historyForTarget = chatTarget === "coordinator" ? historyMessages : [];
	const pendingForTarget = pendingMessages.filter((m) => m._chatTarget === chatTarget);
	const seenIds = new Set();
	const allMessages = [];
	for (const msg of [
		...historyForTarget,
		...pendingForTarget,
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

	// Restore cursor position after programmatic input update (e.g., @-mention insertion)
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

		// Optimistic: show user message immediately before POST completes
		const pendingId = `pending-${Date.now()}`;
		const pending = {
			id: pendingId,
			from: "you",
			to: chatTarget,
			body: text,
			createdAt: new Date().toISOString(),
			status: "sending",
			_chatTarget: chatTarget,
		};
		setPendingMessages((prev) => [...prev, pending]);

		try {
			if (chatTarget === "gateway") {
				await postJson("/api/gateway/chat", { text });
				// Mark gateway pending as sent (no persistent history endpoint)
				setPendingMessages((prev) =>
					prev.map((m) => (m.id === pendingId ? { ...m, status: "sent" } : m)),
				);
			} else {
				// Use persistent chat endpoint for coordinator
				const saved = await postJson("/api/coordinator/chat", { text });
				if (saved?.id) {
					setHistoryMessages((prev) => {
						if (prev.some((m) => m.id === saved.id)) return prev;
						return [...prev, mapHistoryMessage(saved)];
					});
				}
				// Remove optimistic pending (replaced by history entry)
				setPendingMessages((prev) => prev.filter((m) => m.id !== pendingId));
			}
			try {
				await postJson("/api/audit", {
					type: "command",
					source: "web_ui",
					summary: text,
					agent: chatTarget,
				});
			} catch (_e) {
				// intentionally ignored
			}
			setInput("");
			setThinking(true);
		} catch (err) {
			setSendError(err.message || "Send failed");
			setPendingMessages((prev) => prev.filter((m) => m.id !== pendingId));
		} finally {
			setSending(false);
		}
	}, [input, sending, chatTarget]);

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
			<div class="px-3 py-2 border-b border-[#2a2a2a] shrink-0 flex items-center gap-2">
				<span class="text-sm font-medium text-[#e5e5e5]">
					${chatTarget === "coordinator" ? "Coordinator" : "Gateway"}
				</span>
				<span class="ml-1 text-xs text-[#555]">Recent messages</span>
				${
					coordRunning && gwRunning
						? html`
						<div class="ml-auto flex gap-1">
							<button
								class=${"text-xs px-2 py-1 rounded " +
									(chatTarget === "coordinator"
										? "bg-[#E64415]/20 text-white"
										: "text-[#666] hover:text-[#999]")}
								onClick=${() => { manualSelectionRef.current = true; setChatTarget("coordinator"); }}
							>Coordinator</button>
							<button
								class=${"text-xs px-2 py-1 rounded " +
									(chatTarget === "gateway"
										? "bg-[#E64415]/20 text-white"
										: "text-[#666] hover:text-[#999]")}
								onClick=${() => { manualSelectionRef.current = true; setChatTarget("gateway"); }}
							>Gateway</button>
						</div>
					`
						: null
				}
			</div>

			<!-- Message feed — conversational only, NO terminal output -->
			<div
				class="flex-1 overflow-y-auto p-3 min-h-0 flex flex-col gap-2"
				ref=${feedRef}
				onScroll=${handleFeedScroll}
			>
				${
					groupedMessages.length === 0
						? html`
						<div class="flex items-center justify-center h-full text-[#666] text-sm">
							${
								neitherRunning
									? "Start coordinator or gateway to chat"
									: `No ${chatTarget} messages yet`
							}
						</div>
					`
						: groupedMessages.map((msg) => {
								// Grouped activity messages → compact summary card
								if (msg._isGroup) {
									return html`
									<div
										key=${msg.id}
										class="flex items-center gap-2 px-2 py-1 rounded bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#666]"
									>
										<span class="px-1.5 py-0.5 rounded font-mono bg-[#2a2a2a] text-[#888] shrink-0">
											${msg.type}
										</span>
										<span class="flex-1 truncate min-w-0">${groupSummaryLabel(msg)}</span>
										<span class="shrink-0">${timeAgo(msg.lastTimestamp)}</span>
									</div>
								`;
								}

								const isFromUser = msg.from === "you";
								const isSending = msg.status === "sending";
								const isCommand = isFromUser && (msg.body ?? "").startsWith("/");

								// Agent lifecycle events → compact centered inline card
								if (msg._isAgentActivity) {
									const colors = agentColor(msg.capability);
									const ts = msg.timestamp || msg.createdAt;
									return html`
									<div
										key=${msg.id}
										class="mx-auto max-w-[70%] flex items-center gap-1.5 px-3 py-1 mb-1 rounded bg-[#1a1a1a] border border-[#2a2a2a]"
									>
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
										<span class="px-1.5 py-0.5 rounded font-mono bg-[#2a2a2a] text-[#888] shrink-0">
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
										${
											isCommand
												? html`<div class="text-[#e5e5e5] whitespace-pre-wrap break-words">
													<span class="text-xs px-1 py-0.5 rounded bg-[#2a2a2a] text-[#888] font-mono mr-1">cmd</span
													><span class="font-mono">${msg.body || ""}</span>
												</div>`
												: html`<div
													class="text-[#e5e5e5] break-words chat-markdown"
													dangerouslySetInnerHTML=${{ __html: renderMarkdown(msg.body) }}
												></div>`
										}
									</div>
								</div>
							`;
							})
				}
				${
					thinking
						? html`
						<div class="flex justify-start">
							<div class="max-w-[85%] rounded px-3 py-2 text-sm bg-[#1a1a1a] text-[#e5e5e5] border border-[#2a2a2a]">
								<div class="flex items-center gap-1 mb-1">
									<span class="text-xs text-[#999]">${chatTarget}</span>
									<span class="text-xs text-[#555] animate-pulse">\u00b7 working\u2026</span>
								</div>
								<div class="flex items-center gap-2 text-sm text-[#666]">
									<span class="animate-pulse">\u25cf\u25cf\u25cf</span>
								</div>
							</div>
						</div>
					`
						: null
				}
			</div>

			<!-- Terminal panel (collapsible, collapsed by default) -->
			<${TerminalPanel} chatTarget=${chatTarget} thinking=${thinking} />

			<!-- Input area (always visible) -->
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
							placeholder=${
								neitherRunning
									? "Start coordinator or gateway to chat\u2026"
									: chatTarget === "coordinator"
										? "Send command to coordinator\u2026"
										: "Send message to gateway\u2026"
							}
							value=${input}
							onInput=${handleInput}
							onKeyDown=${handleKeyDown}
							disabled=${sending || neitherRunning}
							class=${`${inputClass} flex-1 min-w-0`}
						/>
						<button
							onClick=${handleSend}
							disabled=${sending || !input.trim() || neitherRunning}
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
