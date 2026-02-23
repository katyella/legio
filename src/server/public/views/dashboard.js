// dashboard.js — Unified Dashboard View (Preact+HTM)
// Two-panel: Left = Coordinator Chat (~58%), Right = Sidebar (MetricsStrip + AgentRoster + MergeQueue)
// Merges former CommandView and DashboardView into a single unified page.

import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useState } from "../lib/preact-setup.js";
import { appState } from "../lib/state.js";
import {
	agentColor,
	stateColor,
	stateIcon,
	timeAgo,
} from "../lib/utils.js";
import { CoordinatorChat } from "./coordinator-chat.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
