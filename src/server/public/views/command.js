// Legio Web UI — CommandView component
// Two-panel mission-control interface:
//   - Left: Activity timeline (audit trail events, auto-refreshing every 5s)
//   - Right: Coordinator chat input + recent coordinator messages

import { html, useState, useEffect, useRef, useCallback } from "../lib/preact-setup.js";
import { fetchJson, postJson } from "../lib/api.js";
import { timeAgo } from "../lib/utils.js";

// Type badge Tailwind classes
const TYPE_COLORS = {
	command: "bg-blue-900/50 text-blue-400",
	response: "bg-green-900/50 text-green-400",
	state_change: "bg-yellow-900/50 text-yellow-400",
	merge: "bg-purple-900/50 text-purple-400",
	error: "bg-red-900/50 text-red-400",
	system: "bg-[#333] text-[#999]",
};

function typeBadgeClass(type) {
	return TYPE_COLORS[type] ?? TYPE_COLORS.system;
}

// ===== Activity Timeline Panel =====

function ActivityTimeline({ events, loading, error }) {
	const [typeFilter, setTypeFilter] = useState("");
	const [agentFilter, setAgentFilter] = useState("");
	const [expandedIds, setExpandedIds] = useState(new Set());

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415]";

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

	const allTypes = [...new Set(events.map((e) => e.type).filter(Boolean))].sort();

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
				${loading
					? html`<span class="text-xs text-[#555] shrink-0">Refreshing\u2026</span>`
					: null}
			</div>

			<!-- Event list -->
			<div class="flex-1 overflow-y-auto min-h-0 p-2">
				${error
					? html`<div class="text-red-400 text-sm px-2 py-3">${error}</div>`
					: null}
				${!error && filtered.length === 0
					? html`
						<div class="flex items-center justify-center h-full text-[#666] text-sm">
							No audit events recorded yet
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
								class=${"mb-1 rounded border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2" +
									(hasDetail ? " cursor-pointer hover:border-[#3a3a3a]" : "")}
								onClick=${hasDetail ? () => toggleExpand(ev.id) : undefined}
							>
								<div class="flex items-center gap-2 flex-wrap min-w-0">
									<span class=${"text-xs px-1.5 py-0.5 rounded font-mono shrink-0 " + badgeClass}>
										${ev.type || "unknown"}
									</span>
									${ev.agent
										? html`<span class="text-xs text-[#999] shrink-0">${ev.agent}</span>`
										: null}
									<span class="flex-1 text-sm text-[#e5e5e5] truncate min-w-0">
										${ev.summary || ""}
									</span>
									<span class="text-xs text-[#555] shrink-0">${timeAgo(ts)}</span>
									${hasDetail
										? html`<span class="text-xs text-[#555] shrink-0">
											${isExpanded ? "\u25B2" : "\u25BC"}
										</span>`
										: null}
								</div>
								${isExpanded && hasDetail
									? html`
										<pre class="mt-2 text-xs text-[#999] whitespace-pre-wrap break-all border-t border-[#2a2a2a] pt-2 font-mono">
											${typeof ev.detail === "string"
												? ev.detail
												: JSON.stringify(ev.detail, null, 2)}
										</pre>
									`
									: null}
							</div>
						`;
					})}
			</div>
		</div>
	`;
}

// ===== Coordinator Chat Panel =====

function CoordinatorChat({ mail }) {
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [sendError, setSendError] = useState("");
	const feedRef = useRef(null);
	const isNearBottomRef = useRef(true);

	const inputClass =
		"bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415]";

	// Filter mail to coordinator/orchestrator messages
	const coordMessages = mail
		.filter(
			(m) =>
				m.from === "orchestrator" ||
				m.to === "orchestrator" ||
				m.from === "coordinator" ||
				m.to === "coordinator",
		)
		.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

	// Scroll to bottom when messages update
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
		if (!text) return;
		setSendError("");
		setSending(true);
		try {
			await postJson("/api/terminal/send", { agent: "coordinator", text });
			// Record to audit trail; failure is non-fatal
			try {
				await postJson("/api/audit", {
					type: "command",
					source: "web_ui",
					summary: text,
					agent: "coordinator",
				});
			} catch (_e) {
				// intentionally ignored — audit record is best-effort
			}
			setInput("");
		} catch (err) {
			setSendError(err.message || "Send failed");
		} finally {
			setSending(false);
		}
	}, [input]);

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
				${coordMessages.length === 0
					? html`
						<div class="flex items-center justify-center h-full text-[#666] text-sm">
							No coordinator messages yet
						</div>
					`
					: coordMessages.map((msg) => {
						const isFromCoord =
							msg.from === "orchestrator" || msg.from === "coordinator";
						return html`
							<div key=${msg.id} class=${"flex " + (isFromCoord ? "justify-start" : "justify-end")}>
								<div
									class=${"max-w-[85%] rounded px-3 py-2 text-sm " +
										(isFromCoord
											? "bg-[#1a1a1a] text-[#e5e5e5] border border-[#2a2a2a]"
											: "bg-[#E64415]/20 text-[#e5e5e5] border border-[#E64415]/30")}
								>
									<div class="flex items-center gap-1 mb-1 flex-wrap">
										<span class="text-xs font-mono text-[#999]">${msg.from}</span>
										<span class="text-xs text-[#555]">\u2192</span>
										<span class="text-xs font-mono text-[#999]">${msg.to}</span>
										<span class="ml-auto text-xs text-[#555] shrink-0">
											${timeAgo(msg.createdAt)}
										</span>
									</div>
									${msg.subject
										? html`<div class="text-xs text-[#999] mb-1 italic">${msg.subject}</div>`
										: null}
									<div class="text-[#e5e5e5] whitespace-pre-wrap break-words text-sm">
										${msg.body || ""}
									</div>
								</div>
							</div>
						`;
					})}
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
				${sendError
					? html`<div class="text-xs text-red-400 mt-1">${sendError}</div>`
					: null}
			</div>
		</div>
	`;
}

// ===== CommandView =====

export function CommandView() {
	const [auditEvents, setAuditEvents] = useState([]);
	const [auditLoading, setAuditLoading] = useState(false);
	const [auditError, setAuditError] = useState("");
	const [mail, setMail] = useState([]);

	// Poll audit timeline every 5 seconds
	useEffect(() => {
		let cancelled = false;

		async function fetchAudit() {
			setAuditLoading(true);
			try {
				const data = await fetchJson("/api/audit/timeline");
				if (!cancelled) {
					setAuditEvents(Array.isArray(data) ? data : (data?.events ?? []));
					setAuditError("");
				}
			} catch (err) {
				if (!cancelled) setAuditError(err.message || "Failed to load audit events");
			} finally {
				if (!cancelled) setAuditLoading(false);
			}
		}

		fetchAudit();
		const interval = setInterval(fetchAudit, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	// Fetch coordinator mail (refresh every 10s)
	useEffect(() => {
		let cancelled = false;

		async function fetchMail() {
			try {
				const data = await fetchJson("/api/mail");
				if (!cancelled) {
					setMail(Array.isArray(data) ? data : (data?.recent ?? []));
				}
			} catch (_err) {
				// Non-fatal; coordinator mail panel stays empty
			}
		}

		fetchMail();
		const interval = setInterval(fetchMail, 10000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	return html`
		<div class="flex h-full bg-[#0f0f0f] min-h-0">
			<!-- Activity Timeline (left, ~55%) -->
			<div
				class="flex flex-col min-h-0 overflow-hidden border-r border-[#2a2a2a]"
				style="flex: 55 1 0%"
			>
				<div class="px-3 py-2 border-b border-[#2a2a2a] shrink-0">
					<span class="text-sm font-medium text-[#e5e5e5]">Activity Timeline</span>
				</div>
				<${ActivityTimeline}
					events=${auditEvents}
					loading=${auditLoading}
					error=${auditError}
				/>
			</div>

			<!-- Coordinator Chat (right, ~45%) -->
			<div class="flex flex-col min-h-0 overflow-hidden" style="flex: 45 1 0%">
				<${CoordinatorChat} mail=${mail} />
			</div>
		</div>
	`;
}
