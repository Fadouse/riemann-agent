import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { truncateToVisualLines } from "../src/modes/interactive/components/visual-truncate.ts";

function reference(text: string, count: number, width: number, padding: number) {
	if (!text) return { visualLines: [], skippedCount: 0 };
	const lines = new Text(text, padding, 0).render(width);
	return lines.length <= count
		? { visualLines: lines, skippedCount: 0 }
		: { visualLines: lines.slice(-count), skippedCount: lines.length - count };
}

describe("visual preview projection", () => {
	test("does not create an entire padded Text document for an existing collapsed preview", () => {
		const render = vi.spyOn(Text.prototype, "render");
		try {
			const result = truncateToVisualLines("line\n".repeat(10_000), 11, 80);
			expect(result.visualLines).toHaveLength(11);
			expect(result.skippedCount).toBe(9_990);
			expect(render).not.toHaveBeenCalled();
		} finally {
			render.mockRestore();
		}
	});

	test("matches complete Text rendering for styles, Unicode, wrapping, padding and legacy edge arguments", () => {
		const inputs = [
			"",
			" \t\r\n",
			"a\r\nb\rc\n",
			"你好😀 ".repeat(30),
			"\x1b[4;31ma long line that wraps\nfollowed by another line\x1b[0m",
			`\x1b]8;;https://example.com\x07${"abcdefghij".repeat(30)}\nlast\x1b]8;;\x07`,
			"\x1b[31m",
			"tail  \n\n",
		];
		for (const text of inputs)
			for (const count of [0, 0.5, 1, 1.5, 3, 11, Infinity, NaN]) {
				for (const width of [0, 1, 2, 3.5, 10, 40])
					for (const padding of [0, 0.5, 1, 1.25, 3]) {
						expect(truncateToVisualLines(text, count, width, padding)).toEqual(
							reference(text, count, width, padding),
						);
					}
			}
	});
});
