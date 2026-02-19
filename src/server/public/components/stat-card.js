// Legio Web UI — StatCard component
// Metric display card: label + large value + optional subtitle.
// Used on the dashboard view. No npm dependencies — uses CDN imports.

import { h } from "https://esm.sh/preact@latest";
import htm from "https://esm.sh/htm@latest";

const html = htm.bind(h);

/**
 * StatCard — displays a single metric with label, value, and optional subtitle.
 *
 * @param {object} props
 * @param {string} props.label    - Short label shown above the value (uppercase)
 * @param {string|number} props.value - The main metric value to display
 * @param {string} [props.subtitle]  - Optional supplementary text below the value
 */
export function StatCard({ label, value, subtitle }) {
	return html`
		<div class="bg-[#1a1a1a] border border-[#2a2a2a] rounded-sm p-4">
			<div class="text-xs uppercase text-gray-500 tracking-wide mb-1">${label}</div>
			<div class="text-2xl font-bold text-[#e5e5e5]">${value}</div>
			${subtitle &&
			html`<div class="text-sm text-gray-400 mt-1">${subtitle}</div>`}
		</div>
	`;
}
