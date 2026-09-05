import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(text: string): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
	editor.setText(text);
	return editor;
}

describe("Editor long input work", () => {
	it("does not lay out the document or enumerate the suffix for horizontal movement", (t) => {
		const editor = createEditor(`👩🏽‍💻${"中文 é ".repeat(2000)}`);
		editor.handleInput("\x01");
		let visited = 0;
		const segment = Intl.Segmenter.prototype.segment;
		t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, input: string): Intl.Segments {
			const segments = segment.call(this, input);
			return {
				containing: (index) => segments.containing(index),
				*[Symbol.iterator](): Generator<Intl.SegmentData, undefined> {
					for (const value of segments) {
						visited++;
						yield value;
					}
				},
			};
		});
		editor.handleInput("\x1b[C");
		assert.deepEqual(editor.getCursor(), { line: 0, col: "👩🏽‍💻".length });
		assert.equal(visited, 1, "right arrow only needs the first grapheme, not a visual line map or suffix array");
		visited = 0;
		editor.handleInput("\x05");
		editor.handleInput("\x1b[D");
		assert.equal(visited, 0, "left arrow can query the segment containing the preceding code unit");
	});

	it("only visits the atomic image marker at the cursor, not the remaining suffix", (t) => {
		const editor = createEditor(`[Image #12]${"正文 ".repeat(2000)}`);
		editor.handleInput("\x01");
		let visited = 0;
		const segment = Intl.Segmenter.prototype.segment;
		t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, input: string): Intl.Segments {
			const segments = segment.call(this, input);
			return {
				containing: (index) => segments.containing(index),
				*[Symbol.iterator](): Generator<Intl.SegmentData, undefined> {
					for (const value of segments) {
						visited++;
						yield value;
					}
				},
			};
		});
		editor.handleInput("\x1b[C");
		assert.deepEqual(editor.getCursor(), { line: 0, col: "[Image #12]".length });
		assert.equal(visited, 1);
	});

	it("normalizes and retains a full UTF-16 paste without per-character or per-line arrays", (t) => {
		const text = `${Array.from({ length: 65536 }, (_, code) => String.fromCharCode(code)).join("")}\x1b[106;5u👩🏽‍💻`;
		const expected = `${text.slice(0, 65536)}\n👩🏽‍💻`
			.replace(/\r\n/g, "\n")
			.replace(/\r/g, "\n")
			.replace(/\t/g, "    ")
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");
		const editor = createEditor("");
		const split: (this: string, separator: string | RegExp, limit?: number) => string[] = String.prototype.split;
		t.mock.method(
			String.prototype,
			"split",
			function (this: string, separator: string | RegExp, limit?: number): string[] {
				assert.ok(
					this.length < 1000,
					"large paste metadata should not allocate an array for every character or line",
				);
				return split.call(this, separator, limit);
			},
		);
		editor.handleInput(`\x1b[200~${text}\x1b[201~`);
		assert.equal(editor.getExpandedText(), expected);
		const marked = editor.getText();
		editor.handleInput("\x7f");
		assert.equal(editor.getText(), "");
		editor.handleInput("\x1f");
		assert.equal(editor.getText(), marked);
		assert.equal(editor.getExpandedText(), expected);
		editor.handleInput("\x1f");
		assert.equal(editor.getText(), "");
	});
});
