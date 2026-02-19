// Legio Web UI — CommandView component
// Unified conversational thread UI interleaving user commands, coordinator messages,
// and agent activity events in a single chronological feed.

import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useMemo, useRef, useState } from "../lib/preact-setup.js";
import { appState } from "../lib/state.js";
import { timeAgo } from "../lib/utils.js";

// ===== Helpers =====

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

/**
 * Return color tokens for a given agent capability.
 * coordinator=blue, lead=green, builder=purple, scout=orange, reviewer=teal
 */
function agentColor(capability) {
	switch (capability) {
		case "coordinator":
			return {
				bg: "bg-blue-900/30",
				border: "border-blue-800/50",
				text: "text-blue-300",
				dot: "bg-blue-400",
			};
		case "lead":
			return {
				bg: "bg-green-900/30",
				border: "border-green-800/50",
				text: "text-green-300",
				dot: "bg-green-400",
			};
		case "builder":
			return {
				bg: "bg-purple-900/30",
				border: "border-purple-800/50",
				text: "text-purple-300",
				dot: "bg-purple-400",
			};
		case "scout":
			return {
				bg: "bg-orange-900/30",
				border: "border-orange-800/50",
				text: "text-orange-300",
				dot: "bg-orange-400",
			};
		case "reviewer":
			return {
				bg: "bg-teal-900/30",
				border: "border-teal-800/50",
				text: "text-teal-300",
				dot: "bg-teal-400",
			};
		case "merger":
			return {
				bg: "bg-pink-900/30",
				border: "border-pink-800/50",
				text: "text-pink-300",
				dot: "bg-pink-400",
			};
		default:
			return {
				bg: "bg-[#1a1a1a]",
				border: "border-[#2a2a2a]",
				text: "text-[#999]",
				dot: "bg-[#555]",
			};
	}
}

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
		<div class="flex items-center gap-3 my-3">
			<div class="flex-1 border-t border-[#2a2a2a]"></div>
			<span class="text-xs text-[#555] shrink-0">${label}</span>
			<div class="flex-1 border-t border-[#2a2a2a]"></div>
		</div>
	`;
}

/** Centered compact pill for agent lifecycle events. */
function ActivityCard({ item }) {
	const colors = agentColor(item.capability);
	const raw = item.raw;
	const action = raw.subject ?? (raw.type ? raw.type.replace(/_/g, " ") : item.body);
	return html`
		<div class="flex justify-center my-1">
			<div
				class=${
					"flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs " +
					colors.bg +
					" " +
					colors.border
				}
			>
				<span class=${`w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}`}></span>
				<span class=${`font-mono ${colors.text}`}>${item.from}</span>
				<span class="text-[#666]">${action}</span>
				<span class="text-[#444] ml-1">${timeAgo(item.timestamp)}</span>
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
		<div class="border-t border-[#2a2a2a] p-3 shrink-0">
			<div class="flex gap-2 items-end">
				<textarea
					ref=${textareaRef}
					placeholder="Send a message to coordinator\u2026"
					value=${input}
					onInput=${handleInput}
					onKeyDown=${handleKeyDown}
					disabled=${sending}
					rows="1"
					class=${`flex-1 min-w-0 resize-none overflow-hidden ${inputClass}`}
					style="min-height:2rem;max-height:7.5rem"
				></textarea>
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
	`;
}

// ===== CommandView =====

export function CommandView() {
	const [auditEvents, setAuditEvents] = useState([]);
	const [mail, setMail] = useState([]);

	// Read agents signal for capability inference
	const agents = appState.agents.value;

	// Poll audit timeline every 5s
	useEffect(() => {
		let cancelled = false;
		async function fetchAudit() {
			try {
				const data = await fetchJson("/api/audit/timeline");
				if (!cancelled) {
					setAuditEvents(Array.isArray(data) ? data : (data?.events ?? []));
				}
			} catch (_err) {
				// non-fatal — feed stays stale
			}
		}
		fetchAudit();
		const interval = setInterval(fetchAudit, 5000);
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

	// Merge and sort all data sources into a single chronological feed
	const feedItems = useMemo(() => {
		const items = [];
		for (const ev of auditEvents) {
			items.push(normalizeAuditItem(ev));
		}
		for (const msg of mail) {
			items.push(normalizeMailItem(msg, agents));
		}
		items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
		return items;
	}, [auditEvents, mail, agents]);

	return html`
		<div class="flex flex-col h-full bg-[#0f0f0f] min-h-0">
			<${ConversationFeed} items=${feedItems} />
			<${ChatInput} />
		</div>
	`;
}
