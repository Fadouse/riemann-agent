import { truncateToWidth, wrapTextWithAnsiIterator } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { type Theme, theme } from "../theme/theme.ts";

export const TOOL_BODY_COLUMNS = 5;
export const TOOL_PREVIEW_ROWS = 5;
const FINAL_NEWLINE = /\r?\n((?:\x1b\[[0-9;]*m)*)$/;

export function toolAction(text: string, colors: Theme = theme): string {
	return colors.bold(colors.fg("toolTitle", text.charAt(0).toUpperCase() + text.slice(1)));
}

/** File paths and prose stay in the terminal foreground, independent of syntax colors. */
export function toolTarget(text: string): string {
	return `\x1b[39m${text}\x1b[39m`;
}

export function toolPath(text: string): string {
	return toolTarget(text);
}

export function toolEntity(text: string, colors: Theme = theme): string {
	return colors.fg("toolEntity", text);
}

export function toolAgentName(text: string, colors: Theme = theme): string {
	return colors.bold(toolEntity(text, colors));
}

/** Former faint regions use theme gray; explicit syntax and log colors remain intact. */
export function toolDim(text: string, colors: Theme = theme): string {
	const gray = colors.getFgAnsi("muted");
	const content = text.replace(/\x1b\[([\d;:]*)m/g, (sequence: string, parameters: string) => {
		const codes = parameters.split(";");
		let resetForeground = false;
		for (let index = 0; index < codes.length; index++) {
			const code = Number(codes[index]!.split(":")[0]);
			if (code === 0 || code === 39) resetForeground = true;
			if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) resetForeground = false;
			// Extended-color channels are values, not foreground reset commands.
			if (code === 38 || code === 48 || code === 58) {
				if (codes[index + 1] === "2") index += 4;
				else if (codes[index + 1] === "5") index += 2;
			}
		}
		return resetForeground ? `${sequence}${gray}` : sequence;
	});
	return colors.fg("muted", content);
}

export function toolOutput(text: string, colors: Theme = theme): string {
	return toolDim(colors.fg("toolOutput", text), colors);
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
	const omitted = toolDim(`… ${count - TOOL_PREVIEW_ROWS + 1} more lines`);
	if (headOnly) return [...head.slice(0, TOOL_PREVIEW_ROWS - 1), omitted];
	const orderedTail = next === 0 ? tail : tail.slice(next).concat(tail.slice(0, next));
	return [...head.slice(0, 2), omitted, ...orderedTail];
}

/** Render from explicit content rows, never infer gutters from existing whitespace. */
export function appendToolResult(lines: string[], rows: Iterable<string>, width: number): void {
	const iterator = rows[Symbol.iterator]();
	let row = iterator.next();
	while (!row.done) {
		const next = iterator.next();
		const connector = next.done ? "└ " : "│ ";
		const prefix = `   ${toolDim(toolTarget(connector))}`;
		lines.push(truncateToWidth(`${prefix}${row.value}\x1b[0m`, width, ""));
		row = next;
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

/** Code and output share a content column; collapsed commands use the same five-row budget. */
export function appendToolCode(lines: string[], code: string, width: number, expanded = true): void {
	const source = code.replace(FINAL_NEWLINE, "$1");
	const rows = expanded
		? wrapTextWithAnsiIterator(source, Math.max(1, width - TOOL_BODY_COLUMNS))
		: previewToolOutput(source, width, true);
	for (const row of rows) {
		lines.push(truncateToWidth(`   ${toolDim(toolTarget("│ "))}${row}\x1b[0m`, width, ""));
	}
}
