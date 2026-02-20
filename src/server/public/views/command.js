// Legio Web UI — CommandView component
// Two-panel mission-control interface:
//   - Left: Coordinator chat input + recent coordinator messages (~55%)
//   - Right: Collapsible agent roster with inline mail/events (~45%)

import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";
import {
	agentColor,
	isActivityMessage,
	stateColor,
	stateIcon,
	timeAgo,
} from "../lib/utils.js";
import { agentActivityLog, appState } from "../lib/state.js";

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
			if (currentLines[i + j] !== anchor[j]) { match = false; break; }
		}
		if (match) {
			return currentLines.slice(i + anchorLen).join("\n");
		}
	}
	// Baseline scrolled off — show tail
	return currentLines.slice(-20).join("\n");
}

// Type badge Tailwind classes for ActivityTimeline
const TYPE_COLORS = {
	session_start: "bg-green-900/50 text-green-400",
	session_end: "bg-[#333] text-[#999]",
	spawn: "bg-blue-900/50 text-blue-400",
	mail_sent: "bg-purple-900/50 text-purple-400",
	mail_received: "bg-purple-900/50 text-purple-400",
	mail: "bg-purple-900/50 text-purple-400",
	error: "bg-red-900/50 text-red-400",
	system: "bg-[#333] text-[#999]",
};

// Slash commands available in coordinator chat
const SLASH_COMMANDS = [
	{ cmd: "/status", desc: "Show agent status overview" },
	{ cmd: "/merge", desc: "Merge a completed branch" },
	{ cmd: "/nudge", desc: "Send a nudge to a stalled agent" },
	{ cmd: "/mail", desc: "Send mail to an agent" },
	{ cmd: "/help", desc: "Show available commands" },
];

function buildEventSummary(e) {
	switch (e.eventType) {
		case "session_start":
			return `${e.agentName} session started`;
		case "session_end":
			return `${e.agentName} session ended`;
		case "spawn":
			return `Spawned ${e.agentName}`;
		case "mail_sent":
			return `Mail sent by ${e.agentName}`;
		case "mail_received":
			return `Mail received by ${e.agentName}`;
		case "error": {
			try {
				return `Error: ${JSON.parse(e.data || "{}").message || "unknown"}`;
			} catch {
				return "Error";
			}
		}
		default:
			return e.eventType;
	}
}

function typeBadgeClass(type) {
	return TYPE_COLORS[type] ?? "bg-[#333] text-[#999]";
}

// ===== AgentRoster =====

const STATE_ORDER = { working: 0, booting: 1, stalled: 2, zombie: 3, completed: 4 };

function AgentRoster({ agents, mail, events }) {
	const [expandedAgent, setExpandedAgent] = useState(null);

	const sorted = [...agents].sort((a, b) => {
		const ao = STATE_ORDER[a.state] ?? 99;
		const bo = STATE_ORDER[b.state] ?? 99;
		if (ao !== bo) return ao - bo;
		return (a.agentName ?? "").localeCompare(b.agentName ?? "");
	});

	const activeCount = agents.filter((a) => a.state === "working" || a.state === "booting").length;

	const toggleExpand = useCallback((name) => {
		setExpandedAgent((prev) => (prev === name ? null : name));
	}, []);

	return html`
		<div class="flex flex-col h-full min-h-0">
			<!-- Header -->
			<div class="px-3 py-2 border-b border-[#2a2a2a] shrink-0">
				<span class="text-sm font-medium text-[#e5e5e5]">Agents</span>
				<span class="ml-2 text-xs text-[#555]">${activeCount} active / ${agents.length} total</span>
			</div>

			<!-- Agent list -->
			<div class="flex-1 overflow-y-auto min-h-0 p-2">
				${
					sorted.length === 0
						? html`
							<div class="flex items-center justify-center h-full text-[#666] text-sm">
								No agents yet
							</div>
						`
						: sorted.map((agent) => {
								const isExpanded = expandedAgent === agent.agentName;
								const colors = agentColor(agent.capability);
								const icon = stateIcon(agent.state);
								const iconColor = stateColor(agent.state);

								// Filter mail for this agent
								const agentMail = mail
									.filter((m) => m.from === agent.agentName || m.to === agent.agentName)
									.sort(
										(a, b) =>
											new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
									)
									.slice(0, 5);

								// Filter events for this agent
								const agentEvents = events
									.filter((e) => e.agent === agent.agentName)
									.slice(0, 5);

								return html`
									<div
										key=${agent.agentName}
										class="mb-1 rounded border border-[#2a2a2a] bg-[#1a1a1a] overflow-hidden"
									>
										<!-- Row -->
										<div
											class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:border-[#3a3a3a] hover:bg-[#222]"
											onClick=${() => toggleExpand(agent.agentName)}
										>
											<span class="text-base leading-none flex-shrink-0">${colors.avatar}</span>
											<span class=${`text-xs leading-none flex-shrink-0 ${iconColor}`}>${icon}</span>
											<span class="text-sm text-[#e5e5e5] truncate flex-1 min-w-0">
												${agent.agentName}
											</span>
											${
												agent.beadId
													? html`<span class="text-xs font-mono text-[#666] flex-shrink-0">
															${agent.beadId}
														</span>`
													: null
											}
											<span class="text-xs text-[#444] flex-shrink-0">
												${isExpanded ? "\u25B2" : "\u25BC"}
											</span>
										</div>

										<!-- Expanded detail -->
										${
											isExpanded
												? html`
													<div class="border-t border-[#2a2a2a] px-3 py-2 text-xs">
														<!-- Meta badges -->
														<div class="flex flex-wrap gap-1.5 mb-2">
															<span
																class=${`px-1.5 py-0.5 rounded font-mono ${colors.bg} ${colors.text} border ${colors.border}`}
															>
																${agent.capability || "unknown"}
															</span>
															<span
																class=${`px-1.5 py-0.5 rounded font-mono ${iconColor}`}
															>
																${icon} ${agent.state}
															</span>
															${
																agent.beadId
																	? html`<span class="font-mono text-[#666]">${agent.beadId}</span>`
																	: null
															}
															${
																agent.startedAt
																	? html`<span class="text-[#555]">started ${timeAgo(agent.startedAt)}</span>`
																	: null
															}
														</div>

														<!-- Recent Mail -->
														<div class="mb-2">
															<div class="text-[#555] mb-1">Recent Mail</div>
															${
																agentMail.length === 0
																	? null
																	: agentMail.map(
																			(m) => html`
																				<div
																					key=${m.id}
																					class="flex items-center gap-1.5 py-0.5 border-b border-[#1f1f1f]"
																				>
																					<span class="text-[#444] flex-shrink-0">
																						${m.from === agent.agentName ? "\u2192" : "\u2190"}
																					</span>
																					<span class="text-[#666] flex-shrink-0 truncate max-w-[6rem]">
																						${m.from === agent.agentName ? m.to : m.from}
																					</span>
																					<span class="flex-1 truncate text-[#999] min-w-0">
																						${m.subject || m.body || ""}
																					</span>
																					<span class="text-[#444] flex-shrink-0 ml-auto">
																						${timeAgo(m.createdAt)}
																					</span>
																				</div>
																			`,
																		)
															}
														</div>

														<!-- Recent Events -->
														<div>
															<div class="text-[#555] mb-1">Recent Events</div>
															${
																agentEvents.length === 0
																	? null
																	: agentEvents.map(
																			(ev) => html`
																				<div
																					key=${ev.id}
																					class="flex items-center gap-1.5 py-0.5 border-b border-[#1f1f1f]"
																				>
																					<span
																						class=${`px-1 rounded font-mono flex-shrink-0 ${typeBadgeClass(ev.type)}`}
																					>
																						${ev.type || "unknown"}
																					</span>
																					<span class="flex-1 truncate text-[#999] min-w-0">
																						${ev.summary || ""}
																					</span>
																					<span class="text-[#444] flex-shrink-0 ml-auto">
																						${timeAgo(ev.createdAt)}
																					</span>
																				</div>
																			`,
																		)
															}
														</div>

														${
															agentMail.length === 0 && agentEvents.length === 0
																? html`<div class="text-[#444] text-center py-1">No recent activity</div>`
																: null
														}
													</div>
												`
												: null
										}
									</div>
								`;
							})
				}
			</div>
		</div>
	`;
}

// ===== buildProgressNarration =====

function buildProgressNarration(agents) {
	if (!agents || agents.length === 0) return "Thinking\u2026";

	const booting = agents.filter((a) => a.state === "booting");
	const working = agents.filter((a) => a.state === "working");
	const completed = agents.filter(
		(a) => a.state === "completed" || a.state === "done",
	);

	const total = agents.length;

	if (completed.length === total) return "Done.";

	if (booting.length === total) {
		return `Spawning ${total} agent${total === 1 ? "" : "s"}\u2026`;
	}

	const parts = [];
	if (working.length > 0) {
		parts.push(`${working.length}/${total} agent${total === 1 ? "" : "s"} working`);
	}
	if (booting.length > 0) {
		parts.push(`${booting.length} booting`);
	}
	if (completed.length > 0) {
		const last = completed[completed.length - 1];
		const name = last.agentName ?? last.name ?? "agent";
		parts.push(`${name} completed`);
	}

	if (parts.length > 0) return parts.join(", ") + "\u2026";

	return "Thinking\u2026";
}

// ===== CoordinatorChat =====

function CoordinatorChat({ mail }) {
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");
	const [pendingMessages, setPendingMessages] = useState([]);
	const [thinking, setThinking] = useState(false);
	const [dropdown, setDropdown] = useState({
		visible: false,
		items: [],
		selectedIndex: 0,
		type: "mention",
	});
	const feedRef = useRef(null);
	const isNearBottomRef = useRef(true);
	const prevFromCoordCountRef = useRef(0);
	const inputRef = useRef(null);
	const pendingCursorRef = useRef(null);

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5]" +
		" placeholder-[#666] outline-none focus:border-[#E64415]";

	// Filter coordinator-related messages, sorted oldest first
	const coordMessages = [...mail]
		.filter(
			(m) =>
				m.from === "orchestrator" ||
				m.from === "coordinator" ||
				m.to === "orchestrator" ||
				m.to === "coordinator",
		)
		.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

	// Count of messages FROM coordinator — used to detect coordinator responses
	const fromCoordCount = coordMessages.filter(
		(m) => m.from === "orchestrator" || m.from === "coordinator",
	).length;

	// Detect new coordinator responses → clear thinking + matched pending messages
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

	// Poll terminal capture while coordinator is thinking
	useEffect(() => {
		if (!thinking) {
			setStreamText("");
			baselineCaptureRef.current = null;
			return;
		}

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
	}, [thinking]);

	// Transform agent activity log entries into feed-compatible objects
	const activityEntries = agentActivityLog.value.map((event, i) => ({
		...event,
		id: `activity-${i}-${event.timestamp}`,
		createdAt: event.timestamp,
		_isAgentActivity: true,
	}));

	// Merge pending messages and agent activity into the conversation feed, sorted oldest first
	const allMessages = [...coordMessages, ...pendingMessages, ...activityEntries].sort(
		(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
	);
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
			await postJson("/api/terminal/send", { agent: "coordinator", text });
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
			// Mark pending as sent (removes "sending…" label)
			setPendingMessages((prev) =>
				prev.map((m) => (m.id === pendingId ? { ...m, status: "sent" } : m)),
			);
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
			const filtered = SLASH_COMMANDS.filter(
				(c) => !filter || c.cmd.slice(1).startsWith(filter),
			);
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

	const toggleGroup = useCallback((groupId) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			return next;
		});
	}, []);

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
						: allMessages.map((msg) => {
								const isFromUser = msg.from === "you";
								const isSending = msg.status === "sending";
								const isCommand = isFromUser && (msg.body ?? "").startsWith("/");

								const isFromUser = item.from === "you";
								const isSending = item.status === "sending";

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
								if (isActivityMessage(item)) {
									return html`
										<div
											key=${item.id}
											class="flex items-center gap-2 px-2 py-1 rounded bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#666]"
										>
											<span
												class="px-1.5 py-0.5 rounded font-mono bg-[#2a2a2a] text-[#888] shrink-0"
											>
												${item.type}
											</span>
											<span class="flex-1 truncate min-w-0">
												${item.subject || item.body || ""}
											</span>
											<span class="shrink-0">${timeAgo(item.createdAt)}</span>
										</div>
									`;
								}

								// Conversational messages (left for coord/agents, right for user)
								return html`
									<div
										key=${item.id}
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
													${isFromUser ? "You" : (item.from || "unknown")}
												</span>
												<span class="text-xs text-[#555]">
													${isSending
														? "\u00b7 sending\u2026"
														: `\u00b7 ${timeAgo(item.createdAt)}`}
												</span>
											</div>
											<div class="text-[#e5e5e5] whitespace-pre-wrap break-words">
												${isCommand
													? html`<span
																class="text-xs px-1 py-0.5 rounded bg-[#2a2a2a] text-[#888] font-mono mr-1"
															>cmd</span
														><span class="font-mono">${msg.body || ""}</span>`
													: (msg.body || "")}
											</div>
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
									${streamText
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
									${dropdown.items.map((item, i) =>
										html`
											<div
												key=${dropdown.type === "mention"
													? (item.agentName ?? item.name ?? String(i))
													: item.cmd}
												class=${
													"flex items-center gap-2 px-3 py-2 cursor-pointer text-sm text-[#e5e5e5] " +
													(i === dropdown.selectedIndex
														? "bg-[#E64415]/20"
														: "hover:bg-[#2a2a2a]")
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

// ===== CommandView =====

const NOISE_EVENT_TYPES = new Set(["tool_start", "tool_end"]);

export function CommandView() {
	const [activityEvents, setActivityEvents] = useState([]);
	const [mail, setMail] = useState([]);

	// Poll event store every 5 seconds
	useEffect(() => {
		let cancelled = false;

		async function fetchActivity() {
			try {
				const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
				const data = await fetchJson(`/api/events?since=${encodeURIComponent(since)}&limit=200`);
				if (!cancelled) {
					const rawEvents = Array.isArray(data) ? data : (data?.events ?? []);
					const filteredEvents = rawEvents
						.filter((e) => !NOISE_EVENT_TYPES.has(e.eventType))
						.map((e) => ({
							id: `evt-${e.id}`,
							type: e.eventType,
							agent: e.agentName,
							summary: buildEventSummary(e),
							detail: e.data,
							createdAt: e.createdAt,
						}));
					setActivityEvents(filteredEvents);
				}
			} catch (_err) {
				// non-fatal
			}
		}

		fetchActivity();
		const interval = setInterval(fetchActivity, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	// Poll mail every 5s
	useEffect(() => {
		let cancelled = false;
		async function fetchMail() {
			try {
				const data = await fetchJson("/api/mail");
				if (!cancelled) {
					setMail(Array.isArray(data) ? data : (data?.recent ?? []));
				}
			} catch (_err) {
				// non-fatal
			}
		}
		fetchMail();
		const interval = setInterval(fetchMail, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	const agents = appState.agents.value;

	return html`
		<div class="flex h-full bg-[#0f0f0f] min-h-0">
			<!-- Coordinator Chat (left, ~55%) -->
			<div
				class="flex flex-col min-h-0 overflow-hidden border-r border-[#2a2a2a]"
				style="flex: 55 1 0%"
			>
				<${CoordinatorChat} mail=${mail} />
			</div>

			<!-- Agent Roster (right, ~45%) -->
			<div class="flex flex-col min-h-0 overflow-hidden" style="flex: 45 1 0%">
				<${AgentRoster} agents=${agents} mail=${mail} events=${activityEvents} />
			</div>
		</div>
	`;
}
