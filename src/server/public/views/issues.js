// views/issues.js — Kanban board for beads issues
// Exports IssuesView (Preact component) and sets window.renderIssues (legacy shim)

import { IssueCard } from "../components/issue-card.js";
import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useRef, useState } from "../lib/preact-setup.js";
import { appState } from "../lib/state.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
	if (str == null) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function truncate(str, maxLen) {
	if (!str) return "";
	return str.length <= maxLen ? str : `${str.slice(0, maxLen - 3)}...`;
}

// Priority border colors (hex) for the inline-style approach used by shim
const priorityBorderHex = {
	0: "#ef4444",
	1: "#f97316",
	2: "#eab308",
	3: "#3b82f6",
	4: "#6b7280",
};

// Separate issues into the 4 kanban columns
function categorize(issues) {
	const open = [];
	const inProgress = [];
	const blocked = [];
	const closed = [];
	for (const issue of issues) {
		const status = issue.status || "";
		const hasBlockers = Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0;
		if (status === "in_progress") inProgress.push(issue);
		else if (status === "closed") closed.push(issue);
		else if (status === "blocked") blocked.push(issue);
		else if (status === "open" && hasBlockers) blocked.push(issue);
		else open.push(issue);
	}
	return { open, inProgress, blocked, closed };
}

// ── Search helper ──────────────────────────────────────────────────────────

function matchSearch(issue, query) {
	if (!query) return true;
	const q = query.toLowerCase();
	return (
		(issue.id ?? "").toLowerCase().includes(q) ||
		(issue.title ?? "").toLowerCase().includes(q) ||
		(issue.description ?? "").toLowerCase().includes(q) ||
		(issue.status ?? "").toLowerCase().includes(q) ||
		(issue.priority != null && `p${issue.priority}`.includes(q))
	);
}

// ── Preact sub-component: DispatchableCard ─────────────────────────────────

function DispatchableCard({ issue }) {
	const [dispatching, setDispatching] = useState(false);
	const [dispatched, setDispatched] = useState(false);
	const [dispatchError, setDispatchError] = useState(null);
	const [closeConfirm, setCloseConfirm] = useState(false);
	const [closing, setClosing] = useState(false);
	const [closeError, setCloseError] = useState(null);

	const isDispatchable = issue.status === "open";

	const handleDispatch = useCallback(
		async (e) => {
			e.stopPropagation();
			if (dispatching || dispatched) return;
			setDispatching(true);
			setDispatchError(null);
			try {
				await postJson(`/api/issues/${issue.id}/dispatch`, {});
				setDispatched(true);
			} catch (err) {
				setDispatchError(err.message || "Dispatch failed");
			} finally {
				setDispatching(false);
			}
		},
		[issue.id, dispatching, dispatched],
	);

	const handleClose = useCallback(
		async (e) => {
			e.stopPropagation();
			if (closing) return;
			if (!closeConfirm) {
				setCloseConfirm(true);
				return;
			}
			setClosing(true);
			setCloseError(null);
			try {
				await postJson(`/api/issues/${issue.id}/close`, {});
				appState.issues.value = appState.issues.value.map((i) =>
					i.id === issue.id ? { ...i, status: "closed" } : i,
				);
			} catch (err) {
				setCloseError(err.message || "Close failed");
				setCloseConfirm(false);
			} finally {
				setClosing(false);
			}
		},
		[issue.id, closing, closeConfirm],
	);

	return html`
		<${IssueCard} issue=${issue}>
			${
				isDispatchable
					? html`
				<div class="border-t border-[#2a2a2a] mt-2 pt-2 flex items-center gap-2">
					<button
						onClick=${handleDispatch}
						disabled=${dispatching || dispatched}
						class=${
							dispatched
								? "px-2 py-1 text-xs rounded-sm border border-green-700 text-green-400 bg-green-900/20 cursor-default"
								: dispatching
									? "px-2 py-1 text-xs rounded-sm border border-[#444] text-[#999] cursor-wait"
									: "px-2 py-1 text-xs rounded-sm border border-[#E64415] text-[#E64415] hover:bg-[#E64415]/10"
						}
					>
						${dispatched ? "✓ Dispatched" : dispatching ? "Dispatching…" : "Dispatch"}
					</button>
					<button
						onClick=${handleClose}
						disabled=${closing}
						class=${
							closing
								? "px-2 py-1 text-xs rounded-sm border border-[#444] text-[#999] cursor-wait"
								: "px-2 py-1 text-xs rounded-sm border border-[#666] text-[#999] hover:bg-[#666]/10"
						}
					>
						${closing ? "Closing…" : closeConfirm ? "Confirm?" : "Close"}
					</button>
					${dispatchError ? html`<span class="text-red-400 text-xs">${dispatchError}</span>` : null}
					${closeError ? html`<span class="text-red-400 text-xs">${closeError}</span>` : null}
				</div>
			`
					: null
			}
		<//>
	`;
}

// ── Preact sub-component: SkeletonCard ─────────────────────────────────────

function SkeletonCard() {
	return html`
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] border-l-4 rounded-sm p-3" style="border-left-color: #2a2a2a">
			<div class="flex items-start justify-between gap-2 mb-1">
				<div class="bg-[#2a2a2a] rounded h-3 w-16" style="animation: shimmer 1.5s infinite" />
				<div class="bg-[#2a2a2a] rounded h-3 w-6" style="animation: shimmer 1.5s infinite" />
			</div>
			<div class="bg-[#2a2a2a] rounded h-4 w-3/4 mb-1" style="animation: shimmer 1.5s infinite" />
			<div class="bg-[#2a2a2a] rounded h-3 w-1/2" style="animation: shimmer 1.5s infinite" />
		</div>
	`;
}

// ── Preact sub-component: SkeletonColumn ───────────────────────────────────

function SkeletonColumn({ title, borderClass, count }) {
	return html`
		<div class="flex-1 min-w-[240px] flex flex-col">
			<div class=${`border-t-2 ${borderClass} bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm px-3 py-2 mb-2 flex items-center gap-2`}>
				<span class="text-[#e5e5e5] text-sm font-medium">${title}</span>
				<span class="bg-[#2a2a2a] text-[#999] text-xs rounded-full px-2">—</span>
			</div>
			<div class="flex flex-col gap-2">
				${Array.from({ length: count }, (_, i) => html`<${SkeletonCard} key=${i} />`)}
			</div>
		</div>
	`;
}

// ── Preact sub-component: Column ───────────────────────────────────────────

function Column({ title, issues, borderClass }) {
	return html`
		<div class="flex-1 min-w-[240px] flex flex-col">
			<div class=${`border-t-2 ${borderClass} bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm px-3 py-2 mb-2 flex items-center gap-2`}>
				<span class="text-[#e5e5e5] text-sm font-medium">${title}</span>
				<span class="bg-[#2a2a2a] text-[#999] text-xs rounded-full px-2">${issues.length}</span>
			</div>
			<div class="flex flex-col gap-2">
				${
					issues.length === 0
						? html`<div class="text-[#999] text-sm text-center py-4">No issues</div>`
						: issues.map((issue) => html`<${DispatchableCard} key=${issue.id} issue=${issue} />`)
				}
			</div>
		</div>
	`;
}

// ── Preact component: IssuesView ───────────────────────────────────────────

export function IssuesView() {
	// null = show all priorities
	const [priorityFilter, setPriorityFilter] = useState(null);
	const [showClosed, setShowClosed] = useState(true);
	const [searchInput, setSearchInput] = useState("");
	const [searchText, setSearchText] = useState("");
	const debounceRef = useRef(null);

	// Read from signal (establishes subscription if auto-tracking works)
	const signalIssues = appState.issues.value;

	// Also fetch on mount as fallback
	const [fetchedIssues, setFetchedIssues] = useState(null);

	useEffect(() => {
		let cancelled = false;
		const fetchIssues = () => {
			fetchJson("/api/issues")
				.then((data) => {
					if (!cancelled) {
						setFetchedIssues(data ?? []);
						// Update signal so other consumers see the data
						appState.issues.value = data ?? [];
					}
				})
				.catch(() => {
					if (!cancelled) setFetchedIssues([]);
				});
		};
		fetchIssues();
		const interval = setInterval(fetchIssues, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	// Debounce search input
	const handleSearchChange = useCallback((e) => {
		const val = e.target.value;
		setSearchInput(val);
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			setSearchText(val);
		}, 200);
	}, []);

	// Prefer signal (non-empty) over fetched data
	const issues = signalIssues && signalIssues.length > 0 ? signalIssues : (fetchedIssues ?? []);

	// Show skeleton while waiting for first fetch
	if (fetchedIssues === null && (!signalIssues || signalIssues.length === 0)) {
		return html`
			<div class="p-4">
				<style>
					@keyframes shimmer {
						0% { opacity: 0.3; }
						50% { opacity: 0.6; }
						100% { opacity: 0.3; }
					}
				</style>
				<div class="flex gap-4 overflow-x-auto pb-4">
					<${SkeletonColumn} title="Open" borderClass="border-blue-500" count=${3} />
					<${SkeletonColumn} title="In Progress" borderClass="border-yellow-500" count=${2} />
					<${SkeletonColumn} title="Blocked" borderClass="border-red-500" count=${1} />
					<${SkeletonColumn} title="Closed" borderClass="border-green-500" count=${2} />
				</div>
			</div>
		`;
	}

	const afterSearch = searchText ? issues.filter((i) => matchSearch(i, searchText)) : issues;

	const filtered =
		priorityFilter == null ? afterSearch : afterSearch.filter((i) => i.priority === priorityFilter);

	const visibleIssues = showClosed ? filtered : filtered.filter((i) => i.status !== "closed");
	const { open, inProgress, blocked, closed } = categorize(visibleIssues);
	closed.sort(
		(a, b) => new Date(b.closed_at || b.updated_at) - new Date(a.closed_at || a.updated_at),
	);

	const filterButtons = [null, 0, 1, 2, 3, 4];

	return html`
		<div class="p-4">
			<!-- Search input -->
			<div class="mb-3">
				<input
					type="text"
					placeholder="Search issues…"
					value=${searchInput}
					onInput=${handleSearchChange}
					class="w-full max-w-sm bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm px-3 py-1.5 text-sm text-[#e5e5e5] placeholder-[#555] focus:outline-none focus:border-[#444]"
				/>
			</div>
			<!-- Priority filter bar -->
			<div class="flex items-center gap-2 mb-4">
				${filterButtons.map((p) => {
					const active = priorityFilter === p;
					const label = p == null ? "All" : `P${p}`;
					return html`
						<button
							key=${label}
							class=${
								active
									? "px-2 py-1 text-xs rounded-sm border border-[#E64415] text-[#E64415] bg-[#E64415]/10"
									: "px-2 py-1 text-xs rounded-sm border border-[#2a2a2a] text-[#999] hover:border-[#444]"
							}
							onClick=${() => setPriorityFilter(p)}
						>
							${label}
						</button>
					`;
				})}
				<div class="ml-2 pl-2 border-l border-[#2a2a2a]">
					<button
						class=${
							showClosed
								? "px-2 py-1 text-xs rounded-sm border border-green-700 text-green-400 bg-green-900/20"
								: "px-2 py-1 text-xs rounded-sm border border-[#2a2a2a] text-[#999] hover:border-[#444]"
						}
						onClick=${() => setShowClosed(!showClosed)}
					>
						${showClosed ? "Hide Closed" : "Show Closed"}
					</button>
				</div>
			</div>

			<!-- Kanban board -->
			<div class="flex gap-4 overflow-x-auto pb-4">
				<${Column} title="Open" issues=${open} borderClass="border-blue-500" />
				<${Column} title="In Progress" issues=${inProgress} borderClass="border-yellow-500" />
				<${Column} title="Blocked" issues=${blocked} borderClass="border-red-500" />
				<${Column} title="Closed" issues=${closed} borderClass="border-green-500" />
			</div>
		</div>
	`;
}

// ── Legacy global shim for the existing app.js router ─────────────────────
// Uses innerHTML to render the kanban board without requiring a Preact root.

function renderIssueCardHtml(issue) {
	const borderColor = priorityBorderHex[issue.priority] ?? "#6b7280";
	const hasBlockedBy = Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0;
	const isClosed = issue.status === "closed";
	const opacityClass = isClosed ? " opacity-50" : "";
	const idColorClass = hasBlockedBy ? "text-red-400" : "text-[#999]";
	const blockedIcon = hasBlockedBy ? `<span class="text-xs">⚠️</span> ` : "";
	const closedBadge = isClosed
		? `<span class="text-xs bg-green-900/40 text-green-400 rounded px-1 ml-1">Closed</span>`
		: "";
	const titleClass = isClosed ? "line-through" : "";
	const closeReasonHtml =
		isClosed && issue.closeReason
			? `<div class="text-[#666] text-xs mb-1 italic">${escapeHtml(truncate(issue.closeReason, 80))}</div>`
			: "";
	return `
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] border-l-4 rounded-sm p-3${opacityClass}" style="border-left-color: ${borderColor}">
			<div class="flex items-start justify-between gap-2 mb-1">
				<span class="flex items-center gap-1">
					${blockedIcon}<span class="${idColorClass} text-xs font-mono">${escapeHtml(issue.id || "")}</span>${closedBadge}
				</span>
				${issue.priority != null ? `<span class="text-[#999] text-xs">P${issue.priority}</span>` : ""}
			</div>
			<div class="text-[#e5e5e5] font-medium text-sm mb-1 ${titleClass}">${escapeHtml(truncate(issue.title || "", 60))}</div>
			${closeReasonHtml}
		${issue.description ? `<div class="text-[#999] text-xs mb-2 leading-relaxed">${escapeHtml(truncate(issue.description, 120))}</div>` : ""}
			<div class="flex items-center gap-2 flex-wrap">
				${issue.type ? `<span class="text-xs bg-[#2a2a2a] rounded px-1 text-[#999]">${escapeHtml(issue.type)}</span>` : ""}
				${issue.assignee ? `<span class="text-[#999] text-xs">${escapeHtml(issue.assignee)}</span>` : ""}
			</div>
			${hasBlockedBy ? `<div class="mt-1 text-xs text-red-500">blocked by: ${escapeHtml(issue.blockedBy.join(", "))}</div>` : ""}
		</div>`;
}

function renderColumnHtml(title, issues, borderClass) {
	const cards =
		issues.length === 0
			? `<div class="text-[#999] text-sm text-center py-4">No issues</div>`
			: issues.map(renderIssueCardHtml).join("");
	return `
		<div class="flex-1 min-w-[240px]">
			<div class="border-t-2 ${borderClass} bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm px-3 py-2 mb-2 flex items-center gap-2">
				<span class="text-[#e5e5e5] text-sm font-medium">${escapeHtml(title)}</span>
				<span class="bg-[#2a2a2a] text-[#999] text-xs rounded-full px-2">${issues.length}</span>
			</div>
			<div class="flex flex-col gap-2">${cards}</div>
		</div>`;
}

window.renderIssues = (appState, el) => {
	const issues = appState.issues || [];
	const priorityFilter = el.dataset.priorityFilter || "all";
	const showClosed = el.dataset.showClosed !== "false";

	const filtered =
		priorityFilter === "all" ? issues : issues.filter((i) => String(i.priority) === priorityFilter);

	const visibleIssues = showClosed ? filtered : filtered.filter((i) => i.status !== "closed");
	const { open, inProgress, blocked, closed } = categorize(visibleIssues);
	closed.sort(
		(a, b) => new Date(b.closed_at || b.updated_at) - new Date(a.closed_at || a.updated_at),
	);

	const filterButtons = [
		{ key: "all", label: "All" },
		{ key: "0", label: "P0" },
		{ key: "1", label: "P1" },
		{ key: "2", label: "P2" },
		{ key: "3", label: "P3" },
		{ key: "4", label: "P4" },
	];

	const filterBtnsHtml = filterButtons
		.map(({ key, label }) => {
			const active = priorityFilter === key;
			const cls = active
				? "border-[#E64415] text-[#E64415] bg-[#E64415]/10"
				: "border-[#2a2a2a] text-[#999]";
			return `<button class="px-2 py-1 text-xs rounded-sm border ${cls}" data-priority="${escapeHtml(key)}">${escapeHtml(label)}</button>`;
		})
		.join("");

	const closedToggleCls = showClosed
		? "border-green-700 text-green-400 bg-green-900/20"
		: "border-[#2a2a2a] text-[#999]";
	const closedToggleLabel = showClosed ? "Hide Closed" : "Show Closed";
	const closedToggleHtml = `<div class="ml-2 pl-2 border-l border-[#2a2a2a]"><button class="px-2 py-1 text-xs rounded-sm border ${closedToggleCls}" data-toggle-closed="true">${closedToggleLabel}</button></div>`;

	const columnsHtml = [
		renderColumnHtml("Open", open, "border-blue-500"),
		renderColumnHtml("In Progress", inProgress, "border-yellow-500"),
		renderColumnHtml("Blocked", blocked, "border-red-500"),
		renderColumnHtml("Closed", closed, "border-green-500"),
	].join("");

	el.innerHTML = `
		<div class="p-4">
			<div class="flex items-center gap-2 mb-4">${filterBtnsHtml}${closedToggleHtml}</div>
			<div class="flex gap-4 overflow-x-auto pb-4">${columnsHtml}</div>
		</div>`;

	// Wire up filter button click handlers
	el.querySelectorAll("button[data-priority]").forEach((btn) => {
		btn.addEventListener("click", () => {
			el.dataset.priorityFilter = btn.getAttribute("data-priority") || "all";
			window.renderIssues(appState, el);
		});
	});

	// Wire up show/hide closed toggle
	el.querySelectorAll("button[data-toggle-closed]").forEach((btn) => {
		btn.addEventListener("click", () => {
			el.dataset.showClosed = showClosed ? "false" : "true";
			window.renderIssues(appState, el);
		});
	});
};
