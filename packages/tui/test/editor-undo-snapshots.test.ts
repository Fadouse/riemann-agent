import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { UndoStack } from "../src/undo-stack.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("Undo snapshot cloning", () => {
	it("keeps default generic deep isolation for nested mutable values", () => {
		const original = { nested: { values: [1] }, map: new Map([[1, { value: 2 }]]) };
		const stack = new UndoStack<typeof original>();
		stack.push(original);
		original.nested.values.push(3);
		original.map.get(1)!.value = 4;
		stack.push(original);
		const latest = stack.pop()!;
		latest.nested.values[0] = 9;
		latest.map.get(1)!.value = 10;
		assert.deepEqual(stack.pop(), { nested: { values: [1] }, map: new Map([[1, { value: 2 }]]) });
		assert.deepEqual(original, { nested: { values: [1, 3] }, map: new Map([[1, { value: 4 }]]) });
		assert.equal(stack.pop(), undefined);
		stack.push(original);
		stack.clear();
		assert.equal(stack.length, 0);
	});

	it("uses an explicit cloner once per push and does not clone on pop", () => {
		let copies = 0;
		const original = { values: [1], text: "immutable" };
		const stack = new UndoStack<typeof original>((state) => {
			copies++;
			return { values: [...state.values], text: state.text };
		});
		stack.push(original);
		original.values.push(2);
		stack.push(original);
		const popped = stack.pop()!;
		assert.equal(copies, 2);
		popped.values.push(3);
		assert.deepEqual(stack.pop(), { values: [1], text: "immutable" });
		assert.deepEqual(original.values, [1, 2]);
		assert.equal(copies, 2);
	});

	it("copies editor containers without serializing shared paste strings and preserves every undo", (t) => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		const paste = "中文👩".repeat(1000);
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		const marker = editor.getText();
		const clone = globalThis.structuredClone;
		t.mock.method(globalThis, "structuredClone", <T>(value: T): T => {
			assert.equal(typeof value, "string", "Editor snapshots must not serialize their containers and strings");
			return clone(value);
		});
		const states = [marker];
		for (let i = 0; i < 32; i++) {
			editor.insertTextAtCursor(`\nline ${i} e`);
			states.push(editor.getText());
		}
		// Clearing the active map must not clear any older snapshot's registry.
		editor.setText("replacement");
		editor.handleInput("\x1f");
		assert.equal(editor.getText(), states[32]);
		for (let i = 31; i >= 0; i--) {
			editor.handleInput("\x1f");
			assert.equal(editor.getText(), states[i]);
			assert.equal(editor.getExpandedText(), paste + states[i].slice(marker.length));
		}
		// Editing after restore cannot mutate the next older snapshot.
		editor.handleInput("\x7f");
		assert.equal(editor.getText(), "");
		editor.handleInput("\x1f");
		assert.equal(editor.getExpandedText(), paste);
		editor.handleInput("\x1f");
		assert.equal(editor.getText(), "");
	});

	it("keeps history drafts detached without serializing their immutable lines", (t) => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.setText("draft 中文👩");
		editor.addToHistory("old");
		editor.handleInput("\x01");
		const clone = globalThis.structuredClone;
		t.mock.method(globalThis, "structuredClone", <T>(value: T): T => {
			assert.equal(typeof value, "string", "History drafts must only copy mutable containers");
			return clone(value);
		});
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "old");
		editor.handleInput("\x1b[B");
		assert.equal(editor.getText(), "draft 中文👩");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		editor.handleInput("x");
		editor.handleInput("\x1f");
		assert.equal(editor.getText(), "draft 中文👩");
	});
});
