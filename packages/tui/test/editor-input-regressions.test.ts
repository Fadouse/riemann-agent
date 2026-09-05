import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createEditor(): Editor {
	return new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
}

async function openCompletions(editor: Editor): Promise<void> {
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "model" }], "/tmp"));
	editor.handleInput("/");
	editor.handleInput("m");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(editor.isShowingAutocomplete(), true);
}

describe("editor input regressions", () => {
	for (const [action, key] of [
		["delete to start", "\x15"],
		["delete word backward", "\x17"],
		["undo", "\x1f"],
		["line start", "\x01"],
		["word left", "\x1bb"],
		["page up", "\x1b[5~"],
		["delete to end", "\x0b"],
		["delete word forward", "\x1bd"],
		["line end", "\x05"],
		["word right", "\x1bf"],
		["yank", "\x19"],
		["yank pop", "\x1by"],
		["page down", "\x1b[6~"],
	] as const) {
		it(`invalidates old completions after ${action}`, async () => {
			const editor = createEditor();
			await openCompletions(editor);
			editor.handleInput(key);
			assert.equal(editor.isShowingAutocomplete(), false);
		});
	}

	it("hides old suggestions immediately while a replacement request is pending", async () => {
		const editor = createEditor();
		await openCompletions(editor);
		editor.handleInput("z");
		assert(!editor.render(80).join("\n").includes("model"));
		let submitted = "";
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.handleInput("\r");
		assert.equal(submitted, "/mz");
	});

	it("preserves display columns across CJK and ASCII lines", () => {
		const editor = createEditor();
		editor.setText("abcdefghij\n中文测试文字");
		editor.render(80);
		editor.handleInput("\x1b[A");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 10 });
		editor.handleInput("\x1b[B");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 6 });
	});

	it("snaps an odd display column to the start of a wide grapheme", () => {
		const editor = createEditor();
		editor.setText("中文测试\nabc");
		editor.render(80);
		editor.handleInput("\x1b[A");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 1 });
		editor.handleInput("\x1b[B");
		assert.deepEqual(editor.getCursor(), { line: 1, col: 3 });
	});
});
