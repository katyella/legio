// coordinator-chat.js — CoordinatorChat standalone component
// Unified chat feed: all human-audience messages across all agents in one timeline.
// Agent messages on left (labeled with agent name), user messages on right.

import { TerminalPanel } from "../components/terminal-panel.js";
import { fetchJson, postJson } from "../lib/api.js";
import { renderMarkdown } from "../lib/markdown.js";
import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";
import { appState } from "../lib/state.js";
import { timeAgo } from "../lib/utils.js";

// Slash commands available in coordinator chat
const SLASH_COMMANDS = [
	{ cmd: "/status", desc: "Show agent status overview" },
	{ cmd: "/merge", desc: "Merge a completed branch" },
	{ cmd: "/nudge", desc: "Send a nudge to a stalled agent" },
	{ cmd: "/mail", desc: "Send mail to an agent" },
	{ cmd: "/help", desc: "Show available commands" },
];

// ---------------------------------------------------------------------------
// CoordinatorChat — main export
// ---------------------------------------------------------------------------

export function CoordinatorChat({ coordRunning }) {
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
	const prevFromAgentCountRef = useRef(0);
	const inputRef = useRef(null);
	const pendingCursorRef = useRef(null);

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5]" +
		" placeholder-[#666] outline-none focus:border-[#E64415]";

	// Load unified chat history on mount and poll for updates
	useEffect(() => {
		let cancelled = false;

		async function fetchHistory() {
			try {
				const data = await fetchJson("/api/chat/unified/history?limit=200");
				if (!cancelled) {
					setHistoryMessages(Array.isArray(data) ? data : []);
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

	// Consume pendingChatContext from issue click-through
	useEffect(() => {
		const ctx = appState.pendingChatContext.value;
		if (!ctx) return;
		setInput(`Discuss issue ${ctx.issueId}: ${ctx.title}\n${ctx.description || ""}`);
		appState.pendingChatContext.value = null;
		inputRef.current?.focus();
	}, [appState.pendingChatContext.value]); // eslint-disable-line react-hooks/exhaustive-deps

	// Count non-human responses in history — detect new agent replies to clear thinking
	const fromAgentCount = historyMessages.filter((m) => m.from !== "human").length;

	useEffect(() => {
		if (fromAgentCount > prevFromAgentCountRef.current) {
			setThinking(false);
			// Deduplicate pending messages that now appear in history
			setPendingMessages((prev) =>
				prev.filter(
					(pm) =>
						!historyMessages.some(
							(hm) =>
								hm.from === "human" &&
								hm.body === pm.body &&
								Math.abs(
									new Date(hm.createdAt).getTime() - new Date(pm.createdAt).getTime(),
								) < 60000,
						),
				),
			);
		}
		prevFromAgentCountRef.current = fromAgentCount;
	}, [fromAgentCount]); // eslint-disable-line react-hooks/exhaustive-deps

	// Merge history + pending, deduplicate by id, sort oldest first
	const seenIds = new Set();
	const allMessages = [];
	for (const msg of [...historyMessages, ...pendingMessages]) {
		if (!seenIds.has(msg.id)) {
			seenIds.add(msg.id);
			allMessages.push(msg);
		}
	}
	allMessages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

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
			from: "human",
			to: "coordinator",
			body: text,
			createdAt: new Date().toISOString(),
			status: "sending",
		};
		setPendingMessages((prev) => [...prev, pending]);

		try {
			await postJson("/api/coordinator/chat", { text });
			// Remove optimistic pending (history poll will pick it up)
			setPendingMessages((prev) => prev.filter((m) => m.id !== pendingId));
			try {
				await postJson("/api/audit", {
					type: "command",
					source: "web_ui",
					summary: text,
					agent: "coordinator",
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
			<div class="px-3 py-2 border-b border-[#2a2a2a] shrink-0 flex items-center gap-2">
				<span class="text-sm font-medium text-[#e5e5e5]">Chat</span>
				<span class="ml-1 text-xs text-[#555]">All agents</span>
			</div>

			<!-- Message feed — unified timeline of all human-audience messages -->
			<div
				class="flex-1 overflow-y-auto p-3 min-h-0 flex flex-col gap-2"
				ref=${feedRef}
				onScroll=${handleFeedScroll}
			>
				${
					allMessages.length === 0
						? html`
						<div class="flex items-center justify-center h-full text-[#666] text-sm">
							${coordRunning ? "No messages yet" : "Start coordinator to chat"}
						</div>
					`
						: allMessages.map((msg) => {
								const isFromUser = msg.from === "human";
								const isSending = msg.status === "sending";
								const isCommand = isFromUser && (msg.body ?? "").startsWith("/");

								// Conversational messages: user on right, agents on left with name label
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
									<span class="text-xs text-[#999]">coordinator</span>
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
			<${TerminalPanel} chatTarget="coordinator" thinking=${thinking} />

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
								coordRunning
									? "Send command to coordinator\u2026"
									: "Start coordinator to chat\u2026"
							}
							value=${input}
							onInput=${handleInput}
							onKeyDown=${handleKeyDown}
							disabled=${sending || !coordRunning}
							class=${`${inputClass} flex-1 min-w-0`}
						/>
						<button
							onClick=${handleSend}
							disabled=${sending || !input.trim() || !coordRunning}
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
