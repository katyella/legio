// terminal-panel.js — Standalone TerminalPanel component
// Extracted from coordinator-chat.js so ChatView (and others) can use it independently.

import { html, useEffect, useRef, useState } from "../lib/preact-setup.js";

function stripAnsi(str) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape strip
	return str.replace(/\x1b\[[0-9;]*[mGKHF]/g, "");
}

function diffCapture(baselineText, currentText) {
	const baselineLines = baselineText.trimEnd().split("\n");
	const currentLines = currentText.trimEnd().split("\n");
	const anchorLen = Math.min(3, baselineLines.length);
	const anchor = baselineLines.slice(-anchorLen);

	// Search for the anchor sequence in current capture (prefer latest match)
	for (let i = currentLines.length - anchorLen; i >= 0; i--) {
		let match = true;
		for (let j = 0; j < anchorLen; j++) {
			if (currentLines[i + j] !== anchor[j]) {
				match = false;
				break;
			}
		}
		if (match) {
			return currentLines.slice(i + anchorLen).join("\n");
		}
	}
	// Baseline scrolled off — show tail
	return currentLines.slice(-20).join("\n");
}

// TerminalPanel — collapsible terminal capture sub-component
// Props:
//   chatTarget {string} — agent name to capture terminal from
//   thinking   {boolean} — when true, streams diff-based new output
export function TerminalPanel({ chatTarget, thinking }) {
	const [expanded, setExpanded] = useState(false);
	const [streamText, setStreamText] = useState("");
	const baselineCaptureRef = useRef(null);
	const terminalRef = useRef(null);

	// Reset when chatTarget changes
	useEffect(() => {
		setStreamText("");
		baselineCaptureRef.current = null;
	}, [chatTarget]);

	// Poll terminal capture when thinking OR expanded; clear when neither
	useEffect(() => {
		if (!thinking && !expanded) {
			setStreamText("");
			baselineCaptureRef.current = null;
			return;
		}

		let cancelled = false;

		async function pollCapture() {
			try {
				const res = await fetch(`/api/terminal/capture?agent=${chatTarget}&lines=80`);
				if (!res.ok || cancelled) return;
				const data = await res.json();
				const output = stripAnsi(data.output || "");

				if (thinking) {
					// Streaming mode: diff against baseline to show new output
					if (baselineCaptureRef.current === null) {
						baselineCaptureRef.current = output;
						return;
					}
					const delta = diffCapture(baselineCaptureRef.current, output);
					if (!cancelled && delta.trim()) {
						setStreamText(delta);
					}
				} else {
					// Expanded viewer mode: show full terminal capture directly
					if (!cancelled && output.trim()) {
						setStreamText(output);
					}
				}
			} catch (_err) {
				// non-fatal — capture may fail if coordinator tmux not ready
			}
		}

		pollCapture();
		const interval = setInterval(pollCapture, 1500);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [thinking, expanded, chatTarget]);

	// Auto-scroll terminal to bottom when new output arrives
	useEffect(() => {
		const el = terminalRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [streamText]);

	return html`
		<div class="border-t border-[#2a2a2a] shrink-0">
			<div
				class="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/5"
				onClick=${() => setExpanded((prev) => !prev)}
			>
				<span
					class=${
						"w-2 h-2 rounded-full flex-shrink-0 " +
						(thinking ? "bg-yellow-500 animate-pulse" : "bg-[#333]")
					}
				></span>
				<span class="text-xs text-[#666]">Terminal</span>
				${thinking ? html`<span class="text-xs text-yellow-500 animate-pulse">active</span>` : null}
				<span class="ml-auto text-xs text-[#444]">${expanded ? "\u25b2" : "\u25bc"}</span>
			</div>
			${
				expanded
					? html`
					<div ref=${terminalRef} class="max-h-[200px] overflow-y-auto px-3 pb-2">
						${
							streamText
								? html`<pre class="text-xs text-[#ccc] font-mono whitespace-pre-wrap break-words">${streamText}</pre>`
								: html`<div class="text-xs text-[#444] py-1 italic">No output yet</div>`
						}
					</div>
				`
					: null
			}
		</div>
	`;
}
