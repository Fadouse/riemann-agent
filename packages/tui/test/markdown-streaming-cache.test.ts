import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown, type MarkdownOptions } from "../src/components/markdown.ts";
import { getCapabilities, setCapabilities } from "../src/terminal-image.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";

describe("Markdown streaming block reuse", () => {
	it("refreshes externally changed theme closures on generic setText", () => {
		let prefix = "old:";
		const theme = { ...defaultMarkdownTheme, heading: (text: string) => prefix + text };
		const component = new Markdown("## stable\n\nbody", 1, 0, theme);
		component.render(80);
		component.setText("## stable\n\nbody two");
		component.render(80);
		prefix = "new:";
		component.setText("## stable\n\nbody three");
		assert.ok(component.render(80).join("\n").includes("new:"));
	});

	it("preserves generic transforms that change theme closure state", () => {
		let prefix = "old:";
		let requested = "old:";
		const theme = { ...defaultMarkdownTheme, heading: (text: string) => prefix + text };
		const component = new Markdown("", 1, 0, theme, undefined, {
			transform: (source) => {
				prefix = requested;
				return source;
			},
		});
		component.setText("## stable\n\nbody one");
		component.render(80);
		component.setText("## stable\n\nbody two");
		component.render(80);
		requested = "new:";
		component.setText("## stable\n\nbody three");
		assert.ok(component.render(80).join("\n").includes("new:"));
	});

	it("reuses stable code and wrapped background rows after streaming is established", () => {
		let highlights = 0;
		let backgrounds = 0;
		const theme = {
			...defaultMarkdownTheme,
			highlightCode: (code: string) => {
				highlights++;
				return code.split("\n");
			},
		};
		const style = {
			bgColor: (line: string) => {
				backgrounds++;
				return line;
			},
		};
		const prefix = "```ts\nconst value = 1;\n```\n\n";
		const component = new Markdown("", 1, 0, theme, style, { reuseStableBlocks: true });
		component.setText(`${prefix}tail one`);
		component.render(40);
		const firstBackgrounds = backgrounds;
		component.setText(`${prefix}tail two`);
		component.render(40);
		assert.equal(highlights, 1);
		assert.ok(backgrounds - firstBackgrounds < firstBackgrounds);
	});

	it("does not probe every inline tail for absent math delimiters", (context) => {
		const indexOf = String.prototype.indexOf;
		let mathProbes = 0;
		context.mock.method(String.prototype, "indexOf", function (this: string, search: string, position?: number) {
			if (search === "$") mathProbes++;
			return indexOf.call(this, search, position);
		});
		new Markdown(
			"Plain **中文\u{1f469}\u{1f3fd}\u200d\u{1f4bb}** text with no math.\n\n".repeat(20),
			1,
			0,
			defaultMarkdownTheme,
		).render(40);
		assert.equal(mathProbes, 0);
	});

	it("does not scan every block tail for absent display math in inline-only math", (context) => {
		const exec = RegExp.prototype.exec;
		const displayStart = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.source;
		let displayProbes = 0;
		context.mock.method(RegExp.prototype, "exec", function (this: RegExp, source: string) {
			if (this.source === displayStart) displayProbes++;
			return exec.call(this, source);
		});
		new Markdown("Inline math $x^2$ with prose.\n\n".repeat(20), 1, 0, defaultMarkdownTheme).render(40);
		assert.equal(displayProbes, 0);
	});

	it("does not retain never-resized static layout token trees", () => {
		const source = "- first\n- second\n\n| name | value |\n| --- | --- |\n| text | 中文 |\n\n> quote";
		const component = new Markdown(source, 1, 0, defaultMarkdownTheme);
		component.render(80);
		// Check retained cache structure, not a timing or GC heuristic.
		const blocks = Reflect.get(component, "parsedBlocks") as Array<Record<string, unknown>>;
		assert.ok(blocks.every((block) => !("token" in block)));
		for (const width of [24, 80, 24]) {
			assert.deepEqual(component.render(width), new Markdown(source, 1, 0, defaultMarkdownTheme).render(width));
		}
	});

	it("detaches only newly rendered row strings before retaining streaming output", (context) => {
		const clone = context.mock.method(globalThis, "structuredClone");
		const component = new Markdown("", 1, 0, defaultMarkdownTheme, undefined, { reuseStableBlocks: true });
		component.setText("# Stable\n\ntail one");
		component.render(40);
		clone.mock.resetCalls();
		component.setText("# Stable\n\ntail two");
		component.render(40);
		const rowCopies = clone.mock.calls.flatMap((call) => {
			const value: unknown = call.arguments[0];
			return Array.isArray(value) && value.every((line: unknown) => typeof line === "string")
				? (value as string[])
				: [];
		});
		assert.ok(rowCopies.some((line) => line.includes("tail two")));
		assert.ok(rowCopies.every((line) => !line.includes("Stable")));
	});

	it("does not reuse mutations to an earlier public render array", () => {
		const component = new Markdown("", 1, 0, defaultMarkdownTheme, undefined, { reuseStableBlocks: true });
		const prefix = "# Stable\n\n";
		component.setText(`${prefix}one`);
		const first = component.render(40);
		first[0] = "external mutation";
		component.setText(`${prefix}two`);
		assert.deepEqual(component.render(40), new Markdown(`${prefix}two`, 1, 0, defaultMarkdownTheme).render(40));
	});

	it("matches fresh rendering at every streaming boundary for contextual Markdown", () => {
		const samples = [
			'[ref][id] and ![image][id]\n\n[id]: https://example.com/first "title"\n\n[id]: https://example.com/ignored\n',
			"heading\n=======\n\n---\n\n- first\n- second\n\n  second paragraph\n\n- third\n",
			"| name | value |\n| :--- | ---: |\n| 中\u{1f469}\u{1f3fd}\u200d\u{1f4bb} | [ref][id] |\n| longest-unbroken-token | $x^2$ |\n\n[id]: https://example.com\n",
			"> quoted **bold**\n>\n> - first\n> - nested\n>   ```ts\n>   const value = `x`;\n>   ```\n\nparagraph\n",
			"```ts\nconst value = 1;\n```\n\n~~~python\nprint(1)\n~~~~\n\nfinal\n",
			"<div>\n**literal text**\n</div>\n\n<!-- comment\ncontinued -->\n\nparagraph\n",
			"Combining e\u0301, 中文, emoji \u{1f469}\u{1f3fd}\u200d\u{1f4bb} and flags \u{1f1fa}\u{1f1f8}.\n\n\\[\n\\frac{a}{b}\n\\]\n",
		];
		const options: MarkdownOptions = {
			reuseStableBlocks: true,
			preserveOrderedListMarkers: true,
			preserveBackslashEscapes: true,
		};
		for (const source of samples) {
			for (const width of [18, 80]) {
				const component = new Markdown("", 1, 1, defaultMarkdownTheme, undefined, options);
				for (let length = 1; length <= source.length; length++) {
					const partial = source.slice(0, length);
					component.setText(partial);
					assert.deepEqual(
						component.render(width),
						new Markdown(partial, 1, 1, defaultMarkdownTheme, undefined, options).render(width),
						`width=${width} partial=${JSON.stringify(partial)}`,
					);
				}
			}
		}
	});

	it("refreshes reused link styling when terminal hyperlink capabilities change", () => {
		const capabilities = getCapabilities();
		const component = new Markdown("", 1, 0, defaultMarkdownTheme, undefined, { reuseStableBlocks: true });
		try {
			setCapabilities({ ...capabilities, hyperlinks: false });
			component.setText("[link](https://example.com)\n\ntail one");
			component.render(80);
			setCapabilities({ ...capabilities, hyperlinks: true });
			const source = "[link](https://example.com)\n\ntail two";
			component.setText(source);
			assert.deepEqual(component.render(80), new Markdown(source, 1, 0, defaultMarkdownTheme).render(80));
		} finally {
			setCapabilities(capabilities);
		}
	});

	it("preserves opaque image rows, transforms, explicit invalidation and resize during updates", () => {
		let image = "\x1b_Ga=T,f=100;AAAA\x1b\\";
		const theme = { ...defaultMarkdownTheme, highlightCode: () => [image] };
		const options: MarkdownOptions = {
			reuseStableBlocks: true,
			transform: (source, width) => `${source}\n\nwidth ${width}`,
		};
		const component = new Markdown("", 1, 1, theme, undefined, options);
		for (const source of [
			"```image\nfirst\n```",
			"```image\nfirst\n```\n\ntail",
			"```image\nchanged\n```\n\n尾部\u{1f469}\u{1f3fd}\u200d\u{1f4bb}",
		]) {
			component.setText(source);
			for (const width of [80, 24, 80]) {
				assert.deepEqual(
					component.render(width),
					new Markdown(source, 1, 1, theme, undefined, options).render(width),
				);
			}
		}
		image = "\x1b]1337;File=inline=1:BBBB\x07";
		component.invalidate();
		const final = "```image\nfinal\n```";
		component.setText(final);
		assert.deepEqual(component.render(24), new Markdown(final, 1, 1, theme, undefined, options).render(24));
	});

	it("invalidates reused links when a distant reference definition changes", () => {
		const component = new Markdown("", 1, 0, defaultMarkdownTheme, undefined, { reuseStableBlocks: true });
		for (const source of [
			"[label][id]\n\n- [label][id]\n\n[id]: https://example.com/first",
			"[label][id]\n\n- [label][id]\n\n[id]: https://example.com/second",
			"[label][id]\n\n- [label][id]",
		]) {
			component.setText(source);
			assert.deepEqual(component.render(80), new Markdown(source, 1, 0, defaultMarkdownTheme).render(80));
		}
	});
});
