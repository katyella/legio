// Legio Web UI — ChatView component
// Preact+HTM component providing the full chat interface:
//   - Task-based sidebar grouping conversations by beads issue
//   - Message feed with thread grouping + smart scroll
//   - Chat input with POST /api/mail/send integration
// No npm dependencies — uses CDN imports. Served as a static ES module.

import { h, html, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "../lib/preact-setup.js";
import { MessageBubble } from "../components/message-bubble.js";

// State dot colors per agent state (Tailwind text color classes)
const STATE_DOT_COLORS = {
	working: "text-green-500",
	booting: "text-yellow-500",
	stalled: "text-red-500",
	zombie: "text-gray-600",
	completed: "text-gray-400",
};

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
	const appState =
		propState || (typeof window !== "undefined" ? window.state : null) || {};
	const mail = appState.mail || [];
	const agents = appState.agents || [];
	const issues = appState.issues || [];

	// UI state — local to this component, persisted across re-renders
	const [selectedTask, setSelectedTask] = useState(null);
	const [selectedAgent, setSelectedAgent] = useState(null);
	const [expandedTasks, setExpandedTasks] = useState(() => new Set());
	const [collapsedThreads, setCollapsedThreads] = useState(() => new Set());

	// Chat input form state
	const [fromVal, setFromVal] = useState("orchestrator");
	const [toVal, setToVal] = useState("");
	const [subjectVal, setSubjectVal] = useState("");
	const [bodyVal, setBodyVal] = useState("");
	const [typeVal, setTypeVal] = useState("status");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");

	// Feed container ref for smart scroll
	const feedRef = useRef(null);
	// Track whether user is near the bottom of the feed
	const isNearBottomRef = useRef(true);

	// Keep "To" field pre-filled with selected agent
	useEffect(() => {
		setToVal(selectedAgent || "");
	}, [selectedAgent]);

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
		isNearBottomRef.current =
			feed.scrollHeight - feed.scrollTop - feed.clientHeight < 50;
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

	// ----- Message filtering and thread grouping -----

	let filteredMessages = [...mail];

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
	}, []);

	const handleAllMessagesClick = useCallback(() => {
		setSelectedTask(null);
		setSelectedAgent(null);
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

	const handleSend = useCallback(async () => {
		if (!fromVal.trim() || !toVal.trim()) {
			setSendError("From and To are required.");
			return;
		}
		setSendError("");
		setSending(true);
		try {
			const sendFn =
				propOnSendMessage ||
				(typeof window !== "undefined" ? window.sendChatMessage : null);
			if (sendFn) {
				await sendFn(
					fromVal.trim(),
					toVal.trim(),
					subjectVal.trim(),
					bodyVal.trim(),
					typeVal,
				);
			} else {
				// Direct fetch fallback when app.js globals are unavailable
				const res = await fetch("/api/mail/send", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						from: fromVal.trim(),
						to: toVal.trim(),
						subject: subjectVal.trim(),
						body: bodyVal.trim(),
						type: typeVal,
						priority: "normal",
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
			// Clear body/subject on success; preserve from/to/type
			setSubjectVal("");
			setBodyVal("");
		} catch (err) {
			setSendError(err.message || "Send failed");
		} finally {
			setSending(false);
		}
	}, [fromVal, toVal, subjectVal, bodyVal, typeVal, propOnSendMessage]);

	// ----- Header data -----

	const selectedAgentData = selectedAgent
		? agents.find((a) => a.agentName === selectedAgent)
		: null;

	const selectedTaskData =
		selectedTask && selectedTask !== "__general__"
			? taskGroups.get(selectedTask)
			: null;

	// Input field shared classes
	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415]";

	const showGeneral = generalAgentNames.size > 0 || generalCounts.msgCount > 0;

	return html`
		<div class="flex h-full">

			<!-- Sidebar -->
			<div
				class="w-64 bg-[#0f0f0f] border-r border-[#2a2a2a] overflow-y-auto flex-shrink-0"
			>
				<!-- All Messages item -->
				<div
					class=${"px-3 py-2 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-2 text-sm" +
						(!selectedTask && !selectedAgent ? " bg-[#1a1a1a] border-l-2 border-[#E64415]" : "")}
					onClick=${handleAllMessagesClick}
				>
					<span class="text-[#e5e5e5]">All Messages</span>
				</div>

				<!-- Tasks section header -->
				${sortedGroups.length > 0 &&
				html`<div
					class="px-3 py-1 text-xs text-[#555] uppercase tracking-wider border-b border-[#1a1a1a] mt-1"
				>
					Tasks
				</div>`}

				<!-- Task list -->
				${sortedGroups.map(([beadId, group]) => {
					const isTaskSelected = selectedTask === beadId && !selectedAgent;
					const isExpanded = expandedTasks.has(beadId);
					const status = group.issue?.status || "open";
					const statusIcon = STATUS_ICONS[status] || STATUS_ICONS.open;
					const statusColor = STATUS_ICON_COLORS[status] || STATUS_ICON_COLORS.open;
					const rawTitle = group.issue?.title;
					const title = rawTitle
						? rawTitle.length > 32
							? rawTitle.slice(0, 32) + "\u2026"
							: rawTitle
						: beadId;
					const taskItemClass =
						"px-3 py-2 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-1.5 text-sm" +
						(isTaskSelected ? " bg-[#1a1a1a] border-l-2 border-[#E64415]" : "");

					return html`
						<div key=${beadId}>
							<div class=${taskItemClass} onClick=${() => handleTaskClick(beadId)}>
								<button
									class="text-xs text-[#555] hover:text-[#999] bg-transparent border-none cursor-pointer p-0 shrink-0"
									onClick=${(e) => handleTaskToggle(e, beadId)}
								>
									${isExpanded ? "\u25BC" : "\u25B6"}
								</button>
								<span class=${"text-xs shrink-0 " + statusColor}>${statusIcon}</span>
								<span class="flex-1 truncate text-[#e5e5e5] text-xs">${title}</span>
								${group.unreadCount > 0
									? html`<span
											class="text-xs bg-[#E64415] text-white px-1 rounded-full shrink-0"
										>${group.unreadCount}</span
									  >`
									: group.msgCount > 0
									? html`<span class="text-xs text-[#555] shrink-0"
											>${group.msgCount}</span
									  >`
									: null}
							</div>

							${isExpanded &&
							group.agents.map((ag) => {
								const isAgentSelected = selectedAgent === ag.agentName;
								const dotColor = STATE_DOT_COLORS[ag.state] || "text-gray-400";
								const agentItemClass =
									"pl-8 pr-3 py-1.5 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-1.5 text-xs" +
									(isAgentSelected ? " bg-[#1a1a1a] border-l-2 border-[#E64415]" : "");

								return html`
									<div
										key=${ag.agentName}
										class=${agentItemClass}
										onClick=${(e) => handleAgentClick(e, ag.agentName)}
									>
										<span class=${"text-xs " + dotColor}>\u25CF</span>
										<span class="flex-1 truncate text-[#e5e5e5]">${ag.agentName}</span>
										<span class="text-[#555] shrink-0">${ag.capability || ""}</span>
									</div>
								`;
							})}
						</div>
					`;
				})}

				<!-- General / Unassigned section -->
				${showGeneral &&
				html`<div class="mt-1 border-t border-[#1a1a1a]">
					<div class="px-3 py-1 text-xs text-[#555] uppercase tracking-wider">
						General
					</div>
					<div
						class=${"px-3 py-2 cursor-pointer hover:bg-[#1a1a1a] flex items-center gap-2 text-sm" +
							(selectedTask === "__general__" && !selectedAgent
								? " bg-[#1a1a1a] border-l-2 border-[#E64415]"
								: "")}
						onClick=${() => handleTaskClick("__general__")}
					>
						<span class="flex-1 truncate text-[#e5e5e5] text-xs">Unassigned</span>
						${generalCounts.unreadCount > 0
							? html`<span
									class="text-xs bg-[#E64415] text-white px-1 rounded-full shrink-0"
								>${generalCounts.unreadCount}</span
							  >`
							: generalCounts.msgCount > 0
							? html`<span class="text-xs text-[#555] shrink-0"
									>${generalCounts.msgCount}</span
							  >`
							: null}
					</div>
				</div>`}
			</div>

			<!-- Chat main area -->
			<div class="flex-1 flex flex-col min-w-0">

				<!-- Header -->
				<div class="px-4 py-3 border-b border-[#2a2a2a] flex items-center gap-2">
					${selectedAgent
						? html`
								<span class="font-semibold text-[#e5e5e5]">${selectedAgent}</span>
								${selectedAgentData &&
								html`
									<span class="text-xs px-1.5 py-0.5 rounded bg-[#333] text-[#999]">
										${selectedAgentData.capability || ""}
									</span>
									<span
										class=${"text-xs px-1.5 py-0.5 rounded bg-[#333] " +
											(STATE_DOT_COLORS[selectedAgentData.state] || "text-gray-400")}
									>
										${selectedAgentData.state || ""}
									</span>
								`}
						  `
						: selectedTask === "__general__"
						? html`<span class="font-semibold text-[#e5e5e5]">Unassigned Messages</span>`
						: selectedTaskData
						? html`
								<span class="font-mono text-xs text-[#999]">${selectedTask}</span>
								<span class="font-semibold text-[#e5e5e5] truncate">
									${selectedTaskData.issue?.title || selectedTask}
								</span>
								${selectedTaskData.issue &&
								html`<span
									class=${"text-xs px-1.5 py-0.5 rounded bg-[#333] " +
										(STATUS_ICON_COLORS[selectedTaskData.issue.status] || "text-gray-400")}
								>
									${selectedTaskData.issue.status}
								</span>`}
								<span class="text-xs text-[#666]">
									${selectedTaskData.agents.length}
									${selectedTaskData.agents.length === 1 ? "agent" : "agents"}
								</span>
						  `
						: html`<span class="font-semibold text-[#e5e5e5]">All Messages</span>`}
				</div>

				<!-- Message feed -->
				<div
					class="flex-1 overflow-y-auto p-4 min-h-0"
					ref=${feedRef}
					onScroll=${handleFeedScroll}
				>
					${roots.length === 0
						? html`<div
								class="flex items-center justify-center h-full text-[#666] text-sm"
							>
								No messages yet
							</div>`
						: roots.map((root) => {
								const replies = replyMap[root.id] || [];

								if (replies.length === 0) {
									return html`
										<${MessageBubble}
											key=${root.id}
											msg=${root}
											isReply=${false}
											selectedAgent=${selectedAgent}
											selectedPair=${null}
										/>
									`;
								}

								const isCollapsed = collapsedThreads.has(root.id);
								const replyWord = replies.length === 1 ? "reply" : "replies";

								return html`
									<div key=${root.id}>
										<${MessageBubble}
											msg=${root}
											isReply=${false}
											selectedAgent=${selectedAgent}
											selectedPair=${null}
										/>
										<div class="ml-3 mb-2">
											<button
												class="text-xs text-[#666] hover:text-[#999] flex items-center gap-1 mb-1 bg-transparent border-none cursor-pointer p-0"
												onClick=${() => handleThreadToggle(root.id)}
											>
												${isCollapsed ? "\u25B6" : "\u25BC"} ${replies.length}
												${replyWord}
											</button>
											${!isCollapsed &&
											replies.map(
												(reply) => html`
													<${MessageBubble}
														key=${reply.id}
														msg=${reply}
														isReply=${true}
														selectedAgent=${selectedAgent}
														selectedPair=${null}
													/>
												`,
											)}
										</div>
									</div>
								`;
							})}
				</div>

				<!-- Chat input -->
				<div class="border-t border-[#2a2a2a] p-3">
					<div class="flex gap-2 mb-2">
						<input
							type="text"
							placeholder="From"
							value=${fromVal}
							onInput=${(e) => setFromVal(e.target.value)}
							class=${`flex-1 ${inputClass}`}
						/>
						<input
							type="text"
							placeholder="To"
							value=${toVal}
							onInput=${(e) => setToVal(e.target.value)}
							class=${`flex-1 ${inputClass}`}
						/>
					</div>
					<input
						type="text"
						placeholder="Subject"
						value=${subjectVal}
						onInput=${(e) => setSubjectVal(e.target.value)}
						class=${`w-full ${inputClass} mb-2`}
					/>
					<textarea
						placeholder="Message body..."
						rows="2"
						value=${bodyVal}
						onInput=${(e) => setBodyVal(e.target.value)}
						class=${`w-full ${inputClass} mb-2 resize-none`}
					/>
					<div class="flex items-center gap-2 flex-wrap">
						<select
							value=${typeVal}
							onChange=${(e) => setTypeVal(e.target.value)}
							class="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] outline-none"
						>
							<option value="status">status</option>
							<option value="question">question</option>
							<option value="result">result</option>
							<option value="error">error</option>
						</select>
						<button
							onClick=${handleSend}
							disabled=${sending}
							class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-sm px-3 py-1 rounded cursor-pointer border-none"
						>
							${sending ? "Sending..." : "Send"}
						</button>
						${sendError &&
						html`<span class="text-xs text-red-400">${sendError}</span>`}
					</div>
				</div>

			</div>
		</div>
	`;
}
