import { describe, expect, test, vi } from "vitest";

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

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode image attachments", () => {
	test("shows only numbered markers while keeping processing hints out of the editor", async () => {
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
		const insertTextAtCursor = vi.fn();
		const fakeThis = {
			pendingImages: [],
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

		expect(fakeThis.pendingImages).toEqual([
			{ type: "image", mimeType: "image/png", data: "processed-image" },
			{ type: "image", mimeType: "image/png", data: "processed-image" },
		]);
		expect(insertTextAtCursor.mock.calls).toEqual([["[Image #1]"], ["[Image #2]"]]);
		expect(fakeThis.showWarning).not.toHaveBeenCalled();
	});
});
