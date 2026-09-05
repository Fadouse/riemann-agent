import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { CombinedAutocompleteProvider, Editor, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { collectMarkedImages } from "../src/modes/interactive/image-markers.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type QueuedInput = { text: string; images?: ImageContent[] };
type RestoreContext = {
	editor: Editor;
	clearAllQueues: () => { steering: QueuedInput[]; followUp: QueuedInput[] };
	updatePendingMessagesDisplay: () => void;
	agent: { abort: () => void };
	pastedImages: Map<number, ImageContent>;
	nextImageMarkerId: number;
	collectImagesFor: (text: string) => ImageContent[] | undefined;
};
const restore = (
	InteractiveMode.prototype as unknown as {
		restoreQueuedMessagesToEditor(this: RestoreContext, options?: { abort?: boolean }): number;
	}
).restoreQueuedMessagesToEditor;

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("queued input restoration", () => {
	for (const abort of [false, true]) {
		it(`preserves expanded draft and queued images (abort=${abort})`, () => {
			const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
			const paste = "large draft ".repeat(200);
			editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
			const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
			const context: RestoreContext = {
				editor,
				clearAllQueues: () => ({ steering: [{ text: "correction", images: [image] }], followUp: [] }),
				updatePendingMessagesDisplay: vi.fn(),
				agent: { abort: vi.fn() },
				pastedImages: new Map(),
				nextImageMarkerId: 1,
				collectImagesFor: () => undefined,
			};
			expect(restore.call(context, { abort })).toBe(1);
			expect(editor.getExpandedText()).toContain(paste);
			expect(editor.getText()).toContain("[Image #1]");
			expect(context.pastedImages.get(1)).toBe(image);
			expect(context.agent.abort).toHaveBeenCalledTimes(abort ? 1 : 0);
		});
	}
	it("keeps existing clipboard image markers and does not expand an untouched draft", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		editor.setText("draft [Image #7]");
		const context: RestoreContext = {
			editor,
			clearAllQueues: () => ({ steering: [{ text: "queued [Image #7]", images: [image] }], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
			agent: { abort: vi.fn() },
			pastedImages: new Map([[7, image]]),
			nextImageMarkerId: 8,
			collectImagesFor: () => [image],
		};
		restore.call(context);
		expect(editor.getText()).toBe("queued [Image #7]\n\ndraft [Image #7]");
		expect(context.nextImageMarkerId).toBe(8);
		const expanded = vi.spyOn(editor, "getExpandedText");
		context.clearAllQueues = () => ({ steering: [], followUp: [] });
		expect(restore.call(context)).toBe(0);
		expect(expanded).not.toHaveBeenCalled();
	});
	it("preserves two identical queued attachments when only one already has a marker", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		const first: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const second: ImageContent = { ...first };
		const images = new Map([[7, first]]);
		const context: RestoreContext = {
			editor,
			clearAllQueues: () => ({ steering: [{ text: "compare [Image #7]", images: [first, second] }], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
			agent: { abort: vi.fn() },
			pastedImages: images,
			nextImageMarkerId: 8,
			collectImagesFor: (text) => collectMarkedImages(images, text),
		};

		expect(restore.call(context)).toBe(1);
		expect(editor.getText()).toBe("compare [Image #7] [Image #8]");
		expect(context.nextImageMarkerId).toBe(9);
		expect(images.get(8)).toBe(second);
		const restored = collectMarkedImages(images, editor.getText());
		expect(restored).toHaveLength(2);
		expect(restored[0]).toBe(first);
		expect(restored[1]).toBe(second);
	});
});

describe("input behavior and performance", () => {
	it("renders input chrome without reading or expanding a long draft", () => {
		const editor = new CustomEditor(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			new KeybindingsManager(),
			{
				showPrompt: true,
			},
		);
		editor.setText("中文 mixed ".repeat(2000));
		const getText = vi.spyOn(editor, "getText");
		const expand = vi.spyOn(editor, "getExpandedText");
		editor.render(80);
		expect(getText).not.toHaveBeenCalled();
		expect(expand).not.toHaveBeenCalled();
	});

	it("keeps slash Enter submission and Tab completion unchanged", async () => {
		const editor = new CustomEditor(
			new TuiMainScreen(new VirtualTerminal()),
			defaultEditorTheme,
			new KeybindingsManager(),
			{ showPrompt: true },
		);
		editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "model" }], "/tmp"));
		const submit = vi.fn();
		editor.onSubmit = submit;
		editor.handleInput("/");
		await new Promise((resolve) => setImmediate(resolve));
		editor.handleInput("\t");
		expect(editor.getText()).toBe("/model ");
		expect(submit).not.toHaveBeenCalled();
		editor.setText("");
		editor.handleInput("/");
		await new Promise((resolve) => setImmediate(resolve));
		editor.handleInput("\r");
		expect(submit).toHaveBeenCalledWith("/model");
	});
});
