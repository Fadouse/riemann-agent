/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by both tool-execution.ts and bash-execution.ts for consistent behavior.
 */

import { Text, visibleWidth, wrapTextWithAnsiIterator } from "@earendil-works/pi-tui";

export interface VisualTruncateResult {
	/** The visual lines to display */
	visualLines: string[];
	/** Number of visual lines that were skipped (hidden) */
	skippedCount: number;
}

/**
 * Truncate text to a maximum number of visual lines (from the end).
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @returns The truncated visual lines and count of skipped lines
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// Keep unusual legacy arguments on the original path (slice(-0), fractional
	// counts below one, infinities and invalid widths have observable semantics).
	if (maxVisualLines < 1 || !Number.isFinite(maxVisualLines) || width < 0 || !Number.isFinite(width)) {
		const allVisualLines = new Text(text, paddingX, 0).render(width);
		return allVisualLines.length <= maxVisualLines
			? { visualLines: allVisualLines, skippedCount: 0 }
			: { visualLines: allVisualLines.slice(-maxVisualLines), skippedCount: allVisualLines.length - maxVisualLines };
	}
	if (text.trim() === "") return { visualLines: [], skippedCount: 0 };
	const padding = Math.min(paddingX, Math.max(0, Math.floor((width - 1) / 2)));
	const margin = " ".repeat(padding);
	const contentWidth = Math.max(1, width - padding * 2);
	const keep = Math.trunc(maxVisualLines);
	const tail: string[] = [];
	let next = 0;
	let count = 0;
	// Scan every visual line, preserving cross-line ANSI state and exact counts.
	// Only the existing collapsed presentation is retained, not a padded copy
	// of the full document. The source and expanded output remain unchanged.
	for (const line of wrapTextWithAnsiIterator(text, contentWidth)) {
		count++;
		if (tail.length < keep) tail.push(line);
		else {
			tail[next] = line;
			next = (next + 1) % keep;
		}
	}
	const ordered = next === 0 ? tail : tail.slice(next).concat(tail.slice(0, next));
	const visualLines = ordered.map((line) => {
		const padded = margin + line + margin;
		return padded + " ".repeat(Math.max(0, width - visibleWidth(padded)));
	});
	return { visualLines, skippedCount: count > maxVisualLines ? count - maxVisualLines : 0 };
}
