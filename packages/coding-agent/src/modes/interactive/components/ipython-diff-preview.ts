import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderDiff } from "./diff.ts";
import { toolDim } from "./tool-display.ts";

/** One visual row per logical line; keep both sides of the first change block. */
export function previewIPythonDiff(diff: string, filePath: string, width: number, budget: number): string[] {
	const source = diff.split("\n");
	const first = source.findIndex((row) => /^[+-]\s*\d/.test(row));
	const start = first < 0 ? 0 : first;
	let end = start;
	while (end < source.length && /^[+-]\s*\d/.test(source[end])) end++;
	if (first < 0) end = source.length;

	const selected = new Set<number>([start]);
	// Do not seek an opposite side past context or an omission marker.
	if (first >= 0) {
		const added = source.findIndex((row, index) => index >= start && index < end && /^\+\s*\d/.test(row));
		if (added >= 0) selected.add(added);
	}
	// Reserve a summary row for omitted source rows.
	const capacity = end === source.length && start <= 1 && source.length <= budget ? budget : budget - 1;
	if (start > 0 && selected.size < capacity) selected.add(start - 1);
	for (let index = start; index < end && selected.size < capacity; index++) selected.add(index);
	const indices = [...selected].sort((a, b) => a - b);
	const renderStart = indices[0];
	// Render the intact block before selecting, so clipped multi-line replacements
	// cannot accidentally become a synthetic one-to-one word diff.
	const rendered = renderDiff(source.slice(renderStart, end).join("\n"), { filePath, width }).split("\n");
	const rows = indices.map((index) => truncateToWidth(rendered[index - renderStart], width, "…"));
	const count = source.length - selected.size;
	if (count > 0) {
		const context = source.filter((row, index) => !selected.has(index) && /^\s+\d/.test(row)).length;
		rows.push(
			truncateToWidth(toolDim(`… ${count} omitted${context ? ` (${context} context)` : " lines"}`), width, "…"),
		);
	}
	return rows;
}
