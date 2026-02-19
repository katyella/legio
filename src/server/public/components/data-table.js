// Legio Web UI — DataTable component
// Reusable sortable table: column definitions, sort state, click-to-sort headers.
// No npm dependencies — uses CDN imports. Served as a static ES module.

import { h } from "https://esm.sh/preact@latest";
import { useState } from "https://esm.sh/preact@latest/hooks";
import htm from "https://esm.sh/htm@latest";

const html = htm.bind(h);

/**
 * DataTable — sortable table with configurable columns and row rendering.
 *
 * @param {object} props
 * @param {Array<{key: string, label: string, render?: function, sortable?: boolean}>} props.columns
 *   Column definitions. `render(value, row)` is called if provided; otherwise raw value is shown.
 * @param {Array<object>} props.data         - Array of row data objects
 * @param {string} [props.defaultSort]       - Key of the column to sort by initially
 * @param {function} [props.onRowClick]      - Called with row object when a row is clicked
 */
export function DataTable({ columns, data, defaultSort, onRowClick }) {
	const [sortKey, setSortKey] = useState(defaultSort || null);
	const [sortDir, setSortDir] = useState("asc");

	function handleHeaderClick(col) {
		if (!col.sortable) return;
		if (sortKey === col.key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(col.key);
			setSortDir("asc");
		}
	}

	const sortedData = [...(data || [])].sort((a, b) => {
		if (!sortKey) return 0;
		const av = a[sortKey];
		const bv = b[sortKey];
		if (av == null && bv == null) return 0;
		if (av == null) return 1;
		if (bv == null) return -1;
		const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
		return sortDir === "asc" ? cmp : -cmp;
	});

	return html`
		<div class="w-full overflow-x-auto">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="bg-[#1a1a1a] border-b border-[#2a2a2a]">
						${columns.map(
							(col) => html`
								<th
									key=${col.key}
									class=${[
										"px-3 py-2 text-left text-xs uppercase tracking-wide text-gray-500 select-none",
										col.sortable ? "cursor-pointer hover:text-[#e5e5e5]" : "",
									].join(" ")}
									onClick=${() => handleHeaderClick(col)}
								>
									<span class="flex items-center gap-1">
										${col.label}
										${col.sortable && sortKey === col.key &&
										html`<span class="text-[#E64415]">
											${sortDir === "asc" ? "↑" : "↓"}
										</span>`}
									</span>
								</th>
							`,
						)}
					</tr>
				</thead>
				<tbody>
					${sortedData.map(
						(row, i) => html`
							<tr
								key=${i}
								class=${[
									"border-b border-[#1a1a1a] transition-colors",
									onRowClick ? "cursor-pointer hover:bg-[#222]" : "hover:bg-[#222]",
								].join(" ")}
								onClick=${onRowClick ? () => onRowClick(row) : undefined}
							>
								${columns.map(
									(col) => html`
										<td key=${col.key} class="px-3 py-2 text-[#e5e5e5]">
											${col.render ? col.render(row[col.key], row) : row[col.key] ?? ""}
										</td>
									`,
								)}
							</tr>
						`,
					)}
					${sortedData.length === 0 &&
					html`
						<tr>
							<td
								colspan=${columns.length}
								class="px-3 py-6 text-center text-gray-500 text-sm"
							>
								No data
							</td>
						</tr>
					`}
				</tbody>
			</table>
		</div>
	`;
}
