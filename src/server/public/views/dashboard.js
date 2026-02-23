// dashboard.js — Unified Dashboard View (Preact+HTM)
// Two-panel: Left = Coordinator Chat (~58%), Right = Sidebar (MetricsStrip + AgentRoster + MergeQueue)
// Merges former CommandView and DashboardView into a single unified page.

import { fetchJson, postJson } from "../lib/api.js";
import { renderMarkdown } from "../lib/markdown.js";
import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";
import { agentActivityLog, appState } from "../lib/state.js";
import {
	agentColor,
	groupActivityMessages,
	isActivityMessage,
	stateColor,
	stateIcon,
	timeAgo,
} from "../lib/utils.js";

// ---------------------------------------------------------------------------
// Constants
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

const MERGE_STATUS_COLOR = {
	pending: "text-yellow-500",
	merging: "text-green-500",
	merged: "text-gray-500",
	conflict: "text-red-500",
	failed: "text-red-500",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MetricsStrip
// ---------------------------------------------------------------------------

function MetricsStrip({ agents, mergeQueue, status }) {
	const totalSessions = agents.length;
	const activeCount = agents.filter((a) => a.state === "working" || a.state === "booting").length;
	const completedCount = agents.filter((a) => a.state === "completed").length;
	const unreadMail = status?.unreadMailCount ?? 0;
	const pendingMerges = status?.mergeQueueCount ?? mergeQueue.length;

	const stats = [
		{ label: "Sessions", value: totalSessions },
		{ label: "Active", value: activeCount },
		{ label: "Completed", value: completedCount },
		{ label: "Unread Mail", value: unreadMail },
		{ label: "Pending Merges", value: pendingMerges },
	];

	return html`
		<div class="bg-[#1a1a1a] border-b border-[#2a2a2a] shrink-0">
			<div class="border-b border-[#2a2a2a] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-gray-400">
				Metrics
			</div>
			<div class="flex flex-wrap gap-4 px-3 py-2">
				${stats.map(
					({ label, value }) => html`
						<span key=${label} class="text-xs text-gray-400">
							${label}:${" "}<strong class="text-white">${value}</strong>
						</span>
					`,
				)}
			</div>
		</div>
	`;
}

// ---------------------------------------------------------------------------
// MergeQueue
// ---------------------------------------------------------------------------

function MergeQueue({ mergeQueue, onRefresh }) {
	const [mergingBranch, setMergingBranch] = useState(null);
	const [mergingAll, setMergingAll] = useState(false);
	const [error, setError] = useState(null);

	const pendingEntries = mergeQueue.filter((e) => e.status === "pending");

	async function refreshQueue() {
		try {
			const data = await fetchJson("/api/merge-queue");
			if (onRefresh) onRefresh(data);
		} catch (_e) {
			// ignore refresh errors
		}
	}

	function showError(msg) {
		setError(msg);
		setTimeout(() => setError(null), 5000);
	}

	async function handleMergeAll() {
		setMergingAll(true);
		setError(null);
		try {
			await postJson("/api/merge", { all: true });
			await refreshQueue();
		} catch (e) {
			showError(e.message || "Merge all failed");
		} finally {
			setMergingAll(false);
		}
	}

	async function handleMergeBranch(branchName) {
		setMergingBranch(branchName);
		setError(null);
		try {
			await postJson("/api/merge", { branch: branchName });
			await refreshQueue();
		} catch (e) {
			showError(e.message || `Merge failed for ${branchName}`);
		} finally {
			setMergingBranch(null);
		}
	}

	return html`
		<div class="bg-[#1a1a1a] border-t border-[#2a2a2a] shrink-0">
			<div class="border-b border-[#2a2a2a] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-gray-400 flex items-center justify-between">
				<span>Merge Queue</span>
				${
					pendingEntries.length > 0
						? html`<button
							class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-xs px-2 py-1 rounded cursor-pointer border-none"
							onClick=${handleMergeAll}
							disabled=${mergingAll}
						>
							${mergingAll ? "Merging\u2026" : "Merge All"}
						</button>`
						: null
				}
			</div>
			<div class="overflow-y-auto max-h-[30vh] p-2 space-y-1">
				${error ? html`<div class="text-xs text-red-400 mt-1 px-2">${error}</div>` : null}
				${
					mergeQueue.length === 0
						? html`<div class="px-2 py-4 text-center text-gray-500 text-xs">Queue is empty</div>`
						: mergeQueue.map(
								(entry) => html`
								<div
									key=${entry.agentName + entry.branchName}
									class="flex items-center gap-2 px-2 py-1 text-xs hover:bg-white/5 rounded-sm"
								>
									<span class=${MERGE_STATUS_COLOR[entry.status] || "text-gray-400"}>●</span>
									<span class="shrink-0">${entry.agentName || ""}</span>
									<span class="flex-1 truncate font-mono text-gray-400">
										${entry.branchName || ""}
									</span>
									<span class="shrink-0 rounded-sm border border-[#2a2a2a] px-1.5 py-0.5 text-gray-400">
										${entry.status || ""}
									</span>
									${
										entry.status === "pending"
											? html`<button
												class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-xs px-2 py-0.5 rounded cursor-pointer border-none shrink-0"
												onClick=${() => handleMergeBranch(entry.branchName)}
												disabled=${mergingBranch === entry.branchName || mergingAll}
											>
												${mergingBranch === entry.branchName ? "\u2026" : "Merge"}
											</button>`
											: null
									}
								</div>
							`,
							)
				}
			</div>
		</div>
	`;
}

// ---------------------------------------------------------------------------
// AgentRoster
// ---------------------------------------------------------------------------

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
		<div class="flex flex-col flex-1 min-h-0">
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
									.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
									.slice(0, 5);

								// Filter events for this agent
								const agentEvents = events.filter((e) => e.agent === agent.agentName).slice(0, 5);

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

												<!-- Drill-down link -->
												<div class="mb-2">
													<a
														href=${"#inspect/" + agent.agentName}
														class="text-xs text-blue-400 hover:text-blue-300"
													>
														View Details
													</a>
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

// ---------------------------------------------------------------------------
// CoordinatorChat
// ---------------------------------------------------------------------------

function CoordinatorChat({ mail, coordRunning, gwRunning }) {
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");
	const [pendingMessages, setPendingMessages] = useState([]);
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
	const inputRef = useRef(null);
	const pendingCursorRef = useRef(null);
	const baselineCaptureRef = useRef(null);
	const [chatTarget, setChatTarget] = useState("coordinator");
	const neitherRunning = !coordRunning && !gwRunning;

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5]" +
		" placeholder-[#666] outline-none focus:border-[#E64415]";

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

	// Consume pendingChatContext from issue click-through
	useEffect(() => {
		const ctx = appState.pendingChatContext.value;
		if (!ctx) return;
		setInput(`Discuss issue ${ctx.issueId}: ${ctx.title}\n${ctx.description || ""}`);
		appState.pendingChatContext.value = null;
		inputRef.current?.focus();
	}, [appState.pendingChatContext.value]); // eslint-disable-line react-hooks/exhaustive-deps

	// Auto-select the only running target; clear state when target switches
	useEffect(() => {
		if (coordRunning && !gwRunning) {
			setChatTarget("coordinator");
		} else if (!coordRunning && gwRunning) {
			setChatTarget("gateway");
		}
	}, [coordRunning, gwRunning]);

	// Reset stream + thinking state when chat target changes
	useEffect(() => {
		prevFromCoordCountRef.current = 0;
		setThinking(false);
		setStreamText("");
		baselineCaptureRef.current = null;
	}, [chatTarget]);

	// Detect new target responses → clear thinking + matched pending messages
	useEffect(() => {
		if (fromTargetCount > prevFromCoordCountRef.current) {
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
		prevFromCoordCountRef.current = fromTargetCount;
	}, [fromTargetCount]); // eslint-disable-line react-hooks/exhaustive-deps

	// Poll terminal capture while thinking
	useEffect(() => {
		if (!thinking) {
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
	}, [thinking, chatTarget]);

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
			to: chatTarget,
			body: text,
			createdAt: new Date().toISOString(),
			status: "sending",
		};
		setPendingMessages((prev) => [...prev, pending]);

		try {
			if (chatTarget === "gateway") {
				await postJson("/api/gateway/chat", { text });
			} else {
				await postJson("/api/terminal/send", { agent: "coordinator", text });
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
								class=${"text-xs px-2 py-1 rounded " + (chatTarget === "coordinator" ? "bg-[#E64415]/20 text-white" : "text-[#666] hover:text-[#999]")}
								onClick=${() => setChatTarget("coordinator")}
							>Coordinator</button>
							<button
								class=${"text-xs px-2 py-1 rounded " + (chatTarget === "gateway" ? "bg-[#E64415]/20 text-white" : "text-[#666] hover:text-[#999]")}
								onClick=${() => setChatTarget("gateway")}
							>Gateway</button>
						</div>
					`
						: null
				}
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
							${neitherRunning
								? "Start coordinator or gateway to chat"
								: `No ${chatTarget} messages yet`}
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
										${
											isCommand
												? html`<div class="text-[#e5e5e5] whitespace-pre-wrap break-words">
													<span class="text-xs px-1 py-0.5 rounded bg-[#2a2a2a] text-[#888] font-mono mr-1">cmd</span
													><span class="font-mono">${msg.body || ""}</span>
												</div>`
												: html`<div class="text-[#e5e5e5] break-words chat-markdown"
													dangerouslySetInnerHTML=${{ __html: renderMarkdown(msg.body) }}></div>`
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
								${
									streamText
										? html`<div class="text-[#ccc] break-words text-xs max-h-48 overflow-y-auto chat-markdown"
											dangerouslySetInnerHTML=${{ __html: renderMarkdown(streamText) }}></div>`
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
							placeholder=${neitherRunning
								? "Start coordinator or gateway to chat\u2026"
								: chatTarget === "coordinator"
									? "Send command to coordinator\u2026"
									: "Send message to gateway\u2026"}
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

// ---------------------------------------------------------------------------
// CoordinatorBar
// ---------------------------------------------------------------------------

function CoordinatorBar() {
	const [coordStatus, setCoordStatus] = useState(null); // null = unknown, true = running, false = stopped
	const [loading, setLoading] = useState(false); // start/stop in-flight
	const [gwStatus, setGwStatus] = useState(null); // null = unknown, true = running, false = stopped
	const [gwLoading, setGwLoading] = useState(false);
	const [error, setError] = useState(null);

	const poll = useCallback(async (cancelled) => {
		try {
			const data = await fetchJson("/api/coordinator/status");
			if (!cancelled) setCoordStatus(data?.running === true);
		} catch (_err) {
			// non-fatal — leave status as unknown
		}
		try {
			const gwData = await fetchJson("/api/gateway/status");
			if (!cancelled) setGwStatus(gwData?.running === true);
		} catch (_err) { /* non-fatal */ }
	}, []);

	useEffect(() => {
		let cancelled = false;
		poll(cancelled);
		const interval = setInterval(() => poll(cancelled), 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [poll]);

	// Auto-clear error after 5s
	useEffect(() => {
		if (!error) return;
		const timer = setTimeout(() => setError(null), 5000);
		return () => clearTimeout(timer);
	}, [error]);

	const handleStart = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			await postJson("/api/coordinator/start", {});
			await poll(false);
		} catch (err) {
			setError(err?.message ?? "Failed to start coordinator");
		} finally {
			setLoading(false);
		}
	}, [poll]);

	const handleStop = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			await postJson("/api/coordinator/stop", {});
			await poll(false);
		} catch (err) {
			setError(err?.message ?? "Failed to stop coordinator");
		} finally {
			setLoading(false);
		}
	}, [poll]);

	const handleGwStart = useCallback(async () => {
		setGwLoading(true); setError(null);
		try { await postJson("/api/gateway/start", {}); await poll(false); }
		catch (err) { setError(err?.message ?? "Failed to start gateway"); }
		finally { setGwLoading(false); }
	}, [poll]);

	const handleGwStop = useCallback(async () => {
		setGwLoading(true); setError(null);
		try { await postJson("/api/gateway/stop", {}); await poll(false); }
		catch (err) { setError(err?.message ?? "Failed to stop gateway"); }
		finally { setGwLoading(false); }
	}, [poll]);

	const handleSpawn = useCallback(() => {
		if (appState.showSpawnDialog) appState.showSpawnDialog.value = true;
	}, []);

	const isRunning = coordStatus === true;
	const isStopped = coordStatus === false;
	const isUnknown = coordStatus === null;

	const dotColor = isRunning ? "bg-green-500" : isStopped ? "bg-[#666]" : "bg-[#666]";
	const statusText = isRunning ? "Running" : isStopped ? "Stopped" : "Unknown";

	const gwIsRunning = gwStatus === true;
	const gwIsStopped = gwStatus === false;
	const gwIsUnknown = gwStatus === null;

	const gwDotColor = gwIsRunning ? "bg-green-500" : "bg-[#666]";
	const gwStatusText = gwIsRunning ? "Running" : gwIsStopped ? "Stopped" : "Unknown";

	return html`
		<div class="flex items-center gap-3 px-3 py-2 bg-[#1a1a1a] border-b border-[#2a2a2a] shrink-0">
			<div class="flex items-center gap-2">
				<span class="text-xs text-[#666] uppercase tracking-wide">Coordinator</span>
				<div class="flex items-center gap-1">
					<div class="w-2 h-2 rounded-full ${dotColor}"></div>
					<span class="text-sm text-[#e5e5e5]">${statusText}</span>
				</div>
			</div>
			<div class="flex items-center gap-2">
				<button
					onClick=${handleStart}
					disabled=${loading || isRunning}
					class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none"
				>
					${loading && !isRunning ? "\u2026" : "Start"}
				</button>
				<button
					onClick=${handleStop}
					disabled=${loading || isStopped || isUnknown}
					class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none"
				>
					${loading && isRunning ? "\u2026" : "Stop"}
				</button>
			</div>
			<div class="border-l border-[#2a2a2a] pl-3 ml-1 flex items-center gap-2">
				<span class="text-xs text-[#666] uppercase tracking-wide">Gateway</span>
				<div class="flex items-center gap-1">
					<div class="w-2 h-2 rounded-full ${gwDotColor}"></div>
					<span class="text-sm text-[#e5e5e5]">${gwStatusText}</span>
				</div>
			</div>
			<div class="flex items-center gap-2">
				<button
					onClick=${handleGwStart}
					disabled=${gwLoading || gwIsRunning}
					class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none"
				>
					${gwLoading && !gwIsRunning ? "\u2026" : "Start"}
				</button>
				<button
					onClick=${handleGwStop}
					disabled=${gwLoading || gwIsStopped || gwIsUnknown}
					class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none"
				>
					${gwLoading && gwIsRunning ? "\u2026" : "Stop"}
				</button>
				<button
					onClick=${handleSpawn}
					class="bg-[#E64415] hover:bg-[#cc3d12] text-white text-sm px-3 py-1 rounded cursor-pointer border-none"
				>
					Spawn Agent
				</button>
			</div>
			${error ? html`<span class="text-xs text-red-400">${error}</span>` : null}
		</div>
	`;
}

// ---------------------------------------------------------------------------
// DashboardView — main export
// ---------------------------------------------------------------------------

const NOISE_EVENT_TYPES = new Set(["tool_start", "tool_end"]);

export function DashboardView() {
	const [activityEvents, setActivityEvents] = useState([]);
	const [mail, setMail] = useState([]);
	const [mergeQueue, setMergeQueue] = useState([]);
	const [coordRunning, setCoordRunning] = useState(false);
	const [gwRunning, setGwRunning] = useState(false);

	// Poll event store every 5s
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

	// Poll merge-queue every 5s
	useEffect(() => {
		let cancelled = false;
		async function fetchMergeQueue() {
			try {
				const data = await fetchJson("/api/merge-queue");
				if (!cancelled) {
					setMergeQueue(Array.isArray(data) ? data : []);
				}
			} catch (_err) {
				// non-fatal
			}
		}
		fetchMergeQueue();
		const interval = setInterval(fetchMergeQueue, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	// Poll coordinator/gateway status for chat routing
	useEffect(() => {
		let cancelled = false;
		async function fetchStatuses() {
			try {
				const [coordData, gwData] = await Promise.all([
					fetchJson("/api/coordinator/status").catch(() => null),
					fetchJson("/api/gateway/status").catch(() => null),
				]);
				if (!cancelled) {
					setCoordRunning(coordData?.running === true);
					setGwRunning(gwData?.running === true);
				}
			} catch (_err) {
				// non-fatal
			}
		}
		fetchStatuses();
		const interval = setInterval(fetchStatuses, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	const agents = appState.agents.value;
	const status = appState.status.value;

	return html`
		<div class="flex flex-col h-full bg-[#0f0f0f] min-h-0">
			<${CoordinatorBar} />
			<div class="flex flex-1 min-h-0">
				<!-- Coordinator Chat (left, ~58%) -->
				<div
					class="flex flex-col min-h-0 overflow-hidden border-r border-[#2a2a2a]"
					style="flex: 58 1 0%"
				>
					<${CoordinatorChat} mail=${mail} coordRunning=${coordRunning} gwRunning=${gwRunning} />
				</div>

				<!-- Sidebar (right, ~42%): MetricsStrip + AgentRoster + MergeQueue -->
				<div class="flex flex-col min-h-0 overflow-hidden" style="flex: 42 1 0%">
					<${MetricsStrip} agents=${agents} mergeQueue=${mergeQueue} status=${status} />
					<${AgentRoster} agents=${agents} mail=${mail} events=${activityEvents} />
					<${MergeQueue} mergeQueue=${mergeQueue} onRefresh=${setMergeQueue} />
				</div>
			</div>
		</div>
	`;
}
