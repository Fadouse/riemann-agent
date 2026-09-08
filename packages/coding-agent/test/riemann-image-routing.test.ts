import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { KernelExecuteResult } from "../src/riemann/kernel/types.ts";
import { MODEL_TEXT_BYTES, OutputViews, renderModelText } from "../src/riemann/output.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

describe("Riemann image routing", () => {
	test("does not attach images to child Agent model context", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-child-images-"));
		const store = new RiemannStore(join(root, "agent"));
		const run = store.openRun("child-images", root);
		const artifacts = new ArtifactStore(store, run.id);
		const fakeThis = {
			root: false,
			pendingRestoreNotice: undefined,
			artifacts,
			outputViews: new OutputViews(artifacts),
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
			header: string,
		) => Promise<{ content: Array<{ type: string; text?: string }> }>;

		try {
			const formatted = await formatResult.call(fakeThis, result, "Cell c1 ok.");
			expect(formatted.content).toHaveLength(1);
			expect(formatted.content[0]).toMatchObject({ type: "text" });
			expect(formatted.content[0]?.text).toContain("child Agent context");
		} finally {
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
	test("bounds combined UTF-8 output and preserves diagnostics outside the preview", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-model-output-"));
		const store = new RiemannStore(join(root, "agent"));
		const run = store.openRun("model-output", root);
		const agent = store.ensureRootAgent(run.id, root);
		const artifacts = new ArtifactStore(store, run.id).forAgent(agent.id);
		const views = new OutputViews(artifacts);
		const stored: string[] = [];
		const originalPut = artifacts.putText.bind(artifacts);
		const putText = vi.spyOn(artifacts, "putText").mockImplementation(async (value, options) => {
			stored.push(value);
			return originalPut(value, options);
		});
		const fakeThis = {
			root: false,
			pendingRestoreNotice: undefined,
			artifacts,
			outputViews: views,
			shared: { config: { limits: { maxPreviewBytes: 2048 } } },
		};
		Object.setPrototypeOf(fakeThis, RiemannRuntime.prototype);
		const result: KernelExecuteResult = {
			status: "error",
			stdout: "中😀".repeat(10000),
			stderr: "warning".repeat(1000),
			displays: [],
			modelContent: [],
			error: {
				ename: "ValueError",
				evalue: "bad argument",
				traceback: ["\x1b[31mprivate internal frame\x1b[0m"],
				details: { cause: "native detail" },
			},
			durationMs: 1,
		};
		const formatResult = Reflect.get(RiemannRuntime.prototype, "formatResult") as (
			this: typeof fakeThis,
			result: KernelExecuteResult,
			header: string,
		) => Promise<{ content: Array<{ type: string; text?: string }>; moreRef?: string; error?: string }>;
		try {
			const formatted = await formatResult.call(fakeThis, result, "Cell c1 error.");
			const rendered = formatted.content[0]?.text ?? "";
			expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
			expect(rendered).toContain("ValueError: bad argument");
			expect(rendered).not.toContain("private internal frame");
			expect(rendered).not.toContain("artifact://");
			expect(rendered).not.toContain("�");
			expect(stored.join("\n")).toContain("private internal frame");
			expect(stored.join("\n")).toContain("native detail");
			expect(stored.join("\n")).not.toContain("\x1b[");
			let complete = rendered;
			let more = formatted.moreRef;
			for (let i = 0; more && i < 50; i++) {
				const next = await renderModelText(views, [await views.read(more)]);
				expect(Buffer.byteLength(next.text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
				complete = complete.replace(`\n[more ${more}]\n`, () => next.text);
				more = next.more;
			}
			expect(more).toBeUndefined();
			expect(complete).toContain(result.stdout);
			expect(complete).toContain(result.stderr);
			const putParts = vi.spyOn(artifacts, "putTextParts").mockRejectedValueOnce(new Error("disk full"));
			await expect(formatResult.call(fakeThis, { ...result, error: undefined }, "Cell c1 ok.")).rejects.toThrow(
				"disk full",
			);
			putParts.mockRestore();
			putText.mockClear();
			const invalid = await formatResult.call(
				fakeThis,
				{
					...result,
					stdout: "",
					stderr: "",
					error: {
						ename: "RiemannError",
						evalue: "max_items: expected 1..1000, got 30000",
						code: "invalid_arguments",
						traceback: ["unneeded trace"],
					},
				},
				"Cell c2 error.",
			);
			expect(invalid.content[0]?.text).toContain("max_items");
			expect(stored.join("\n")).toContain("unneeded trace");
		} finally {
			putText.mockRestore();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
