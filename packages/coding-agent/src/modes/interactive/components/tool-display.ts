import { truncateToWidth, wrapTextWithAnsiIterator } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { type Theme, theme } from "../theme/theme.ts";

export const TOOL_BODY_COLUMNS = 5;
export const TOOL_PREVIEW_ROWS = 5;
const FINAL_NEWLINE = /\r?\n((?:\x1b\[[0-9;]*m)*)$/;

export function toolAction(text: string, colors: Theme = theme): string {
	return colors.bold(colors.fg("text", text));
}

export function toolTarget(text: string, colors: Theme = theme): string {
	return colors.fg("text", text);
}

export function toolPath(text: string, colors: Theme = theme): string {
	return colors.fg("muted", text);
}

/** Bounded visual-row preview; only preview-edge blank rows are discarded. */
export function previewToolOutput(text: string, width: number, headOnly = false): string[] {
	const head: string[] = [];
	const tail: string[] = [];
	let count = 0;
	let pendingBlanks = 0;
	let next = 0;
	const retain = (line: string) => {
		count++;
		if (head.length < TOOL_PREVIEW_ROWS) head.push(line);
		if (tail.length < 2) tail.push(line);
		else {
			tail[next] = line;
			next = (next + 1) % 2;
		}
	};
	for (const line of wrapTextWithAnsiIterator(text, Math.max(1, width - TOOL_BODY_COLUMNS))) {
		if (!stripAnsi(line).trim()) {
			if (count > 0) pendingBlanks++;
			continue;
		}
		while (pendingBlanks > 0) {
			retain("");
			pendingBlanks--;
		}
		retain(line);
	}
	if (count <= TOOL_PREVIEW_ROWS) return head;
	const omitted = theme.fg("dim", `… ${count - TOOL_PREVIEW_ROWS + 1} more lines`);
	if (headOnly) return [...head.slice(0, TOOL_PREVIEW_ROWS - 1), omitted];
	const orderedTail = next === 0 ? tail : tail.slice(next).concat(tail.slice(0, next));
	return [...head.slice(0, 2), omitted, ...orderedTail];
}

/** Render from explicit content rows, never infer gutters from existing whitespace. */
export function appendToolResult(lines: string[], rows: Iterable<string>, width: number): void {
	let first = true;
	for (const row of rows) {
		const prefix = first ? `   ${theme.fg("dim", "└ ")}` : "     ";
		lines.push(truncateToWidth(`${prefix}${row}\x1b[0m`, width, ""));
		first = false;
	}
}

export function appendToolOutput(
	lines: string[],
	text: string,
	width: number,
	expanded = false,
	headOnly = false,
): void {
	if (!stripAnsi(text).trim()) return;
	const rows = expanded
		? wrapTextWithAnsiIterator(text.replace(FINAL_NEWLINE, "$1"), Math.max(1, width - TOOL_BODY_COLUMNS))
		: previewToolOutput(text, width, headOnly);
	appendToolResult(lines, rows, width);
}

/** Code continuations are distinct from return values, but share the same content column. */
export function appendToolCode(lines: string[], code: string, width: number): void {
	for (const row of wrapTextWithAnsiIterator(
		code.replace(FINAL_NEWLINE, "$1"),
		Math.max(1, width - TOOL_BODY_COLUMNS),
	)) {
		lines.push(truncateToWidth(`   ${theme.fg("dim", "│ ")}${row}\x1b[0m`, width, ""));
	}
}
