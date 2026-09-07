import { visibleWidth } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.ts";
import { toolDim, toolTarget } from "./tool-display.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

interface ChangedRange {
	start: number;
	end: number;
}

/** Preserve the word-change distinction independently of syntax foreground colors. */
function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
): {
	removed: ChangedRange[];
	added: ChangedRange[];
} {
	const removed: ChangedRange[] = [];
	const added: ChangedRange[] = [];
	let oldOffset = 0;
	let newOffset = 0;
	let firstRemoved = true;
	let firstAdded = true;
	// Keep whitespace tokens so offsets refer to each original line, even when spacing changes.
	for (const part of Diff.diffWordsWithSpace(oldContent, newContent)) {
		if (part.removed) {
			const leading = firstRemoved ? (part.value.match(/^\s*/)?.[0].length ?? 0) : 0;
			if (leading < part.value.length)
				removed.push({ start: oldOffset + leading, end: oldOffset + part.value.length });
			firstRemoved = false;
		} else if (part.added) {
			const leading = firstAdded ? (part.value.match(/^\s*/)?.[0].length ?? 0) : 0;
			if (leading < part.value.length)
				added.push({ start: newOffset + leading, end: newOffset + part.value.length });
			firstAdded = false;
		}
		if (!part.added) oldOffset += part.value.length;
		if (!part.removed) newOffset += part.value.length;
	}
	return { removed, added };
}

function highlightChanges(content: string, ranges: ChangedRange[]): string {
	let offset = 0;
	let rangeIndex = 0;
	// Count source UTF-16 offsets, not ANSI bytes or terminal columns. Syntax escapes
	// remain intact, including when one changed word spans multiple syntax tokens.
	return content.replace(/\x1b\[[0-9;]*m|[\s\S]/g, (token) => {
		if (token.startsWith("\x1b[")) return token;
		const range = ranges[rangeIndex];
		// Reverse video swaps syntax foregrounds into bright background blocks.
		// Bold + underline keeps word-level emphasis without replacing either color.
		let result = offset === range?.start ? `\x1b[1;4m${token}` : token;
		offset++;
		if (offset === range?.end) {
			result += "\x1b[22;24m";
			rangeIndex++;
		}
		return result;
	});
}

export interface RenderDiffOptions {
	/** File path used to select syntax highlighting; unknown extensions render as plain text. */
	filePath?: string;
	/** Available body columns for full-row changed-line backgrounds. */
	width?: number;
}

/** Render tinted diff rows with independent gutters, syntax colors, and word-change emphasis. */
export function renderDiff(diffText: string, options: RenderDiffOptions = {}): string {
	const language = options.filePath ? getLanguageFromPath(options.filePath) : undefined;
	const renderLine = (prefix: string, lineNum: string, source: string, changes: ChangedRange[] = []): string => {
		const color = prefix === "+" ? "toolDiffAdded" : prefix === "-" ? "toolDiffRemoved" : "toolDiffContext";
		const content = replaceTabs(source);
		const bodyColor =
			prefix === "+" ? "toolDiffAddedText" : prefix === "-" ? "toolDiffRemovedText" : "toolDiffContext";
		let body = language ? highlightCode(content, language).join("\n") : theme.fg(bodyColor, content);
		if (changes.length) body = highlightChanges(body, changes);
		if (language && prefix === "-") body = toolDim(body);
		const row = theme.fg(color, prefix) + toolDim(toolTarget(`${lineNum} `)) + body;
		const padding = " ".repeat(Math.max(0, (options.width ?? 0) - visibleWidth(row)));
		return prefix === "+"
			? theme.bg("toolDiffAddedBg", row + padding)
			: prefix === "-"
				? theme.bg("toolDiffRemovedBg", row + padding)
				: row;
	};
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const changes = renderIntraLineDiff(replaceTabs(removed.content), replaceTabs(added.content));

				result.push(renderLine("-", removed.lineNum, removed.content, changes.removed));
				result.push(renderLine("+", added.lineNum, added.content, changes.added));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(renderLine("-", removed.lineNum, removed.content));
				}
				for (const added of addedLines) {
					result.push(renderLine("+", added.lineNum, added.content));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(renderLine("+", parsed.lineNum, parsed.content));
			i++;
		} else {
			// Context line
			result.push(renderLine(" ", parsed.lineNum, parsed.content));
			i++;
		}
	}

	return result.join("\n");
}
