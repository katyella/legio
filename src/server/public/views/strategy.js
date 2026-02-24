// views/strategy.js — Planning workspace (replaces StrategyView)
// Two-panel layout: Gateway chat on the left, Ideas sidebar on the right.
// Export name is PlanningView; file stays at views/strategy.js to minimise import churn.

import { GatewayChat } from "../components/gateway-chat.js";
import { fetchJson, postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useState } from "../lib/preact-setup.js";

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
	const styles = {
		active: "bg-blue-500/20 text-blue-400",
		dispatched: "bg-green-500/20 text-green-400",
		backlog: "bg-orange-500/20 text-orange-400",
	};
	return html`<span class=${"text-xs px-1.5 py-0.5 rounded " + (styles[status] || "bg-[#2a2a2a] text-[#999]")}>
		${status}
	</span>`;
}

// ── Idea card ─────────────────────────────────────────────────────────────────

function IdeaCard({ idea, editingId, onEdit, onSaveEdit, onCancelEdit, onDispatch, onBacklog, onDelete }) {
	const [editTitle, setEditTitle] = useState(idea.title);
	const [editBody, setEditBody] = useState(idea.body ?? "");
	const isEditing = editingId === idea.id;

	// Reset local edit state when entering edit mode for this card
	useEffect(() => {
		if (isEditing) {
			setEditTitle(idea.title);
			setEditBody(idea.body ?? "");
		}
	}, [isEditing, idea.title, idea.body]);

	if (isEditing) {
		return html`
			<div class="px-3 py-2 border-b border-[#2a2a2a]">
				<input
					class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] outline-none focus:border-[#E64415] mb-1"
					value=${editTitle}
					onInput=${(e) => setEditTitle(e.target.value)}
					placeholder="Title"
				/>
				<textarea
					class="w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-[#e5e5e5] outline-none focus:border-[#E64415] resize-none"
					rows="3"
					value=${editBody}
					onInput=${(e) => setEditBody(e.target.value)}
					placeholder="Body (optional)"
				/>
				<div class="flex gap-2 mt-1">
					<button
						class="bg-[#E64415] text-white text-xs px-2 py-1 rounded border-none cursor-pointer"
						onClick=${() => onSaveEdit(idea.id, editTitle, editBody)}
					>Save</button>
					<button
						class="text-xs text-[#999] border border-[#2a2a2a] rounded px-2 py-1 cursor-pointer bg-transparent"
						onClick=${onCancelEdit}
					>Cancel</button>
				</div>
			</div>
		`;
	}

	return html`
		<div class="px-3 py-2 border-b border-[#2a2a2a]">
			<div class="flex items-start justify-between gap-1 mb-0.5">
				<span class="font-medium text-sm text-[#e5e5e5] leading-snug">${idea.title}</span>
				<${StatusBadge} status=${idea.status} />
			</div>
			${idea.body && html`<p class="text-xs text-[#999] line-clamp-2 mb-1">${idea.body}</p>`}
			${
				idea.status === "active" &&
				html`
				<div class="flex gap-2 mt-1 flex-wrap">
					<button
						class="text-xs text-[#999] hover:text-[#e5e5e5] bg-transparent border-none cursor-pointer p-0"
						onClick=${() => onDispatch(idea.id)}
					>Dispatch</button>
					<button
						class="text-xs text-[#999] hover:text-[#e5e5e5] bg-transparent border-none cursor-pointer p-0"
						onClick=${() => onBacklog(idea.id)}
					>Backlog</button>
					<button
						class="text-xs text-[#999] hover:text-[#e5e5e5] bg-transparent border-none cursor-pointer p-0"
						onClick=${() => onEdit(idea.id)}
					>Edit</button>
					<button
						class="text-xs text-[#999] hover:text-[#e5e5e5] bg-transparent border-none cursor-pointer p-0"
						onClick=${() => onDelete(idea.id)}
					>Delete</button>
				</div>
			`
			}
		</div>
	`;
}

// ── PlanningView ──────────────────────────────────────────────────────────────

export function PlanningView() {
	const [ideas, setIdeas] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);
	const [editingId, setEditingId] = useState(null);
	const [newTitle, setNewTitle] = useState("");
	const [newBody, setNewBody] = useState("");
	const [showNewForm, setShowNewForm] = useState(false);

	const fetchIdeas = useCallback(async () => {
		try {
			const data = await fetchJson("/api/ideas");
			setIdeas(Array.isArray(data) ? data : []);
			setError(null);
		} catch (e) {
			setError(e.message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchIdeas();
	}, [fetchIdeas]);

	const handleCreate = useCallback(async () => {
		const title = newTitle.trim();
		if (!title) return;
		try {
			await postJson("/api/ideas", { title, body: newBody.trim() });
			setNewTitle("");
			setNewBody("");
			setShowNewForm(false);
			await fetchIdeas();
		} catch (e) {
			setError(e.message);
		}
	}, [newTitle, newBody, fetchIdeas]);

	const handleSaveEdit = useCallback(
		async (id, title, body) => {
			try {
				await fetch(`/api/ideas/${id}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: title.trim(), body: body.trim() }),
				});
				setEditingId(null);
				await fetchIdeas();
			} catch (e) {
				setError(e.message);
			}
		},
		[fetchIdeas],
	);

	const handleDispatch = useCallback(
		async (id) => {
			try {
				await fetch(`/api/ideas/${id}/dispatch`, { method: "POST" });
				await fetchIdeas();
			} catch (e) {
				setError(e.message);
			}
		},
		[fetchIdeas],
	);

	const handleBacklog = useCallback(
		async (id) => {
			try {
				await fetch(`/api/ideas/${id}/backlog`, { method: "POST" });
				await fetchIdeas();
			} catch (e) {
				setError(e.message);
			}
		},
		[fetchIdeas],
	);

	const handleDelete = useCallback(
		async (id) => {
			try {
				await fetch(`/api/ideas/${id}`, { method: "DELETE" });
				await fetchIdeas();
			} catch (e) {
				setError(e.message);
			}
		},
		[fetchIdeas],
	);

	return html`
		<div class="flex h-full">

			<!-- Left panel: Gateway chat (~60%) -->
			<div class="flex-[3] min-w-0">
				<${GatewayChat} />
			</div>

			<!-- Right panel: Ideas sidebar -->
			<div class="w-80 border-l border-[#2a2a2a] flex flex-col bg-[#0f0f0f]">

				<!-- Ideas header -->
				<div class="flex items-center justify-between px-3 py-2 border-b border-[#2a2a2a] shrink-0">
					<span class="text-sm font-semibold text-[#e5e5e5]">Ideas</span>
					<button
						class="text-xs border border-[#2a2a2a] rounded px-2 py-0.5 text-[#999] hover:text-[#e5e5e5] hover:border-[#444] cursor-pointer bg-transparent"
						onClick=${() => setShowNewForm((v) => !v)}
					>+</button>
				</div>

				<!-- New idea form -->
				${
					showNewForm &&
					html`
					<div class="px-3 py-2 border-b border-[#2a2a2a] shrink-0 bg-[#1a1a1a]">
						<input
							class="w-full bg-[#0f0f0f] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] outline-none focus:border-[#E64415] mb-1"
							placeholder="Title (required)"
							value=${newTitle}
							onInput=${(e) => setNewTitle(e.target.value)}
						/>
						<textarea
							class="w-full bg-[#0f0f0f] border border-[#2a2a2a] rounded px-2 py-1 text-xs text-[#e5e5e5] outline-none focus:border-[#E64415] resize-none"
							rows="3"
							placeholder="Body (optional)"
							value=${newBody}
							onInput=${(e) => setNewBody(e.target.value)}
						/>
						<div class="flex gap-2 mt-1">
							<button
								class="bg-[#E64415] text-white text-xs px-2 py-1 rounded border-none cursor-pointer disabled:opacity-50"
								onClick=${handleCreate}
								disabled=${!newTitle.trim()}
							>Save</button>
							<button
								class="text-xs text-[#999] border border-[#2a2a2a] rounded px-2 py-1 cursor-pointer bg-transparent"
								onClick=${() => { setShowNewForm(false); setNewTitle(""); setNewBody(""); }}
							>Cancel</button>
						</div>
					</div>
				`
				}

				${error && html`<div class="px-3 py-2 text-xs text-red-400">${error}</div>`}

				<!-- Ideas list -->
				<div class="flex-1 overflow-y-auto">
					${loading && html`<div class="px-3 py-4 text-xs text-[#555]">Loading...</div>`}
					${
						!loading && ideas.length === 0 &&
						html`<div class="px-3 py-8 text-xs text-[#555] text-center">No ideas yet. Click + to add one.</div>`
					}
					${ideas.map(
						(idea) => html`
						<${IdeaCard}
							key=${idea.id}
							idea=${idea}
							editingId=${editingId}
							onEdit=${setEditingId}
							onSaveEdit=${handleSaveEdit}
							onCancelEdit=${() => setEditingId(null)}
							onDispatch=${handleDispatch}
							onBacklog=${handleBacklog}
							onDelete=${handleDelete}
						/>
					`,
					)}
				</div>
			</div>
		</div>
	`;
}
