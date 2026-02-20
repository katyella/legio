// views/terminal.js — Terminal view (consolidated into InspectView)
// The terminal capture functionality has been moved into InspectView.
// When inspecting an agent, the terminal section appears below "Recent Tool Calls".
// This stub preserves the export so app.js continues to import without errors.

import { html } from "../lib/preact-setup.js";

export function TerminalView() {
	return html`
		<div class="flex flex-col items-center justify-center h-full bg-[#0f0f0f] gap-3">
			<p class="text-[#999] text-sm">
				Terminal is now part of the Inspect view.
			</p>
			<a
				href="#inspect"
				class="text-[#E64415] text-sm font-mono hover:underline"
			>
				Go to Inspect →
			</a>
		</div>
	`;
}
