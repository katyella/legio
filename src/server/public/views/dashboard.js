// dashboard.js — Unified Dashboard View (Preact+HTM)
// Two-panel: Left = Coordinator Chat (~58%), Right = Sidebar (MetricsStrip + AgentRoster + MailFeed)
// Merges former CommandView and DashboardView into a single unified page.

import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useState } from "../lib/preact-setup.js";
import { appState } from "../lib/state.js";
import { agentColor, stateColor, stateIcon, timeAgo } from "../lib/utils.js";
import { GatewayChat } from "./gateway-chat.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Type badge Tailwind classes for ActivityTimeline
const TYPE_COLORS = {
	session_start: "bg-green-900/50 text-green-400",
	session_end: "bg-[#333] text-[#999]",
	mail_sent: "bg-purple-900/50 text-purple-400",
	mail_received: "bg-purple-900/50 text-purple-400",
	mail: "bg-purple-900/50 text-purple-400",
	error: "bg-red-900/50 text-red-400",
	system: "bg-[#333] text-[#999]",
};

// Type badge Tailwind classes for MailFeed
const MAIL_TYPE_COLORS = {
	result: "bg-green-900/50 text-green-400",
	worker_done: "bg-green-900/50 text-green-400",
	merged: "bg-green-900/50 text-green-400",
	status: "bg-blue-900/50 text-blue-400",
	dispatch: "bg-blue-900/50 text-blue-400",
	assign: "bg-blue-900/50 text-blue-400",
	question: "bg-yellow-900/50 text-yellow-400",
	merge_ready: "bg-yellow-900/50 text-yellow-400",
	error: "bg-red-900/50 text-red-400",
	merge_failed: "bg-red-900/50 text-red-400",
	escalation: "bg-red-900/50 text-red-400",
	health_check: "bg-[#333] text-[#999]",
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

function MetricsStrip({ agents, status }) {
	const totalSessions = agents.length;
	const activeCount = agents.filter((a) => a.state === "working" || a.state === "booting").length;
	const completedCount = agents.filter((a) => a.state === "completed").length;
	const unreadMail = status?.unreadMailCount ?? 0;
	const pendingMerges = status?.mergeQueueCount ?? 0;

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
			<div class="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2">
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
// MailFeed
// ---------------------------------------------------------------------------

function MailFeed({ mail }) {
	const [activeFilters, setActiveFilters] = useState(new Set());
	const [expandedId, setExpandedId] = useState(null);

	const sorted = [...mail]
		.filter((m) => m.audience !== "human")
		.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
		.slice(0, 50);

	const filtered =
		activeFilters.size === 0 ? sorted : sorted.filter((m) => activeFilters.has(m.type));

	const toggleExpand = useCallback((id) => {
		setExpandedId((prev) => (prev === id ? null : id));
	}, []);

	const allTypes = Object.keys(MAIL_TYPE_COLORS);

	const toggleFilter = useCallback((type) => {
		setActiveFilters((prev) => {
			const next = new Set(prev);
			if (next.has(type)) {
				next.delete(type);
			} else {
				next.add(type);
			}
			return next;
		});
	}, []);

	const clearFilters = useCallback(() => {
		setActiveFilters(new Set());
	}, []);

	return html`
		<div class="bg-[#1a1a1a] border-t border-[#2a2a2a] shrink-0">
			<div class="border-b border-[#2a2a2a] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-gray-400">
				Mail Feed
			</div>
			<!-- Filter chips -->
			<div class="flex flex-wrap gap-1 px-2 py-1.5 border-b border-[#2a2a2a]">
				<button
					onClick=${clearFilters}
					class=${`px-1.5 py-0.5 rounded text-xs font-mono cursor-pointer border-none ${activeFilters.size === 0 ? "bg-white/20 text-white" : "bg-[#2a2a2a] text-[#666]"}`}
				>
					All
				</button>
				${allTypes.map(
					(type) => html`
						<button
							key=${type}
							onClick=${() => toggleFilter(type)}
							class=${`px-1.5 py-0.5 rounded text-xs font-mono cursor-pointer border-none ${activeFilters.has(type) ? (MAIL_TYPE_COLORS[type] ?? "bg-[#333] text-[#999]") : "bg-[#2a2a2a] text-[#666]"}`}
						>
							${type}
						</button>
					`,
				)}
			</div>
			<div class="overflow-y-auto max-h-[30vh] p-2 space-y-0.5">
				${
					filtered.length === 0
						? html`<div class="px-2 py-4 text-center text-gray-500 text-xs">No recent mail</div>`
						: filtered.map((m) => {
								const isExpanded = expandedId === m.id;
								let parsedPayload = null;
								if (m.payload) {
									try {
										parsedPayload =
											typeof m.payload === "string" ? JSON.parse(m.payload) : m.payload;
									} catch {
										parsedPayload = m.payload;
									}
								}
								return html`
								<div
									key=${m.id}
									class="rounded-sm ${isExpanded ? "bg-white/5 border border-[#2a2a2a]" : "border border-transparent"}"
								>
									<div
										class="flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer hover:bg-white/5 rounded-sm"
										onClick=${() => toggleExpand(m.id)}
									>
										<span
											class=${`px-1 rounded font-mono flex-shrink-0 ${MAIL_TYPE_COLORS[m.type] ?? "bg-[#333] text-[#999]"}`}
										>
											${m.type || "mail"}
										</span>
										<span class="text-[#777] flex-shrink-0 truncate max-w-[5rem]">${m.from}</span>
										<span class="text-[#444] flex-shrink-0">\u2192</span>
										<span class="text-[#777] flex-shrink-0 truncate max-w-[5rem]">${m.to}</span>
										<span class="flex-1 truncate text-[#999] min-w-0">${m.subject || ""}</span>
										<span class="text-[#444] flex-shrink-0 ml-auto">${timeAgo(m.createdAt)}</span>
										<span class="text-[#444] flex-shrink-0 ml-1">${isExpanded ? "\u25B2" : "\u25BC"}</span>
									</div>
									${
										isExpanded
											? html`
										<div class="px-2 pb-2 text-xs border-t border-[#2a2a2a] mt-0.5 pt-1.5 space-y-1">
											${
												m.priority && m.priority !== "normal"
													? html`
												<div class="flex gap-1.5">
													<span class="text-[#555] flex-shrink-0">priority:</span>
													<span class="text-yellow-400 font-mono">${m.priority}</span>
												</div>
											`
													: null
											}
											${
												m.body
													? html`
												<div>
													<div class="text-[#555] mb-0.5">body:</div>
													<div class="text-[#aaa] whitespace-pre-wrap break-words font-mono bg-[#111] rounded px-2 py-1 max-h-[10rem] overflow-y-auto">
														${m.body}
													</div>
												</div>
											`
													: null
											}
											${
												parsedPayload
													? html`
												<div>
													<div class="text-[#555] mb-0.5">payload:</div>
													<div class="text-[#aaa] whitespace-pre-wrap break-words font-mono bg-[#111] rounded px-2 py-1 max-h-[10rem] overflow-y-auto">
														${JSON.stringify(parsedPayload, null, 2)}
													</div>
												</div>
											`
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
// AgentRoster
// ---------------------------------------------------------------------------

const STATE_ORDER = { working: 0, booting: 1, stalled: 2, zombie: 3, completed: 4 };

/**
 * Build a depth-annotated ordered list from a flat agents array.
 * Agents whose parentAgent is absent or not in the list are roots (depth 0).
 * Children are placed immediately after their parent, sorted by state.
 */
function buildAgentHierarchy(agents) {
	const agentNames = new Set(agents.map((a) => a.agentName));
	const byParent = new Map();
	const roots = [];

	for (const agent of agents) {
		const parent = agent.parentAgent;
		if (!parent || !agentNames.has(parent)) {
			roots.push(agent);
		} else {
			if (!byParent.has(parent)) byParent.set(parent, []);
			byParent.get(parent).push(agent);
		}
	}

	function sortByState(arr) {
		return [...arr].sort((a, b) => {
			const ao = STATE_ORDER[a.state] ?? 99;
			const bo = STATE_ORDER[b.state] ?? 99;
			if (ao !== bo) return ao - bo;
			return (a.agentName ?? "").localeCompare(b.agentName ?? "");
		});
	}

	const result = [];
	function walk(agent, depth) {
		result.push({ agent, depth });
		const children = sortByState(byParent.get(agent.agentName) ?? []);
		for (const child of children) {
			walk(child, depth + 1);
		}
	}
	for (const root of sortByState(roots)) {
		walk(root, 0);
	}
	return result;
}

function AgentRoster({ agents, mail, events }) {
	const [expandedAgent, setExpandedAgent] = useState(null);

	const ordered = buildAgentHierarchy(agents);

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
					ordered.length === 0
						? html`
						<div class="flex items-center justify-center h-full text-[#666] text-sm">
							No agents yet
						</div>
					`
						: ordered.map(({ agent, depth }) => {
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
									style=${{ marginLeft: `${Math.min(depth * 12, 36)}px` }}
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
										<a
											href=${`#inspect/${agent.agentName}`}
											class="text-xs text-blue-400 hover:text-blue-300 flex-shrink-0 px-1.5 py-0.5 rounded bg-blue-900/20 hover:bg-blue-900/40 no-underline"
											onClick=${(e) => e.stopPropagation()}
										>
											Details
										</a>
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
														href=${`#inspect/${agent.agentName}`}
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
		} catch (_err) {
			/* non-fatal */
		}
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
		setGwLoading(true);
		setError(null);
		try {
			await postJson("/api/gateway/start", {});
			await poll(false);
		} catch (err) {
			setError(err?.message ?? "Failed to start gateway");
		} finally {
			setGwLoading(false);
		}
	}, [poll]);

	const handleGwStop = useCallback(async () => {
		setGwLoading(true);
		setError(null);
		try {
			await postJson("/api/gateway/stop", {});
			await poll(false);
		} catch (err) {
			setError(err?.message ?? "Failed to stop gateway");
		} finally {
			setGwLoading(false);
		}
	}, [poll]);

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
		<div class="bg-[#1a1a1a] border-b border-[#2a2a2a] shrink-0 px-3 py-2">
			<div class="flex flex-wrap gap-x-4 gap-y-1.5 items-center">
				<!-- Coordinator group -->
				<div class="flex items-center gap-2">
					<span class="text-xs text-[#666] uppercase tracking-wide whitespace-nowrap">Coordinator</span>
					<div class="w-2 h-2 rounded-full shrink-0 ${dotColor}"></div>
					<span class="text-sm text-[#e5e5e5]">${statusText}</span>
					<button
						onClick=${handleStart}
						disabled=${loading || isRunning}
						class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-xs px-2 py-0.5 rounded cursor-pointer border-none"
					>
						${loading && !isRunning ? "\u2026" : "Start"}
					</button>
					<button
						onClick=${handleStop}
						disabled=${loading || isStopped || isUnknown}
						class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-xs px-2 py-0.5 rounded cursor-pointer border-none"
					>
						${loading && isRunning ? "\u2026" : "Stop"}
					</button>
				</div>
				<!-- Gateway group -->
				<div class="flex items-center gap-2">
					<span class="text-xs text-[#666] uppercase tracking-wide whitespace-nowrap">Gateway</span>
					<div class="w-2 h-2 rounded-full shrink-0 ${gwDotColor}"></div>
					<span class="text-sm text-[#e5e5e5]">${gwStatusText}</span>
					<button
						onClick=${handleGwStart}
						disabled=${gwLoading || gwIsRunning}
						class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-xs px-2 py-0.5 rounded cursor-pointer border-none"
					>
						${gwLoading && !gwIsRunning ? "\u2026" : "Start"}
					</button>
					<button
						onClick=${handleGwStop}
						disabled=${gwLoading || gwIsStopped || gwIsUnknown}
						class="bg-[#E64415] hover:bg-[#cc3d12] disabled:opacity-50 text-white text-xs px-2 py-0.5 rounded cursor-pointer border-none"
					>
						${gwLoading && gwIsRunning ? "\u2026" : "Stop"}
					</button>
				</div>
			</div>
			${error ? html`<div class="text-xs text-red-400 mt-1">${error}</div>` : null}
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
	const [_coordRunning, setCoordRunning] = useState(false);
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

	const [mobileTab, setMobileTab] = useState("chat");
	const agents = appState.agents.value;
	const status = appState.status.value;

	return html`
		<div class="flex flex-col h-full bg-[#0f0f0f] min-h-0">
			<${CoordinatorBar} />
			<!-- Mobile tab bar (hidden on md+) -->
			<div class="flex border-b border-[#2a2a2a] bg-[#1a1a1a] shrink-0 md:hidden">
				<button
					onClick=${() => setMobileTab("chat")}
					class=${
						"flex-1 py-2 text-sm font-medium border-b-2 " +
						(mobileTab === "chat"
							? "text-white border-[#E64415]"
							: "text-[#888] border-transparent")
					}
				>
					Chat
				</button>
				<button
					onClick=${() => setMobileTab("status")}
					class=${
						"flex-1 py-2 text-sm font-medium border-b-2 " +
						(mobileTab === "status"
							? "text-white border-[#E64415]"
							: "text-[#888] border-transparent")
					}
				>
					Status
				</button>
			</div>
			<div class="flex flex-col md:flex-row flex-1 min-h-0">
				<!-- Chat panel: full height on mobile (when chat tab active), left ~58% on md+ -->
				<div
					class=${
						"flex-col min-h-0 overflow-hidden md:border-r border-[#2a2a2a] md:flex-[58_1_0%] flex-1 " +
						(mobileTab === "chat" ? "flex" : "hidden md:flex")
					}
				>
					<${GatewayChat} gwRunning=${gwRunning} />
				</div>

				<!-- Sidebar: MetricsStrip + AgentRoster + MailFeed — right ~42% on md+ -->
				<div
					class=${
						"flex-col min-h-0 overflow-hidden md:flex-[42_1_0%] flex-1 " +
						(mobileTab === "status" ? "flex" : "hidden md:flex")
					}
				>
					<${MetricsStrip} agents=${agents} status=${status} />
					<${AgentRoster} agents=${agents} mail=${mail} events=${activityEvents} />
					<${MailFeed} mail=${mail} />
				</div>
			</div>
		</div>
	`;
}
