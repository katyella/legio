// Legio Web UI — SetupView component
// Preact + HTM component for the setup wizard (shown when .legio/ is not initialized).
// No npm dependencies — uses importmap bare specifiers. Served as a static ES module.

import { html, useState, useCallback } from "../lib/preact-setup.js";
import { postJson } from "../lib/api.js";

export function SetupView({ onInitialized, projectRoot }) {
	const [status, setStatus] = useState("idle"); // idle | loading | success | error
	const [error, setError] = useState(null);

	const handleInit = useCallback(async () => {
		setStatus("loading");
		setError(null);
		try {
			const result = await postJson("/api/setup/init", {});
			if (result.success) {
				setStatus("success");
				setTimeout(() => {
					onInitialized?.();
				}, 1000);
			} else {
				setStatus("error");
				setError(result.error ?? "Unknown error");
			}
		} catch (err) {
			setStatus("error");
			setError(err.message ?? "Failed to initialize");
		}
	}, [onInitialized]);

	return html`
		<div class="flex items-center justify-center h-screen bg-[#0f0f0f]">
			<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-8 w-full max-w-md mx-4">
				<div class="flex items-center gap-3 mb-6">
					<div class="w-8 h-8 bg-[#E64415] rounded flex items-center justify-center shrink-0">
						<span class="text-white font-bold text-sm">L</span>
					</div>
					<h1 class="text-xl font-semibold text-[#e5e5e5]">Legio Setup</h1>
				</div>

				<p class="text-[#888] text-sm mb-4">
					This project has not been initialized with Legio yet. Run setup to create
					the <code class="text-[#ccc] bg-[#0f0f0f] px-1 rounded">.legio/</code> directory
					and configuration.
				</p>

				${projectRoot ? html`
					<div class="mb-6 p-3 bg-[#0f0f0f] border border-[#2a2a2a] rounded">
						<span class="text-[#555] text-xs uppercase tracking-wider font-medium">Project Root</span>
						<p class="text-[#ccc] text-xs font-mono mt-1 break-all">${projectRoot}</p>
					</div>
				` : null}

				${status === "success" ? html`
					<div class="text-green-400 text-sm py-3 text-center">
						✓ Project initialized successfully. Loading dashboard...
					</div>
				` : html`
					<button
						onClick=${handleInit}
						disabled=${status === "loading"}
						class=${"w-full py-2.5 px-4 rounded text-sm font-medium transition-colors " +
							(status === "loading"
								? "bg-[#333] text-[#666] cursor-not-allowed"
								: "bg-[#E64415] hover:bg-[#cc3a12] text-white cursor-pointer")}
					>
						${status === "loading" ? "Initializing..." : "Initialize Project"}
					</button>
				`}

				${status === "error" && error ? html`
					<div class="mt-3 p-3 bg-[#2a1010] border border-[#5a2020] rounded text-red-400 text-xs font-mono whitespace-pre-wrap break-all">
						${error}
					</div>
				` : null}
			</div>
		</div>
	`;
}
