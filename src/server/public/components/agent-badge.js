// Legio Web UI — AgentBadge component
// Inline badge: agent name + state color dot + capability label.
// No npm dependencies — uses CDN imports. Served as a static ES module.

import { h } from "https://esm.sh/preact@latest";
import htm from "https://esm.sh/htm@latest";

const html = htm.bind(h);

// State dot color classes (Tailwind utility classes, Spiegel dark theme)
const STATE_COLORS = {
	working: "text-green-500",
	booting: "text-yellow-500",
	stalled: "text-red-500",
	completed: "text-gray-500",
	zombie: "text-orange-500",
};

/**
 * AgentBadge — inline badge showing agent name, state, and capability.
 *
 * @param {object} props
 * @param {string} props.name       - Agent name
 * @param {string} props.state      - Agent state: working | booting | stalled | completed | zombie
 * @param {string} props.capability - Agent capability label (e.g. "builder", "scout")
 */
export function AgentBadge({ name, state, capability }) {
	const dotColor = STATE_COLORS[state] || "text-gray-500";

	return html`
		<span class="inline-flex items-center gap-1.5">
			<span class=${`${dotColor} leading-none`}>●</span>
			<span class="font-medium text-[#e5e5e5] text-sm">${name}</span>
			${capability &&
			html`<span class="text-xs text-gray-500">${capability}</span>`}
		</span>
	`;
}
