// Legio Web UI — CommandView component
// Two-panel mission-control interface:
//   - Left: Coordinator chat input + recent coordinator messages (~55%)
//   - Right: Activity timeline (events + mail, auto-refreshing every 5s)

import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";
import { timeAgo } from "../lib/utils.js";

// Type badge Tailwind classes
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

// Mail types treated as activity events (compact centered cards) rather than chat bubbles
const ACTIVITY_TYPES = new Set([
	"dispatch",
	"worker_done",
	"merge_ready",
	"merged",
	"merge_failed",
	"health_check",
	"assign",
]);

function isActivityMessage(msg) {
	return ACTIVITY_TYPES.has(msg.type);
}

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

// ===== Activity Timeline Panel =====

/**
 * Infer an agent's capability from its name or from the agents list.
 * Returns null if no match found.
 */
function inferCapability(agentName, agents) {
	if (!agentName) return null;
	if (agents && agents.length > 0) {
		const found = agents.find((a) => a.name === agentName);
		if (found?.capability) return found.capability;
	}
	const lower = agentName.toLowerCase();
	if (lower === "coordinator" || lower === "orchestrator") return "coordinator";
	if (lower.includes("coordinator") || lower.includes("orchestrator")) return "coordinator";
	if (lower.includes("-lead") || lower.endsWith("lead")) return "lead";
	if (lower.includes("builder")) return "builder";
	if (lower.includes("scout")) return "scout";
	if (lower.includes("reviewer")) return "reviewer";
	if (lower.includes("merger")) return "merger";
	return null;
}

/**
 * Format a timestamp for a time divider label.
 * e.g. "Today at 14:32", "Yesterday at 09:15", "Feb 10 at 11:00"
 */
function formatTimeDivider(isoString) {
	const date = new Date(isoString);
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 86400000);
	const itemDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const time = `${hh}:${mm}`;
	if (itemDay.getTime() === today.getTime()) return `Today at ${time}`;
	if (itemDay.getTime() === yesterday.getTime()) return `Yesterday at ${time}`;
	const MONTHS = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];
	return `${MONTHS[date.getMonth()]} ${date.getDate()} at ${time}`;
}

/** Normalize an audit event into a feed item. */
function normalizeAuditItem(ev) {
	const ts = ev.createdAt ?? ev.timestamp ?? new Date(0).toISOString();
	let kind;
	if (ev.type === "command" && ev.source === "web_ui") {
		kind = "user";
	} else if (ev.type === "response") {
		kind = "coordinator";
	} else {
		kind = "activity";
	}
	return {
		id: `audit-${ev.id ?? ts}`,
		timestamp: ts,
		kind,
		from: ev.agent ?? "system",
		body: ev.summary ?? "",
		capability: kind === "coordinator" ? "coordinator" : null,
		raw: ev,
	};
}

/** Normalize a mail message into a feed item. */
function normalizeMailItem(msg, agents) {
	const isCoord = msg.from === "orchestrator" || msg.from === "coordinator";
	const isActivity = isActivityMessage(msg);
	const capability = isCoord ? "coordinator" : inferCapability(msg.from, agents);
	let kind;
	if (isActivity) {
		kind = "activity";
	} else if (isCoord) {
		kind = "coordinator";
	} else {
		kind = "agent";
	}
	return {
		id: `mail-${msg.id}`,
		timestamp: msg.createdAt ?? new Date(0).toISOString(),
		kind,
		from: msg.from ?? "",
		body: msg.body ?? "",
		capability,
		raw: msg,
	};
}

// ===== Sub-components =====

function TimeDivider({ label }) {
	return html`
		<div class="flex flex-col h-full min-h-0">
			<!-- Filter bar -->
			<div class="flex items-center gap-2 px-3 py-2 border-b border-[#2a2a2a] shrink-0 flex-wrap">
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
									<span class=${`text-xs px-1.5 py-0.5 rounded font-mono shrink-0 ${badgeClass}`}>
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
										<pre class="mt-2 text-xs text-[#999] whitespace-pre-wrap break-all border-t border-[#2a2a2a] pt-2 font-mono">
											${
												typeof ev.detail === "string"
													? ev.detail
													: JSON.stringify(ev.detail, null, 2)
											}
										</pre>
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

/** Chat bubble for user, coordinator, and agent messages. */
function ChatBubble({ item }) {
	const isUser = item.kind === "user";
	const colors = agentColor(item.capability);
	if (isUser) {
		return html`
			<div class="flex justify-end mb-2">
				<div
					class="max-w-[75%] bg-[#E64415]/20 border border-[#E64415]/30 rounded-lg px-3 py-2"
				>
					<div class="text-sm text-[#e5e5e5] whitespace-pre-wrap break-words">${item.body}</div>
					<div class="text-xs text-[#666] mt-0.5 text-right">${timeAgo(item.timestamp)}</div>
				</div>
			</div>
		`;
	}
	const raw = item.raw;
	return html`
		<div class="flex justify-start mb-2">
			<div
				class=${`max-w-[75%] border rounded-lg px-3 py-2 ${colors.bg} ${colors.border}`}
			>
				<div class="flex items-center gap-1.5 mb-1">
					<span class=${`w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}`}></span>
					<span class=${`text-xs font-mono ${colors.text}`}>${item.from}</span>
					<span class="text-xs text-[#555] ml-auto">${timeAgo(item.timestamp)}</span>
				</div>
				${
					raw.subject
						? html`<div class="text-xs text-[#777] mb-1 italic">${raw.subject}</div>`
						: null
				}
				<div class="text-sm text-[#e5e5e5] whitespace-pre-wrap break-words">${item.body}</div>
			</div>
		</div>
	`;
}

// ===== ConversationFeed =====

function ConversationFeed({ items }) {
	const feedRef = useRef(null);
	const isNearBottomRef = useRef(true);

	// Auto-scroll to bottom when near bottom and items update
	useEffect(() => {
		const feed = feedRef.current;
		if (feed && isNearBottomRef.current) {
			feed.scrollTop = feed.scrollHeight;
		}
	});

	const handleScroll = useCallback(() => {
		const feed = feedRef.current;
		if (!feed) return;
		isNearBottomRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 50;
	}, []);

	if (items.length === 0) {
		return html`
			<div
				class="flex-1 overflow-y-auto p-4 flex items-center justify-center"
				ref=${feedRef}
			>
				<span class="text-[#555] text-sm">
					No activity yet. Send a message to get started.
				</span>
			</div>
		`;
	}

	// Build rendered list with time dividers between 30+ minute gaps
	const rendered = [];
	let prevTimestamp = null;
	for (const item of items) {
		if (prevTimestamp !== null) {
			const gap = new Date(item.timestamp).getTime() - new Date(prevTimestamp).getTime();
			if (gap > 30 * 60 * 1000) {
				rendered.push(
					html`<${TimeDivider}
						key=${`div-${item.id}`}
						label=${formatTimeDivider(item.timestamp)}
					/>`,
				);
			}
		}
		prevTimestamp = item.timestamp;
		if (item.kind === "activity") {
			rendered.push(html`<${ActivityCard} key=${item.id} item=${item} />`);
		} else {
			rendered.push(html`<${ChatBubble} key=${item.id} item=${item} />`);
		}
	}

	return html`
		<div
			class="flex-1 overflow-y-auto p-4 min-h-0"
			ref=${feedRef}
			onScroll=${handleScroll}
		>
			${rendered}
		</div>
	`;
}

// ===== ChatInput =====

function ChatInput() {
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");
	const textareaRef = useRef(null);

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415]";

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || sending) return;
		setSendError("");
		setSending(true);
		try {
			await postJson("/api/terminal/send", { agent: "coordinator", text });
			// Best-effort audit record
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
			if (textareaRef.current) {
				textareaRef.current.style.height = "auto";
			}
		} catch (err) {
			setSendError(err.message || "Send failed");
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

	const handleInput = useCallback((e) => {
		setInput(e.target.value);
		const ta = e.target;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
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
					coordMessages.length === 0
						? html`
						<div class="flex items-center justify-center h-full text-[#666] text-sm">
							No coordinator messages yet
						</div>
					`
						: coordMessages.map((msg) => {
								const isFromCoord = msg.from === "orchestrator" || msg.from === "coordinator";
								return html`
							<div key=${msg.id} class=${`flex ${isFromCoord ? "justify-start" : "justify-end"}`}>
								<div
									class=${
										"max-w-[85%] rounded px-3 py-2 text-sm " +
										(isFromCoord
											? "bg-[#1a1a1a] text-[#e5e5e5] border border-[#2a2a2a]"
											: "bg-[#E64415]/20 text-[#e5e5e5] border border-[#E64415]/30")
									}
								>
									<div class="flex items-center gap-1 mb-1 flex-wrap">
										<span class="text-xs font-mono text-[#999]">${msg.from}</span>
										<span class="text-xs text-[#555]">\u2192</span>
										<span class="text-xs font-mono text-[#999]">${msg.to}</span>
										<span class="ml-auto text-xs text-[#555] shrink-0">
											${timeAgo(msg.createdAt)}
										</span>
									</div>
									${
										msg.subject
											? html`<div class="text-xs text-[#999] mb-1 italic">${msg.subject}</div>`
											: null
									}
									<div class="text-[#e5e5e5] whitespace-pre-wrap break-words text-sm">
										${msg.body || ""}
									</div>
								</div>
							</div>
						`;
							})
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
			${sendError ? html`<div class="text-xs text-red-400 mt-1">${sendError}</div>` : null}
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

	return html`
		<div class="flex h-full bg-[#0f0f0f] min-h-0">
			<!-- Coordinator Chat (left, ~55%) -->
			<div
				class="flex flex-col min-h-0 overflow-hidden border-r border-[#2a2a2a]"
				style="flex: 55 1 0%"
			>
				<${CoordinatorChat} mail=${mail} />
			</div>

			<!-- Activity Timeline (right, ~45%) -->
			<div class="flex flex-col min-h-0 overflow-hidden" style="flex: 45 1 0%">
				<div class="px-3 py-2 border-b border-[#2a2a2a] shrink-0">
					<span class="text-sm font-medium text-[#e5e5e5]">Activity Timeline</span>
				</div>
				<${ActivityTimeline}
					events=${unifiedTimeline}
					loading=${activityLoading}
					error=${activityError}
				/>
			</div>
		</div>
	`;
}
