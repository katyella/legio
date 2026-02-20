// Legio Web UI — CommandView component
// Two-panel mission-control interface:
//   - Left: Coordinator chat input + recent coordinator messages (~55%)
//   - Right: Tab switcher — Activity (default) and Messages (ChatView) tabs (~45%)

import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";
import { isActivityMessage, timeAgo } from "../lib/utils.js";
import { agentActivityLog, appState } from "../lib/state.js";
import { ChatView } from "./chat.js";
import { ActivityCard } from "../components/message-bubble.js";

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

// ===== ActivityTimeline =====

function ActivityTimeline({ events, loading, error }) {
	const [typeFilter, setTypeFilter] = useState("");
	const [agentFilter, setAgentFilter] = useState("");
	const [expandedIds, setExpandedIds] = useState(() => new Set());

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5]" +
		" placeholder-[#666] outline-none focus:border-[#E64415]";

	const allTypes = [...new Set(events.map((e) => e.type).filter(Boolean))].sort();

	const filtered = events.filter((ev) => {
		if (typeFilter && ev.type !== typeFilter) return false;
		if (agentFilter && !(ev.agent ?? "").toLowerCase().includes(agentFilter.toLowerCase()))
			return false;
		return true;
	});

	const toggleExpand = useCallback((id) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	return html`
		<div class="flex flex-col h-full min-h-0">
			<!-- Filter bar -->
			<div
				class="flex items-center gap-2 px-3 py-2 border-b border-[#2a2a2a] shrink-0 flex-wrap"
			>
				<select
					value=${typeFilter}
					onChange=${(e) => setTypeFilter(e.target.value)}
					class="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] outline-none"
				>
					<option value="">All types</option>
					${allTypes.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}
				</select>
				<input
					type="text"
					placeholder="Filter by agent..."
					value=${agentFilter}
					onInput=${(e) => setAgentFilter(e.target.value)}
					class=${`${inputClass} flex-1 min-w-0`}
				/>
				${loading ? html`<span class="text-xs text-[#555] shrink-0">Refreshing\u2026</span>` : null}
			</div>

			<!-- Event list -->
			<div class="flex-1 overflow-y-auto min-h-0 p-2">
				${error ? html`<div class="text-red-400 text-sm px-2 py-3">${error}</div>` : null}
				${
					!error && filtered.length === 0
						? html`
							<div class="flex items-center justify-center h-full text-[#666] text-sm">
								No activity recorded yet
							</div>
						`
						: filtered.map((ev) => {
								const isExpanded = expandedIds.has(ev.id);
								const hasDetail = ev.detail != null && ev.detail !== "";
								const badgeClass = typeBadgeClass(ev.type);
								const ts = ev.createdAt ?? ev.timestamp ?? null;

								return html`
									<div
										key=${ev.id}
										class=${
											"mb-1 rounded border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2" +
											(hasDetail ? " cursor-pointer hover:border-[#3a3a3a]" : "")
										}
										onClick=${hasDetail ? () => toggleExpand(ev.id) : undefined}
									>
										<div class="flex items-center gap-2 flex-wrap min-w-0">
											<span
												class=${`text-xs px-1.5 py-0.5 rounded font-mono shrink-0 ${badgeClass}`}
											>
												${ev.type || "unknown"}
											</span>
											${
												ev.agent
													? html`<span class="text-xs text-[#999] shrink-0">${ev.agent}</span>`
													: null
											}
											<span class="flex-1 text-sm text-[#e5e5e5] truncate min-w-0">
												${ev.summary || ""}
											</span>
											<span class="text-xs text-[#555] shrink-0">${timeAgo(ts)}</span>
											${
												hasDetail
													? html`<span class="text-xs text-[#555] shrink-0">
															${isExpanded ? "\u25B2" : "\u25BC"}
														</span>`
													: null
											}
										</div>
										${
											isExpanded && hasDetail
												? html`
													<pre
														class="mt-2 text-xs text-[#999] whitespace-pre-wrap break-all border-t border-[#2a2a2a] pt-2 font-mono"
													>
${typeof ev.detail === "string" ? ev.detail : JSON.stringify(ev.detail, null, 2)}</pre>
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

// ===== CoordinatorChat =====

function CoordinatorChat({ mail }) {
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");
	const [pendingMessages, setPendingMessages] = useState([]);
	const [thinking, setThinking] = useState(false);
	const feedRef = useRef(null);
	const isNearBottomRef = useRef(true);
	const prevFromCoordCountRef = useRef(0);

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

	// Auto-scroll to bottom when near bottom
	useEffect(() => {
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

	const handleKeyDown = useCallback(
		(e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend],
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
					allMessages.length === 0
						? html`
							<div class="flex items-center justify-center h-full text-[#666] text-sm">
								No coordinator messages yet
							</div>
						`
						: allMessages.map((msg) => {
								const isFromUser = msg.from === "you";
								const isSending = msg.status === "sending";

								// Agent lifecycle events → compact centered ActivityCard
								if (msg._isAgentActivity) {
									return html`<${ActivityCard} key=${msg.id} event=${msg} capability=${msg.capability} />`;
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
													${isFromUser ? "You" : (msg.from || "unknown")}
												</span>
												<span class="text-xs text-[#555]">
													${isSending
														? "\u00b7 sending\u2026"
														: `\u00b7 ${timeAgo(msg.createdAt)}`}
												</span>
											</div>
											<div class="text-[#e5e5e5] whitespace-pre-wrap break-words">
												${msg.body || ""}
											</div>
										</div>
									</div>
								`;
							})
				}
				${
					thinking
						? html`
							<div class="flex items-center gap-2 px-3 py-2 text-sm text-[#666]">
								<span class="animate-pulse">\u25cf\u25cf\u25cf</span>
								<span>Thinking...</span>
							</div>
						`
						: null
				}
			</div>

			<!-- Input area -->
			<div class="border-t border-[#2a2a2a] p-3 shrink-0">
				<div class="flex gap-2">
					<input
						type="text"
						placeholder="Send command to coordinator\u2026"
						value=${input}
						onInput=${(e) => setInput(e.target.value)}
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
				${sendError ? html`<div class="text-xs text-red-400 mt-1">${sendError}</div>` : null}
			</div>
		</div>
	`;
}

// ===== CommandView =====

const NOISE_EVENT_TYPES = new Set(["tool_start", "tool_end"]);

export function CommandView() {
	const [activityEvents, setActivityEvents] = useState([]);
	const [activityLoading, setActivityLoading] = useState(false);
	const [activityError, setActivityError] = useState("");
	const [mail, setMail] = useState([]);
	const [activeTab, setActiveTab] = useState("activity");

	// Poll event store every 5 seconds and merge with mail for the activity timeline
	useEffect(() => {
		let cancelled = false;

		async function fetchActivity() {
			setActivityLoading(true);
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
					setActivityError("");
				}
			} catch (err) {
				if (!cancelled) setActivityError(err.message || "Failed to load activity");
			} finally {
				if (!cancelled) setActivityLoading(false);
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

	// Merge events and mail into unified timeline (newest first)
	const mailEvents = mail.map((m) => ({
		id: `mail-${m.id}`,
		type: "mail",
		agent: m.from,
		summary: `${m.from} \u2192 ${m.to}: ${m.subject}`,
		detail: m.body,
		createdAt: m.createdAt,
	}));

	const unifiedTimeline = [...activityEvents, ...mailEvents].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);

	const chatState = {
		mail,
		agents: appState.agents.value,
		issues: appState.issues.value,
	};

	const tabClass = (tab) =>
		"px-3 py-2 text-sm border-b-2 -mb-px cursor-pointer bg-transparent border-t-0 border-l-0 border-r-0 " +
		(activeTab === tab
			? "border-[#E64415] text-[#e5e5e5]"
			: "border-transparent text-[#666] hover:text-[#999]");

	return html`
		<div class="flex h-full bg-[#0f0f0f] min-h-0">
			<!-- Coordinator Chat (left, ~55%) -->
			<div
				class="flex flex-col min-h-0 overflow-hidden border-r border-[#2a2a2a]"
				style="flex: 55 1 0%"
			>
				<${CoordinatorChat} mail=${mail} />
			</div>

			<!-- Right panel with tab switcher (~45%) -->
			<div class="flex flex-col min-h-0 overflow-hidden" style="flex: 45 1 0%">
				<!-- Tab bar -->
				<div class="flex border-b border-[#2a2a2a] shrink-0 px-1">
					<button class=${tabClass("activity")} onClick=${() => setActiveTab("activity")}>
						Activity
					</button>
					<button class=${tabClass("messages")} onClick=${() => setActiveTab("messages")}>
						Messages
					</button>
				</div>

				<!-- Tab content -->
				<div class="flex-1 min-h-0 overflow-hidden">
					${
						activeTab === "activity"
							? html`<${ActivityTimeline}
									events=${unifiedTimeline}
									loading=${activityLoading}
									error=${activityError}
								/>`
							: html`<${ChatView} state=${chatState} />`
					}
				</div>
			</div>
		</div>
	`;
}
