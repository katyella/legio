// Legio Web UI — Spawn Agent Dialog
// Modal dialog for spawning a new agent via POST /api/agents/spawn.
// Visibility controlled by appState.showSpawnDialog signal.

import { postJson } from "../lib/api.js";
import { html, useCallback, useEffect, useState } from "../lib/preact-setup.js";
import { appState } from "../lib/state.js";

const INPUT_CLASS =
	"w-full bg-[#1a1a1a] border border-[#2a2a2a] rounded px-2 py-1 text-sm text-[#e5e5e5] placeholder-[#666] outline-none focus:border-[#E64415]";
const LABEL_CLASS = "block text-xs text-[#888] mb-1";

const INITIAL_FORM = {
	taskId: "",
	name: "",
	capability: "builder",
	spec: "",
	files: "",
	parent: "",
};

export function SpawnDialog() {
	const visible = appState.showSpawnDialog.value;
	const [form, setForm] = useState(INITIAL_FORM);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(null);
	const [success, setSuccess] = useState(null);

	const close = useCallback(() => {
		appState.showSpawnDialog.value = false;
		setError(null);
		setSuccess(null);
		setForm(INITIAL_FORM);
	}, []);

	// Escape key closes dialog
	useEffect(() => {
		if (!visible) return;
		const onKey = (e) => {
			if (e.key === "Escape") close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [visible, close]);

	if (!visible) return null;

	const setField = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

	const handleSubmit = async (e) => {
		e.preventDefault();
		setError(null);
		setLoading(true);
		try {
			const body = {
				taskId: form.taskId,
				name: form.name,
				capability: form.capability,
			};
			if (form.spec.trim()) body.spec = form.spec.trim();
			if (form.files.trim()) body.files = form.files.trim();
			if (form.parent.trim()) body.parent = form.parent.trim();

			await postJson("/api/agents/spawn", body);
			setSuccess("Agent spawned successfully.");
			setForm(INITIAL_FORM);
			setTimeout(close, 1500);
		} catch (err) {
			setError(err.message ?? "Failed to spawn agent.");
		} finally {
			setLoading(false);
		}
	};

	// Clicking the backdrop closes the dialog
	const onBackdropClick = (e) => {
		if (e.target === e.currentTarget) close();
	};

	return html`
		<div
			class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
			onClick=${onBackdropClick}
		>
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded w-full mx-4" style="max-width:480px">
				<div class="flex items-center justify-between px-4 pt-4 pb-3 border-b border-[#2a2a2a]">
					<span class="text-sm font-medium text-[#e5e5e5]">Spawn Agent</span>
					<button
						type="button"
						class="text-[#666] hover:text-[#ccc] text-lg leading-none cursor-pointer bg-transparent border-none"
						onClick=${close}
						aria-label="Close"
					>×</button>
				</div>
				<form onSubmit=${handleSubmit} class="px-4 py-4 flex flex-col gap-3">
					<div>
						<label class=${LABEL_CLASS}>Task ID <span class="text-[#E64415]">*</span></label>
						<input
							class=${INPUT_CLASS}
							type="text"
							required
							placeholder="e.g. legio-abc1"
							value=${form.taskId}
							onInput=${setField("taskId")}
							disabled=${loading}
						/>
					</div>
					<div>
						<label class=${LABEL_CLASS}>Agent Name <span class="text-[#E64415]">*</span></label>
						<input
							class=${INPUT_CLASS}
							type="text"
							required
							placeholder="e.g. my-builder"
							value=${form.name}
							onInput=${setField("name")}
							disabled=${loading}
						/>
					</div>
					<div>
						<label class=${LABEL_CLASS}>Capability</label>
						<select
							class=${INPUT_CLASS + " appearance-none"}
							value=${form.capability}
							onChange=${setField("capability")}
							disabled=${loading}
						>
							<option value="builder">builder</option>
							<option value="scout">scout</option>
							<option value="reviewer">reviewer</option>
							<option value="lead">lead</option>
							<option value="merger">merger</option>
						</select>
					</div>
					<div>
						<label class=${LABEL_CLASS}>Spec Path</label>
						<input
							class=${INPUT_CLASS}
							type="text"
							placeholder=".legio/specs/..."
							value=${form.spec}
							onInput=${setField("spec")}
							disabled=${loading}
						/>
					</div>
					<div>
						<label class=${LABEL_CLASS}>Files</label>
						<input
							class=${INPUT_CLASS}
							type="text"
							placeholder="src/foo.ts,src/bar.ts"
							value=${form.files}
							onInput=${setField("files")}
							disabled=${loading}
						/>
					</div>
					<div>
						<label class=${LABEL_CLASS}>Parent</label>
						<input
							class=${INPUT_CLASS}
							type="text"
							placeholder="parent agent name"
							value=${form.parent}
							onInput=${setField("parent")}
							disabled=${loading}
						/>
					</div>

					${
						error
							? html`
						<div class="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded px-2 py-1">
							${error}
						</div>
					`
							: null
					}

					${
						success
							? html`
						<div class="text-xs text-green-400 bg-green-900/20 border border-green-800/40 rounded px-2 py-1">
							${success}
						</div>
					`
							: null
					}

					<div class="flex items-center justify-end gap-2 pt-1">
						<button
							type="button"
							class="bg-[#2a2a2a] hover:bg-[#333] text-[#999] text-sm px-3 py-1 rounded cursor-pointer border border-[#333]"
							onClick=${close}
							disabled=${loading}
						>Cancel</button>
						<button
							type="submit"
							class="bg-[#E64415] hover:bg-[#cc3d12] text-white text-sm px-3 py-1 rounded cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
							disabled=${loading}
						>${loading ? "Spawning..." : "Spawn Agent"}</button>
					</div>
				</form>
			</div>
		</div>
	`;
}
