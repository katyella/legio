// terminal-panel.js — Standalone TerminalPanel component
// Extracted from coordinator-chat.js so ChatView (and others) can use it independently.

import { html, useEffect, useRef, useState } from "../lib/preact-setup.js";

function stripAnsi(str) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape strip
	return str.replace(/\x1b\[[?0-9;]*[a-zA-Z]/g, "");
}

const ACTIVITY_LEVEL = { idle: 0, stale: 1, active: 2 };

function higherActivity(a, b) {
	return (ACTIVITY_LEVEL[a] ?? 0) >= (ACTIVITY_LEVEL[b] ?? 0) ? a : b;
}

// TerminalPanel — collapsible terminal capture sub-component
// Props:
//   chatTarget {string} — agent name to capture terminal from
//   activity   {string} — 'idle'|'active'|'stale' hint from parent (e.g. gateway just sent a message)
export function TerminalPanel({ chatTarget, activity = "idle" }) {
	const [userExpanded, setUserExpanded] = useState(false);
	const [captureText, setCaptureText] = useState("");
	const [captureActivity, setCaptureActivity] = useState("idle");
	const lastChangeTimeRef = useRef(Date.now());
	const lastHashRef = useRef("");
	const terminalRef = useRef(null);

	// Reset when chatTarget changes
	useEffect(() => {
		setCaptureText("");
		setCaptureActivity("idle");
		lastChangeTimeRef.current = Date.now();
		lastHashRef.current = "";
	}, [chatTarget]);

	// Always poll to drive the activity state machine via hash-based change detection
	useEffect(() => {
		let cancelled = false;

		async function pollCapture() {
			try {
				const res = await fetch(`/api/terminal/capture?agent=${chatTarget}&lines=80`);
				if (!res.ok || cancelled) return;
				const data = await res.json();
				const output = stripAnsi(data.output || "");
				if (cancelled) return;

				const now = Date.now();
				if (output !== lastHashRef.current) {
					// Capture changed — transition to active
					lastHashRef.current = output;
					lastChangeTimeRef.current = now;
					setCaptureActivity("active");
				} else {
					// No change — decay based on elapsed time since last change
					const elapsed = now - lastChangeTimeRef.current;
					if (elapsed >= 30000) {
						setCaptureActivity("idle");
					} else if (elapsed >= 5000) {
						setCaptureActivity("stale");
					}
				}

				if (output.trim()) {
					setCaptureText(output);
				}
			} catch (_err) {
				// non-fatal — capture may fail if agent tmux session not ready
			}
		}

		pollCapture();
		const interval = setInterval(pollCapture, 2000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [chatTarget]);

	// Auto-scroll terminal to bottom when new output arrives
	useEffect(() => {
		const el = terminalRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [captureText]);

	// Effective activity: max of parent hint and internal capture-driven state
	const effectiveActivity = higherActivity(activity, captureActivity);

	const dotClass =
		"w-2 h-2 rounded-full flex-shrink-0 " +
		(effectiveActivity === "active"
			? "bg-yellow-500 animate-pulse"
			: effectiveActivity === "stale"
				? "bg-yellow-500/50"
				: "bg-[#333]");

	return html`
		<div class="border-t border-[#2a2a2a] shrink-0">
			<div
				class="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/5"
				onClick=${() => setUserExpanded((prev) => !prev)}
			>
				<span class=${dotClass}></span>
				<span class="text-xs text-[#666]">Terminal</span>
				${effectiveActivity === "active" ? html`<span class="text-xs text-yellow-500 animate-pulse">active</span>` : null}
				${effectiveActivity === "stale" ? html`<span class="text-xs text-yellow-500/50">stale</span>` : null}
				<span class="ml-auto text-xs text-[#444]">${userExpanded ? "\u25b2" : "\u25bc"}</span>
			</div>
			${
				userExpanded
					? html`
					<div ref=${terminalRef} class="max-h-[200px] overflow-y-auto px-3 pb-2">
						${
							captureText
								? html`<pre class="text-xs text-[#ccc] font-mono whitespace-pre-wrap break-words">${captureText}</pre>`
								: html`<div class="text-xs text-[#444] py-1 italic">No output yet</div>`
						}
					</div>
				`
					: null
			}
		</div>
	`;
}
