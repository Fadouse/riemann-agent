import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

describe("complete large Markdown output", () => {
	for (const [source, method] of [
		["- entry", "renderList"],
		["| A |\n| - |\n| B |", "renderTable"],
	] as const) {
		it(`appends every ${method} row without a spread argument-count ceiling`, (context) => {
			const markdown = new Markdown(source, 0, 0, theme);
			const rows = Array.from({ length: 150_000 }, (_, index) => `row ${index}`);
			const internal = markdown as unknown as { renderList(): string[]; renderTable(): string[] };
			context.mock.method(internal, method, () => rows);
			const result = markdown.render(30);
			assert.equal(result.length, rows.length);
			assert.equal(result[0]?.trimEnd(), "row 0");
			assert.equal(result.at(-1)?.trimEnd(), "row 149999");
		});
	}
});
