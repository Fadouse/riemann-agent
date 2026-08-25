import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { wordWrapLine } from "../src/components/editor.ts";
import { normalizeImageLine } from "../src/terminal-image.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { normalizeTerminalOutput, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("terminal text safety", () => {
	it("matches terminal UTF-8 replacement and width for lone surrogates", () => {
		const input = "a\ud800b\udcffc";
		const output = normalizeTerminalOutput(input);
		const wireRoundTrip = Buffer.from(output).toString("utf8");

		assert.strictEqual(output, "a�b�c");
		assert.strictEqual(wireRoundTrip, output);
		assert.strictEqual(visibleWidth(input), visibleWidth(wireRoundTrip));
	});

	it("removes unsafe terminal controls while preserving renderer-safe sequences", () => {
		const sgr = "\x1b[31mred\x1b[0m";
		const osc8 = "\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\";
		const osc133 = "\x1b]133;A\x07";
		const cursorMarker = "\x1b_pi:c\x07";
		const input = `before\x1b[2J\x1b[3;4H\x1b[1G\x1b[K\x1b]0;title\x07\x1b_payload\x07\r\b${sgr}${osc8}${osc133}${cursorMarker}after`;

		assert.strictEqual(normalizeTerminalOutput(input), `before${sgr}${osc8}${osc133}${cursorMarker}after`);
		assert.strictEqual(visibleWidth(input), visibleWidth("beforeredlinkafter"));
	});

	it("handles repeated malformed ESC prefixes in linear time", () => {
		const utilsUrl = new URL("../src/utils.ts", import.meta.url).href;
		const script = `
			import { extractAnsiCode } from ${JSON.stringify(utilsUrl)};
			const input = "\x1b]x".repeat(30_000);
			for (let i = 0; i < input.length; i += 3) {
				if (extractAnsiCode(input, i) !== null) process.exit(2);
			}
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			timeout: 1_000,
		});

		assert.strictEqual(result.error, undefined, result.error?.message);
		assert.strictEqual(result.status, 0, result.stderr.toString());
	});

	it("preserves safe OSC payload text and sanitizes text around image sequences", () => {
		const osc8 = "\x1b]8;;https://example.test/กำ\x1b\\label\x1b]8;;\x1b\\";
		assert.strictEqual(normalizeTerminalOutput(osc8), osc8);

		const kitty = "\x1b_Ga=T,f=100,q=2,C=1;QUFBQQ==\x1b\\";
		assert.strictEqual(normalizeImageLine(`before\x1b[2J${kitty}after\x1b[H`), `before${kitty}after`);
		assert.strictEqual(normalizeImageLine("\x1b_Ga=d,d=A,q=2\x1b\\"), "");
		assert.strictEqual(normalizeImageLine("\x1b_Ga=T,f=100,q=2,m=1;QUFB\x1b\\"), "");
	});
});

class MutableWrappedComponent implements Component {
	text = "initial";
	render(width: number): string[] {
		return [...wrapTextWithAnsi(this.text, width), ...wrapTextWithAnsi("after", width)];
	}
	invalidate(): void {}
}

describe("main-screen Unicode rendering", () => {
	it("keeps wire width and adjacent rows stable across differential updates", async () => {
		const terminal = new VirtualTerminal(10, 6);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new MutableWrappedComponent();
		tui.addChild(component);
		tui.start();
		tui.renderNow();
		await terminal.flush();

		component.text = "123456789\ud800";
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 2), ["123456789�", "after"]);

		component.text = "界";
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 2), ["界", "after"]);
		tui.stop();
	});

	it("renders a wide grapheme safely in a one-column terminal", async () => {
		const terminal = new VirtualTerminal(1, 8);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new MutableWrappedComponent();
		tui.addChild(component);
		tui.start();
		tui.renderNow();
		await terminal.flush();

		component.text = "界";
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(terminal.getViewport().slice(0, 6), ["?", "a", "f", "t", "e", "r"]);
		tui.stop();
	});
});

describe("width-one wrapping", () => {
	it("keeps a wide grapheme as one non-empty editor chunk", () => {
		assert.deepStrictEqual(wordWrapLine("界", 1), [{ text: "?", startIndex: 0, endIndex: 1 }]);
	});

	it("does not emit an empty line before an unavoidable wide grapheme", () => {
		assert.deepStrictEqual(wrapTextWithAnsi("界", 1), ["?"]);
	});
});
