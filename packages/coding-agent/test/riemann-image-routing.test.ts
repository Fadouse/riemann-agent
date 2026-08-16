import { describe, expect, test, vi } from "vitest";
import type { KernelExecuteResult } from "../src/riemann/kernel/types.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";

describe("Riemann image routing", () => {
	test("does not attach images to child Agent model context", async () => {
		const readBuffer = vi.fn();
		const fakeThis = {
			root: false,
			pendingRestoreNotice: undefined,
			shared: {
				config: { limits: { maxCellOutputChars: 10_000 } },
				artifacts: { readBuffer, putText: vi.fn() },
			},
		};
		const result: KernelExecuteResult = {
			status: "ok",
			stdout: "",
			stderr: "",
			displays: [
				{
					data: {
						"image/png":
							"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
					},
					metadata: {},
				},
			],
			modelContent: [
				{ type: "text", text: "Read image file [image/png]" },
				{
					type: "image_ref",
					artifactHandle: "artifact://image",
					mimeType: "image/png",
					byteLength: 68,
					sha256: "hash",
				},
			],
			durationMs: 1,
		};
		const formatResult = Reflect.get(RiemannRuntime.prototype, "formatResult") as (
			this: typeof fakeThis,
			result: KernelExecuteResult,
		) => Promise<{ content: Array<{ type: string; text?: string }> }>;

		const formatted = await formatResult.call(fakeThis, result);

		expect(formatted.content).toHaveLength(1);
		expect(formatted.content[0]).toMatchObject({ type: "text" });
		expect(formatted.content[0]?.text).toContain("omitted from child Agent context");
		expect(readBuffer).not.toHaveBeenCalled();
	});
});
