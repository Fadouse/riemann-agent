import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { processImageMock, readClipboardImageMock } = vi.hoisted(() => ({
	processImageMock: vi.fn(),
	readClipboardImageMock: vi.fn(),
}));

vi.mock("../src/utils/clipboard-image.ts", () => ({
	readClipboardImage: readClipboardImageMock,
}));

vi.mock("../src/utils/image-process.ts", () => ({
	processImage: processImageMock,
}));

import { collectMarkedImages, evictImagesToBudget, imageMarkerIds } from "../src/modes/interactive/image-markers.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function image(data: string): ImageContent {
	return { type: "image", mimeType: "image/png", data };
}

describe("InteractiveMode image attachments", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test("assigns stable numbered markers while keeping processing hints out of the editor", async () => {
		readClipboardImageMock.mockResolvedValue({
			mimeType: "image/png",
			bytes: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
				"base64",
			),
		});
		processImageMock.mockResolvedValue({
			ok: true,
			data: "processed-image",
			mimeType: "image/png",
			hints: ["[Image: original 2119x1200, displayed at 2000x1133.]"],
		});
		const pastedImages = new Map<number, ImageContent>();
		const insertTextAtCursor = vi.fn();
		const fakeThis = {
			nextImageMarkerId: 1,
			rememberPastedImage: (id: number, attachment: ImageContent) => pastedImages.set(id, attachment),
			settingsManager: { getImageAutoResize: () => true },
			editor: { insertTextAtCursor },
			ui: { requestRender: vi.fn() },
			showWarning: vi.fn(),
		};
		const handleClipboardPaste = Reflect.get(InteractiveMode.prototype, "handleClipboardPaste") as (
			this: typeof fakeThis,
		) => Promise<void>;

		await handleClipboardPaste.call(fakeThis);
		await handleClipboardPaste.call(fakeThis);

		expect([...pastedImages]).toEqual([
			[1, image("processed-image")],
			[2, image("processed-image")],
		]);
		expect(fakeThis.nextImageMarkerId).toBe(3);
		expect(insertTextAtCursor.mock.calls).toEqual([["[Image #1]"], ["[Image #2]"]]);
		expect(fakeThis.showWarning).not.toHaveBeenCalled();
	});

	test("uses complete markers as the only attachment source", () => {
		const first = image("first");
		const second = image("second");
		const pastedImages = new Map([
			[1, first],
			[2, second],
		]);

		expect(collectMarkedImages(pastedImages, "removed")).toEqual([]);
		expect(collectMarkedImages(pastedImages, "damaged [Image #1 and keep [Image #2]")).toEqual([second]);
		expect(collectMarkedImages(pastedImages, "[Image #2] duplicate [Image #2]")).toEqual([second]);
		expect(imageMarkerIds("[Image #2] duplicate [Image #2]")).toEqual([2, 2]);
	});

	test("routes ordinary submission through marker-authoritative collection", async () => {
		const first = image("first");
		const second = image("second");
		const pastedImages = new Map([
			[1, first],
			[2, second],
		]);
		const submitted = vi.fn();
		const defaultEditor: { onSubmit?: (text: string) => Promise<void> } = {};
		const editor = { addToHistory: vi.fn(), setText: vi.fn() };
		const fakeThis = {
			defaultEditor,
			editor,
			session: { isCompacting: false, isStreaming: false },
			collectImagesFor: (text: string) => {
				const images = collectMarkedImages(pastedImages, text);
				return images.length > 0 ? images : undefined;
			},
			flushPendingBashComponents: vi.fn(),
			onInputCallback: submitted,
			pendingUserInputs: [],
		};
		const setupEditorSubmitHandler = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
			this: typeof fakeThis,
		) => void;
		setupEditorSubmitHandler.call(fakeThis);

		await defaultEditor.onSubmit?.("keep [Image #2]");
		expect(submitted).toHaveBeenLastCalledWith({ text: "keep [Image #2]", images: [second] });

		await defaultEditor.onSubmit?.("marker removed");
		expect(submitted).toHaveBeenLastCalledWith({ text: "marker removed" });
	});

	test("preserves stable marker identity when queued messages return to the editor", () => {
		const first = image("first");
		const second = image("second");
		const pastedImages = new Map([
			[1, first],
			[2, second],
		]);
		const setText = vi.fn();
		const fakeThis = {
			clearAllQueues: () => ({
				steering: [{ text: "first [Image #1]", images: [first] }],
				followUp: [{ text: "second [Image #2]", images: [second] }],
			}),
			updatePendingMessagesDisplay: vi.fn(),
			pastedImages,
			nextImageMarkerId: 3,
			collectImagesFor: (text: string) => collectMarkedImages(pastedImages, text),
			editor: { getText: () => "", setText },
			agent: { abort: vi.fn() },
		};
		const restoreQueuedMessagesToEditor = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof fakeThis,
		) => number;

		expect(restoreQueuedMessagesToEditor.call(fakeThis)).toBe(2);
		const restoredText = setText.mock.calls[0]?.[0] as string;
		expect(restoredText).toBe("first [Image #1]\n\nsecond [Image #2]");
		expect(collectMarkedImages(pastedImages, restoredText)).toEqual([first, second]);
	});

	test("bounds retained image data without evicting referenced IDs", () => {
		const images = new Map([
			[1, "1111"],
			[2, "2222"],
			[3, "3333"],
		]);

		evictImagesToBudget(images, (value) => value.length, 4, new Set([1]));

		expect([...images]).toEqual([[1, "1111"]]);
	});
});
