import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Tokenizer } from "marked";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

describe("Markdown source and layout caches", () => {
	it("reuses parsed tokens when only width changes", (context) => {
		const paragraph = context.mock.method(Tokenizer.prototype, "paragraph");
		const component = new Markdown("A **paragraph** with words that wrap across rows.", 1, 0, defaultMarkdownTheme);
		component.render(80);
		const calls = paragraph.mock.callCount();
		assert.ok(calls > 0);
		component.render(30);
		component.render(80);
		assert.equal(paragraph.mock.callCount(), calls);
	});

	it("reuses width-independent styled tokens and code highlighting across widths", () => {
		let highlights = 0;
		let headings = 0;
		const theme = {
			...defaultMarkdownTheme,
			heading: (text: string) => {
				headings++;
				return defaultMarkdownTheme.heading(text);
			},
			highlightCode: (code: string) => {
				highlights++;
				return code.split("\n");
			},
		};
		const source = "# Heading\n\n```ts\nconst longVariable = 123456789;\n```";
		const component = new Markdown(source, 1, 0, theme);
		component.render(80);
		const headingCalls = headings;
		const narrow = component.render(20);
		assert.equal(highlights, 1);
		assert.equal(headings, headingCalls);
		assert.deepEqual(narrow, new Markdown(source, 1, 0, theme).render(20));
	});

	it("preserves opaque image rows when reusing highlighted blocks across widths", () => {
		const image = "\x1b_Ga=T,f=100;AAAA\x1b\\";
		let highlights = 0;
		const theme = {
			...defaultMarkdownTheme,
			highlightCode: () => {
				highlights++;
				return [image];
			},
		};
		const component = new Markdown("```image\nsource\n```", 1, 0, theme);
		const wide = component.render(80);
		const narrow = component.render(20);
		assert.equal(highlights, 1);
		assert.equal(
			narrow.find((line) => line.includes(image)),
			wide.find((line) => line.includes(image)),
		);
		assert.ok(narrow.some((line) => line.includes(image)));
	});

	it("reruns width-sensitive transforms and reparses their changed output", () => {
		const widths: number[] = [];
		const component = new Markdown("source", 1, 0, defaultMarkdownTheme, undefined, {
			transform: (_source, width) => {
				widths.push(width);
				return `# Width ${width}\n\n[text][ref]\n\n[ref]: https://example.com/${width}`;
			},
		});
		for (const width of [80, 25, 80]) {
			const source = `# Width ${width - 2}\n\n[text][ref]\n\n[ref]: https://example.com/${width - 2}`;
			assert.deepEqual(component.render(width), new Markdown(source, 1, 0, defaultMarkdownTheme).render(width));
			component.render(width);
		}
		assert.deepEqual(widths, [78, 23, 78]);
	});

	it("matches fresh parsing after cross-block reference, table and fence updates", () => {
		const component = new Markdown("", 1, 0, defaultMarkdownTheme);
		for (const source of [
			"[reference][ref]\n\nparagraph",
			"[reference][ref]\n\nparagraph\n\n[ref]: https://example.com",
			"| first | second |\n| --- | --- |\n| short | text |",
			"| first | second |\n| --- | --- |\n| short | text |\n| longest-cell-in-column | 更多文本 |",
			"> - ```ts\n>   const value = 1;\n>   ``",
			"> - ```ts\n>   const value = 1;\n>   ```",
		]) {
			component.setText(source);
			for (const width of [80, 24, 80]) {
				assert.deepEqual(component.render(width), new Markdown(source, 1, 0, defaultMarkdownTheme).render(width));
			}
		}
	});

	it("retries failed rendering without retaining partially styled blocks", () => {
		let fail = true;
		let prefix = "first:";
		const theme = {
			...defaultMarkdownTheme,
			heading: (text: string) => prefix + text,
			highlightCode: (code: string) => {
				if (fail) throw new Error("highlight failed");
				return [code];
			},
		};
		const source = "# Heading\n\n```\ncode\n```";
		const component = new Markdown(source, 1, 0, theme);
		assert.throws(() => component.render(80), /highlight failed/);
		fail = false;
		prefix = "retry:";
		assert.deepEqual(component.render(80), new Markdown(source, 1, 0, theme).render(80));
	});

	it("invalidates styled caches when the theme changes", () => {
		let prefix = "old:";
		const theme = { ...defaultMarkdownTheme, highlightCode: (code: string) => [prefix + code] };
		const source = "# Heading\n\n```\ncode\n```";
		const component = new Markdown(source, 1, 0, theme);
		component.render(80);
		prefix = "new:";
		component.invalidate();
		assert.deepEqual(component.render(80), new Markdown(source, 1, 0, theme).render(80));
	});
});
