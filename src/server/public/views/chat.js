// Legio Web UI — ChatView component
// Preact+HTM component providing the full chat interface:
//   - Task-based sidebar grouping conversations by beads issue
//   - Conversations section for direct agent/coordinator/gateway chat
//   - Message feed with thread grouping + smart scroll
//   - Chat input with POST /api/mail/send integration
// No npm dependencies — uses CDN imports. Served as a static ES module.

import { ActivityCard, MessageBubble } from "../components/message-bubble.js";
import { fetchJson, postJson } from "../lib/api.js";
import {
	html,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "../lib/preact-setup.js";
import { agentColor, inferCapability, isActivityMessage, timeAgo } from "../lib/utils.js";

// Issue status icon colors
const STATUS_ICON_COLORS = {
	open: "text-blue-400",
	in_progress: "text-yellow-400",
	closed: "text-green-400",
};

// Issue status icons (Unicode)
const STATUS_ICONS = {
	open: "\u25CB",
	in_progress: "\u25D0",
	closed: "\u2713",
};

// Status sort order for task groups
const STATUS_ORDER = { in_progress: 0, open: 1, closed: 2 };

/**
 * Format a timestamp as a time divider label.
 * Shows "Today at HH:MM", "Yesterday at HH:MM", or "MMM DD at HH:MM".
 */
function formatTimeDivider(isoString) {
	if (!isoString) return "";
	const d = new Date(isoString);
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterdayStart = new Date(todayStart.getTime() - 86400000);
	const hhmm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (d >= todayStart) return `Today at ${hhmm}`;
	if (d >= yesterdayStart) return `Yesterday at ${hhmm}`;
	const month = d.toLocaleString("default", { month: "short" });
	return `${month} ${d.getDate()} at ${hhmm}`;
}

/**
 * Build task groups from agents, issues, and mail.
 *
 * @returns {{ taskGroups: Map, generalAgentNames: Set, agentTaskMap: Map }}
 *   - taskGroups: Map<beadId, { issue, agents[], agentNames: Set, msgCount, unreadCount }>
 *   - generalAgentNames: Set<string> of agents with no beadId
 *   - agentTaskMap: Map<agentName, beadId>
 */
function buildTaskGroups(agents, issues, mail) {
	const taskGroups = new Map();
	const generalAgentNames = new Set();
	const agentTaskMap = new Map();
	const issueMap = new Map(issues.map((i) => [i.id, i]));

	for (const agent of agents) {
		const beadId = agent.beadId;
		if (!beadId) {
			generalAgentNames.add(agent.agentName);
			continue;
		}
		agentTaskMap.set(agent.agentName, beadId);

		if (!taskGroups.has(beadId)) {
			taskGroups.set(beadId, {
				issue: issueMap.get(beadId) || null,
				agents: [],
				agentNames: new Set(),
				msgCount: 0,
				unreadCount: 0,
			});
		}
		const group = taskGroups.get(beadId);
		group.agents.push(agent);
		group.agentNames.add(agent.agentName);
	}

	// Count messages per task
	for (const msg of mail) {
		const fromTask = agentTaskMap.get(msg.from);
		const toTask = agentTaskMap.get(msg.to);
		// Attribute message to the task of either participant (prefer from)
		const taskId = fromTask || toTask;
		if (taskId && taskGroups.has(taskId)) {
			const group = taskGroups.get(taskId);
			group.msgCount++;
			if (!msg.read) group.unreadCount++;
		}
	}

	return { taskGroups, generalAgentNames, agentTaskMap };
}

/**
 * Sort task groups: in_progress first, then open, then closed.
 * Within same status, sort by unread count (desc) then msgCount (desc).
 */
function sortTaskGroups(taskGroups) {
	return [...taskGroups.entries()].sort(([, a], [, b]) => {
		const aStatus = a.issue?.status || "open";
		const bStatus = b.issue?.status || "open";
		const aOrder = STATUS_ORDER[aStatus] ?? 3;
		const bOrder = STATUS_ORDER[bStatus] ?? 3;
		if (aOrder !== bOrder) return aOrder - bOrder;
		if (b.unreadCount !== a.unreadCount) return b.unreadCount - a.unreadCount;
		return b.msgCount - a.msgCount;
	});
}

/**
 * ChatView — 3-panel chat interface with task-based sidebar.
 *
 * Accepts state via props or falls back to window.state (for integration
 * with the existing app.js render cycle).
 *
 * @param {object} props
 * @param {object}   [props.state]           - App state object (mail, agents, issues, etc.)
 * @param {Function} [props.onSendMessage]   - Send callback(from, to, subject, body, type)
 */
export function ChatView({ state: propState, onSendMessage: propOnSendMessage }) {
	const appState = propState || (typeof window !== "undefined" ? window.state : null) || {};
	const mail = appState.mail || [];
	const agents = appState.agents || [];
	const issues = appState.issues || [];

	// UI state — local to this component, persisted across re-renders
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [selectedTask, setSelectedTask] = useState(null);
	const [selectedAgent, setSelectedAgent] = useState(null);
	const [expandedTasks, setExpandedTasks] = useState(() => new Set());
	const [collapsedThreads, setCollapsedThreads] = useState(() => new Set());

	// Conversation state — direct chat with coordinator/gateway/agents
	// null | { type: 'coordinator' | 'gateway' | 'agent', name: string, label: string, capability?: string, state?: string }
	const [selectedConversation, setSelectedConversation] = useState(null);
	const [conversationHistory, setConversationHistory] = useState([]);
	const [pendingConvMessages, setPendingConvMessages] = useState([]);

	// Chat/All mode toggle
	const [chatMode, setChatMode] = useState("chat");

	// Chat input form state (simplified: no From, Subject, or Type)
	const [toVal, setToVal] = useState("");
	const [bodyVal, setBodyVal] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");

	// Feed container ref for smart scroll
	const feedRef = useRef(null);
	// Track whether user is near the bottom of the feed
	const isNearBottomRef = useRef(true);

	// Keep "To" field pre-filled with selected agent (only when no conversation selected)
	useEffect(() => {
		if (selectedConversation) return;
		setToVal(selectedAgent || "");
	}, [selectedAgent, selectedConversation]);

	// Fetch conversation history when selectedConversation changes, then poll every 3s
	useEffect(() => {
		if (!selectedConversation) {
			setConversationHistory([]);
			setPendingConvMessages([]);
			return;
		}

		setPendingConvMessages([]);
		setConversationHistory([]);

		let url = null;
		if (selectedConversation.type === "coordinator") {
			url = "/api/coordinator/chat/history?limit=100";
		} else if (selectedConversation.type === "agent") {
			url = `/api/agents/${selectedConversation.name}/chat/history`;
		}
		// gateway has no history endpoint

		if (!url) return;

		const fetchHistory = () => {
			fetchJson(url)
				.then((data) => {
					setConversationHistory(Array.isArray(data) ? data : data.messages || []);
				})
				.catch(() => {
					// Gracefully handle 404s since backend may not be deployed yet
					setConversationHistory([]);
				});
		};

		fetchHistory();
		const intervalId = setInterval(fetchHistory, 3000);
		return () => clearInterval(intervalId);
	}, [selectedConversation]);

	// Smart scroll: after every render, scroll to bottom only if near bottom
	useLayoutEffect(() => {
		const feed = feedRef.current;
		if (feed && isNearBottomRef.current) {
			feed.scrollTop = feed.scrollHeight;
		}
	});

	const handleFeedScroll = useCallback(() => {
		const feed = feedRef.current;
		if (!feed) return;
		isNearBottomRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 50;
	}, []);

	// Build task groups (memoized)
	const { taskGroups, generalAgentNames, agentTaskMap } = useMemo(
		() => buildTaskGroups(agents, issues, mail),
		[agents, issues, mail],
	);

	// Sorted task group entries (memoized)
	const sortedGroups = useMemo(() => sortTaskGroups(taskGroups), [taskGroups]);

	// General (unassigned) message counts
	const generalCounts = useMemo(() => {
		let msgCount = 0;
		let unreadCount = 0;
		for (const msg of mail) {
			if (!agentTaskMap.has(msg.from) && !agentTaskMap.has(msg.to)) {
				msgCount++;
				if (!msg.read) unreadCount++;
			}
		}
		return { msgCount, unreadCount };
	}, [mail, agentTaskMap]);

	// Conversation entries for sidebar (memoized)
	// Always shows Coordinator and Gateway; adds all active agents
	const conversationEntries = useMemo(() => {
		const entries = [
			{ type: "coordinator", name: "coordinator", label: "Coordinator" },
			{ type: "gateway", name: "gateway", label: "Gateway" },
		];
		for (const agent of agents) {
			if (agent.agentName === "coordinator" || agent.agentName === "gateway") continue;
			entries.push({
				type: "agent",
				name: agent.agentName,
				label: agent.agentName,
				capability: agent.capability,
				state: agent.state,
			});
		}
		return entries;
	}, [agents]);

	// ----- Message filtering and thread grouping -----

	let filteredMessages;

	if (selectedConversation) {
		// Merge conversation history + relevant mail + pending optimistic messages
		const target = selectedConversation.name;
		const convMail = mail.filter((m) => {
			const isRelevant = m.from === target || m.to === target;
			const isHuman = !m.audience || m.audience === "human" || m.audience === "both";
			return isRelevant && isHuman;
		});

		// Deduplicate by id, sort chronologically
		const seenIds = new Set();
		const merged = [];
		for (const m of [...conversationHistory, ...convMail, ...pendingConvMessages]) {
			if (m.id && seenIds.has(m.id)) continue;
			if (m.id) seenIds.add(m.id);
			merged.push(m);
		}
		filteredMessages = merged;
	} else {
		filteredMessages = [...mail];

		if (selectedAgent) {
			// Filter to just this agent's messages
			filteredMessages = filteredMessages.filter(
				(m) => m.from === selectedAgent || m.to === selectedAgent,
			);
		} else if (selectedTask === "__general__") {
			// Show messages where neither from nor to has a beadId
			filteredMessages = filteredMessages.filter(
				(m) => !agentTaskMap.has(m.from) && !agentTaskMap.has(m.to),
			);
		} else if (selectedTask) {
			// Show messages for this task's agents
			const group = taskGroups.get(selectedTask);
			if (group) {
				const agentNames = group.agentNames;
				filteredMessages = filteredMessages.filter(
					(m) => agentNames.has(m.from) || agentNames.has(m.to),
				);
			} else {
				filteredMessages = [];
			}
		}

		// In chat mode, hide protocol/activity messages (only for non-conversation views)
		if (chatMode === "chat") {
			filteredMessages = filteredMessages.filter((m) => {
				// Use audience field when available (new API), fall back to type heuristic (backward compat)
				if (m.audience) {
					return m.audience === "human" || m.audience === "both";
				}
				return !isActivityMessage(m);
			});
		}
	}

	filteredMessages.sort(
		(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
	);

	// Root messages: no threadId, or threadId equals their own id
	const roots = filteredMessages.filter((m) => !m.threadId || m.threadId === m.id);

	// Reply map: threadId -> MailMessage[]
	const replyMap = {};
	filteredMessages.forEach((m) => {
		if (m.threadId && m.threadId !== m.id) {
			if (!replyMap[m.threadId]) replyMap[m.threadId] = [];
			replyMap[m.threadId].push(m);
		}
	});

	// ----- Event handlers -----

	const handleTaskClick = useCallback((taskId) => {
		setSelectedTask(taskId);
		setSelectedAgent(null);
		setSelectedConversation(null);
		setSidebarOpen(false);
		// Auto-expand task on click (not for general section)
		if (taskId && taskId !== "__general__") {
			setExpandedTasks((prev) => {
				const next = new Set(prev);
				next.add(taskId);
				return next;
			});
		}
	}, []);

	const handleTaskToggle = useCallback((e, taskId) => {
		e.stopPropagation();
		setExpandedTasks((prev) => {
			const next = new Set(prev);
			if (next.has(taskId)) {
				next.delete(taskId);
			} else {
				next.add(taskId);
			}
			return next;
		});
	}, []);

	const handleAgentClick = useCallback((e, agentName) => {
		e.stopPropagation();
		setSelectedAgent(agentName);
		setSelectedConversation(null);
		setSidebarOpen(false);
	}, []);

	const handleAllMessagesClick = useCallback(() => {
		setSelectedTask(null);
		setSelectedAgent(null);
		setSelectedConversation(null);
		setSidebarOpen(false);
	}, []);

	const handleThreadToggle = useCallback((threadId) => {
		setCollapsedThreads((prev) => {
			const next = new Set(prev);
			if (next.has(threadId)) {
				next.delete(threadId);
			} else {
				next.add(threadId);
			}
			return next;
		});
	}, []);

	const handleConversationClick = useCallback((conv) => {
		setSelectedConversation(conv);
		setSelectedTask(null);
		setSelectedAgent(null);
		setSidebarOpen(false);
	}, []);

	const handleSend = useCallback(async () => {
		// Conversation mode: route to agent/coordinator/gateway endpoint
		if (selectedConversation) {
			if (!bodyVal.trim()) {
				setSendError("Message body is required.");
				return;
			}
			setSendError("");
			setSending(true);

			// Create optimistic pending message
			const optimisticId = `pending-${Date.now()}`;
			const optimistic = {
				id: optimisticId,
				from: "you",
				to: selectedConversation.name,
				subject: "",
				body: bodyVal.trim(),
				createdAt: new Date().toISOString(),
				audience: "human",
				_chatTarget: selectedConversation.name,
			};
			setPendingConvMessages((prev) => [...prev, optimistic]);

			let url;
			if (selectedConversation.type === "coordinator") {
				url = "/api/coordinator/chat";
			} else if (selectedConversation.type === "gateway") {
				url = "/api/gateway/chat";
			} else {
				url = `/api/agents/${selectedConversation.name}/chat`;
			}

			try {
				await postJson(url, { text: bodyVal.trim() });
				setBodyVal("");
				// Keep optimistic message until the next poll picks up the real response
			} catch (err) {
				setSendError(err.message || "Send failed");
				// Remove the failed optimistic message
				setPendingConvMessages((prev) => prev.filter((m) => m.id !== optimisticId));
			} finally {
				setSending(false);
			}
			return;
		}

		// Standard mail mode
		if (!toVal.trim() || !bodyVal.trim()) {
			setSendError("To and body are required.");
			return;
		}
		setSendError("");
		setSending(true);
		try {
			const sendFn =
				propOnSendMessage || (typeof window !== "undefined" ? window.sendChatMessage : null);
			if (sendFn) {
				await sendFn("orchestrator", toVal.trim(), "", bodyVal.trim(), "status");
			} else {
				// Direct fetch fallback when app.js globals are unavailable
				const res = await fetch("/api/mail/send", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						from: "orchestrator",
						to: toVal.trim(),
						subject: "",
						body: bodyVal.trim(),
						type: "status",
						priority: "normal",
						audience: "human",
					}),
				});
				if (!res.ok) {
					const err = await res.json().catch(() => ({}));
					throw new Error(err.error || "Send failed");
				}
				const msg = await res.json();
				if (typeof window !== "undefined" && window.state) {
					window.state.mail.push(msg);
				}
			}
			// Clear body on success; preserve to
			setBodyVal("");
		} catch (err) {
			setSendError(err.message || "Send failed");
		} finally {
			setSending(false);
		}
	}, [selectedConversation, toVal, bodyVal, propOnSendMessage]);

	// ----- Header data -----

	const selectedAgentData = selectedAgent
		? agents.find((a) => a.agentName === selectedAgent)
		: null;

	const selectedTaskData =
		selectedTask && selectedTask !== "__general__" ? taskGroups.get(selectedTask) : null;

	// Unread count for messages in the current view
	const unreadInView = filteredMessages.filter((m) => !m.read).length;

	// Input field shared classes
	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415]";

	const showGeneral = generalAgentNames.size > 0 || generalCounts.msgCount > 0;

	// ----- Message feed rendering helpers -----

	// Render a single message as ActivityCard or MessageBubble based on type.
	function renderMessage(msg, showName, compact) {
		// Use audience field when available, fall back to type-based detection
		const isActivity = msg.audience ? msg.audience === "agent" : isActivityMessage(msg);
		if (isActivity) {
			return html`<${ActivityCard}
				key=${msg.id}
				event=${msg}
				capability=${inferCapability(msg.from, agents) || inferCapability(msg.to, agents)}
			/>`;
		}
		const capability = inferCapability(msg.from, agents);
		const isUser = msg.from === "orchestrator" || msg.from === "you" || msg.from === "human";
		return html`<${MessageBubble}
			key=${msg.id}
			msg=${msg}
			capability=${capability || (isUser ? "coordinator" : null)}
			isUser=${isUser}
			showName=${showName}
			compact=${compact}
		/>`;
	}

	// Render root messages with grouping and time dividers.
	// Tracks prevRootMsg via closure to determine showHeader and time gaps.
	// Returns flat array so each root can emit [divider?, bubble].
	let prevRootMsg = null;
	const feedItems = roots.flatMap((root) => {
		const replies = replyMap[root.id] || [];

		// Show header when sender changes or gap > 2 minutes
		const showHeader =
			!prevRootMsg ||
			prevRootMsg.from !== root.from ||
			new Date(root.createdAt).getTime() - new Date(prevRootMsg.createdAt).getTime() > 120000;

		// Time divider when gap > 30 minutes between root messages
		const showDivider =
			prevRootMsg &&
			new Date(root.createdAt).getTime() - new Date(prevRootMsg.createdAt).getTime() > 1800000;

		prevRootMsg = root;

		const items = [];

		if (showDivider) {
			items.push(html`
				<div key=${`divider-${root.id}`} class="flex items-center gap-3 my-4">
					<div class="flex-1 border-t border-[#2a2a2a]"></div>
					<span class="text-xs text-[#555]">${formatTimeDivider(root.createdAt)}</span>
					<div class="flex-1 border-t border-[#2a2a2a]"></div>
				</div>
			`);
		}

		if (replies.length === 0) {
			items.push(renderMessage(root, showHeader, !showHeader));
		} else {
			const isCollapsed = collapsedThreads.has(root.id);
			const replyWord = replies.length === 1 ? "reply" : "replies";
			const lastReply = replies[replies.length - 1];
			items.push(html`
				<div key=${root.id}>
					${renderMessage(root, showHeader, !showHeader)}
					<div class="ml-3 mb-2">
						<button
							class="text-xs text-[#666] hover:text-[#999] flex items-center gap-1 mb-1 bg-transparent border-none cursor-pointer p-0"
							onClick=${() => handleThreadToggle(root.id)}
						>
							${isCollapsed ? "\u25B6" : "\u25BC"} ${replies.length} ${replyWord}
							${
								lastReply
									? html`<span class="text-[#444] ml-1">· ${timeAgo(lastReply.createdAt)}</span>`
									: null
							}
						</button>
						${!isCollapsed && replies.map((reply) => renderMessage(reply, true, false))}
					</div>
				</div>
			`);
		}

		return items;
	});

	// ----- Agent color helpers for sidebar and header -----

	// Get capability colors for an agent (safe fallback for missing capability)
	function capabilityColors(capability) {
		return agentColor(capability || null);
	}

	return html`
		<div class="flex flex-col md:flex-row h-full">

			<!-- Sidebar -->
			<div
				class={`w-full md:w-64 bg-[#0f0f0f] border-r border-[#2a2a2a] border-b md:border-b-0 overflow-y-auto flex-shrink-0${sidebarOpen ? '' : ' hidden md:block'}`}
			>
				<!-- All Messages item -->
				<div
					class=${
						"px-3 py-2 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-2 text-sm" +
						(!selectedTask && !selectedAgent && !selectedConversation
							? " bg-[#1a1a1a] border-l-2 border-[#E64415]"
							: "")
					}
					onClick=${handleAllMessagesClick}
				>
					<span class="text-[#e5e5e5]">All Messages</span>
				</div>

				<!-- Conversations section -->
				<div class="mt-1 border-t border-[#1a1a1a]">
					<div class="px-3 py-1 text-xs text-[#555] uppercase tracking-wider">
						Conversations
					</div>
					${conversationEntries.map((conv) => {
						const isSelected =
							selectedConversation &&
							selectedConversation.type === conv.type &&
							selectedConversation.name === conv.name;
						const colors = capabilityColors(conv.capability || null);
						const convItemClass =
							"px-3 py-2 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-2 text-sm" +
							(isSelected ? " bg-[#1a1a1a] border-l-2 border-[#E64415]" : "");
						return html`
							<div
								key=${conv.name}
								class=${convItemClass}
								onClick=${() => handleConversationClick(conv)}
							>
								<span class=${`text-xs shrink-0 ${colors.dot}`}>\u25CF</span>
								<span class="flex-1 truncate text-[#e5e5e5] text-xs">${conv.label}</span>
								${
									conv.capability
										? html`<span
											class=${`text-xs px-1 rounded shrink-0 ${colors.bg} ${colors.text}`}
										>${conv.capability}</span>`
										: null
								}
								${
									conv.state
										? html`<span class="text-[#555] text-xs shrink-0">${conv.state}</span>`
										: null
								}
							</div>
						`;
					})}
				</div>

				<!-- Tasks section header -->
				${
					sortedGroups.length > 0 &&
					html`<div
					class="px-3 py-1 text-xs text-[#555] uppercase tracking-wider border-b border-[#1a1a1a] mt-1"
				>
					Tasks
				</div>`
				}

				<!-- Task list -->
				${sortedGroups.map(([beadId, group]) => {
					const isTaskSelected = selectedTask === beadId && !selectedAgent && !selectedConversation;
					const isExpanded = expandedTasks.has(beadId);
					const status = group.issue?.status || "open";
					const statusIcon = STATUS_ICONS[status] || STATUS_ICONS.open;
					const statusColor = STATUS_ICON_COLORS[status] || STATUS_ICON_COLORS.open;
					const rawTitle = group.issue?.title;
					const title = rawTitle
						? rawTitle.length > 32
							? `${rawTitle.slice(0, 32)}\u2026`
							: rawTitle
						: beadId;
					const taskItemClass =
						"px-3 py-2 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-1.5 text-sm" +
						(isTaskSelected ? " bg-[#1a1a1a] border-l-2 border-[#E64415]" : "");

					// Primary agent capability color for the task row dot
					const primaryAgent = group.agents[0];
					const primaryColors = capabilityColors(primaryAgent?.capability);

					return html`
						<div key=${beadId}>
							<div class=${taskItemClass} onClick=${() => handleTaskClick(beadId)}>
								<button
									class="text-xs text-[#555] hover:text-[#999] bg-transparent border-none cursor-pointer p-0 shrink-0"
									onClick=${(e) => handleTaskToggle(e, beadId)}
								>
									${isExpanded ? "\u25BC" : "\u25B6"}
								</button>
								<span class=${`text-xs shrink-0 ${statusColor}`}>${statusIcon}</span>
								<span class="flex-1 truncate text-[#e5e5e5] text-xs">${title}</span>
								${
									primaryAgent
										? html`<span class=${`text-xs shrink-0 ${primaryColors.dot}`}>\u25CF</span>`
										: null
								}
								${
									group.unreadCount > 0
										? html`<span
											class="text-xs bg-[#E64415] text-white px-1 rounded-full shrink-0"
										>${group.unreadCount}</span
									  >`
										: group.msgCount > 0
											? html`<span class="text-xs text-[#555] shrink-0"
											>${group.msgCount}</span
									  >`
											: null
								}
							</div>

							${
								isExpanded &&
								group.agents.map((ag) => {
									const isAgentSelected = selectedAgent === ag.agentName && !selectedConversation;
									const colors = capabilityColors(ag.capability);
									const agentItemClass =
										"pl-8 pr-3 py-1.5 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-1.5 text-xs" +
										(isAgentSelected ? " bg-[#1a1a1a] border-l-2 border-[#E64415]" : "");

									return html`
									<div
										key=${ag.agentName}
										class=${agentItemClass}
										onClick=${(e) => handleAgentClick(e, ag.agentName)}
									>
										<span class=${`text-xs ${colors.dot}`}>\u25CF</span>
										<span class="flex-1 truncate text-[#e5e5e5]">${ag.agentName}</span>
										${
											ag.capability
												? html`<span
													class=${`text-xs px-1 rounded shrink-0 ${colors.bg} ${colors.text}`}
												>${ag.capability}</span>`
												: null
										}
										<span class="text-[#555] shrink-0 ml-1">${ag.state || ""}</span>
									</div>
								`;
								})
							}
						</div>
					`;
				})}

				<!-- General / Unassigned section -->
				${
					showGeneral &&
					html`<div class="mt-1 border-t border-[#1a1a1a]">
					<div class="px-3 py-1 text-xs text-[#555] uppercase tracking-wider">
						General
					</div>
					<div
						class=${
							"px-3 py-2 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-2 text-sm" +
							(selectedTask === "__general__" && !selectedAgent && !selectedConversation
								? " bg-[#1a1a1a] border-l-2 border-[#E64415]"
								: "")
						}
						onClick=${() => handleTaskClick("__general__")}
					>
						<span class="flex-1 truncate text-[#e5e5e5] text-xs">Unassigned</span>
						${
							generalCounts.unreadCount > 0
								? html`<span
									class="text-xs bg-[#E64415] text-white px-1 rounded-full shrink-0"
								>${generalCounts.unreadCount}</span
							  >`
								: generalCounts.msgCount > 0
									? html`<span class="text-xs text-[#555] shrink-0"
									>${generalCounts.msgCount}</span
							  >`
									: null
						}
					</div>
				</div>`
				}
			</div>

			<!-- Chat main area -->
			<div class="flex-1 flex flex-col min-w-0">

				<!-- Header -->
				<div class="px-4 py-3 border-b border-[#2a2a2a] flex items-center gap-2 flex-wrap">
					<button
						class="md:hidden flex-shrink-0 text-[#999] hover:text-[#e5e5e5] p-1"
						onClick=${() => setSidebarOpen((o) => !o)}
						aria-label="Toggle sidebar"
					>
						<svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
							<rect x="1" y="3" width="16" height="2"/>
							<rect x="1" y="8" width="16" height="2"/>
							<rect x="1" y="13" width="16" height="2"/>
						</svg>
					</button>
					${
						selectedConversation
							? html`
								<div class="flex items-center gap-2 border-l-4 pl-2 border-[#E64415]">
									<span class="font-semibold text-[#e5e5e5]">${selectedConversation.label}</span>
									${
										selectedConversation.capability &&
										html`<span class=${
											`text-xs px-1.5 py-0.5 rounded` +
											` ${capabilityColors(selectedConversation.capability).bg}` +
											` ${capabilityColors(selectedConversation.capability).text}`
										}>
											${selectedConversation.capability}
										</span>`
									}
									${
										selectedConversation.state &&
										html`<span class="text-xs px-1.5 py-0.5 rounded bg-[#333] text-[#999]">
											${selectedConversation.state}
										</span>`
									}
									<span class="text-xs text-[#555]">conversation</span>
								</div>
							  `
							: selectedAgent
								? html`
								<div class=${
									"flex items-center gap-2 border-l-4 pl-2" +
									(selectedAgentData
										? ` ${capabilityColors(selectedAgentData.capability).border}`
										: "")
								}>
									<span class="font-semibold text-[#e5e5e5]">${selectedAgent}</span>
									${
										selectedAgentData &&
										html`
										<span class=${
											`text-xs px-1.5 py-0.5 rounded` +
											` ${capabilityColors(selectedAgentData.capability).bg}` +
											` ${capabilityColors(selectedAgentData.capability).text}`
										}>
											${selectedAgentData.capability || ""}
										</span>
										<span class="text-xs px-1.5 py-0.5 rounded bg-[#333] text-[#999]">
											${selectedAgentData.state || ""}
										</span>
									`
									}
								</div>
							  `
								: selectedTask === "__general__"
									? html`<span class="font-semibold text-[#e5e5e5]">Unassigned Messages</span>`
									: selectedTaskData
										? html`
								<span class="font-mono text-xs text-[#999]">${selectedTask}</span>
								<span class="font-semibold text-[#e5e5e5] truncate">
									${selectedTaskData.issue?.title || selectedTask}
								</span>
								${
									selectedTaskData.issue &&
									html`<span
									class=${
										"text-xs px-1.5 py-0.5 rounded bg-[#333] " +
										(STATUS_ICON_COLORS[selectedTaskData.issue.status] || "text-gray-400")
									}
								>
									${selectedTaskData.issue.status}
								</span>`
								}
								<span class="flex items-center gap-1">
									${selectedTaskData.agents.map(
										(ag) => html`<span
											key=${ag.agentName}
											class=${`text-xs ${capabilityColors(ag.capability).dot}`}
											title=${ag.agentName}
										>\u25CF</span>`,
									)}
								</span>
								<span class="text-xs text-[#666]">
									${selectedTaskData.agents.length}
									${selectedTaskData.agents.length === 1 ? "agent" : "agents"}
								</span>
						  `
										: html`<span class="font-semibold text-[#e5e5e5]">All Messages</span>`
					}
					<span class="flex-1"></span>
					${
						unreadInView > 0 &&
						html`<span class="text-xs bg-[#E64415] text-white px-1.5 py-0.5 rounded-full">
						${unreadInView} unread
					</span>`
					}
					<!-- Chat/All mode toggle (only shown when not in conversation mode) -->
					${
						!selectedConversation &&
						html`<div class="flex items-center gap-0.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded-full px-0.5 py-0.5">
						<button
							class=${
								"text-xs px-2.5 py-0.5 rounded-full border-none cursor-pointer transition-colors" +
								(chatMode === "chat"
									? " bg-[#E64415] text-white"
									: " bg-transparent text-[#666] hover:text-[#999]")
							}
							onClick=${() => setChatMode("chat")}
						>Chat</button>
						<button
							class=${
								"text-xs px-2.5 py-0.5 rounded-full border-none cursor-pointer transition-colors" +
								(chatMode === "all"
									? " bg-[#E64415] text-white"
									: " bg-transparent text-[#666] hover:text-[#999]")
							}
							onClick=${() => setChatMode("all")}
						>All</button>
					</div>`
					}
				</div>

				<!-- Message feed -->
				<div
					class="flex-1 overflow-y-auto p-4 min-h-0"
					ref=${feedRef}
					onScroll=${handleFeedScroll}
				>
					${
						roots.length === 0
							? selectedConversation
								? html`<div class="flex flex-col items-center justify-center h-full text-[#666] text-sm gap-1">
									<span>No messages yet.</span>
									<span class="text-xs">Start a conversation below.</span>
								</div>`
								: chatMode === "chat"
									? html`<div class="flex flex-col items-center justify-center h-full text-[#666] text-sm gap-1">
									<span>No conversation messages yet.</span>
									<span class="text-xs">Switch to "All" to see protocol activity.</span>
								</div>`
									: html`<div class="flex items-center justify-center h-full text-[#666] text-sm">No messages yet</div>`
							: feedItems
					}
				</div>

				<!-- Chat input (simplified: To + Body + Send) -->
				<div class="border-t border-[#2a2a2a] p-3">
					<div class="flex gap-2 items-end">
						<div class="flex-1">
							<div class="flex items-center gap-1 mb-1">
								<span class="text-xs text-[#555]">To:</span>
								${
									selectedConversation
										? html`<span class="text-xs text-[#e5e5e5] font-medium">${selectedConversation.label}</span>`
										: html`<input
											type="text"
											value=${toVal}
											onInput=${(e) => setToVal(e.target.value)}
											class="bg-transparent border-none text-xs text-[#e5e5e5] outline-none w-24"
										/>`
								}
							</div>
							<textarea
								placeholder="Message... (Ctrl+Enter or Cmd+Enter to send)"
								rows="2"
								value=${bodyVal}
								onInput=${(e) => setBodyVal(e.target.value)}
								onKeyDown=${(e) => {
									if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
										e.preventDefault();
										if (!bodyVal.trim()) return;
										handleSend();
									}
								}}
								class=${`w-full ${inputClass} resize-none`}
							/>
						</div>
						<button
							onClick=${handleSend}
							disabled=${sending || !bodyVal.trim()}
							class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none self-end"
						>
							${sending ? "..." : "Send"}
						</button>
					</div>
					${sendError && html`<span class="text-xs text-red-400 mt-1 block">${sendError}</span>`}
				</div>

			</div>
		</div>
	`;
}
