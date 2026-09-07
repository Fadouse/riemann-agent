import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { KernelExecuteResult } from "../src/riemann/kernel/types.ts";
import { OutputViews, renderModelText } from "../src/riemann/output.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

describe("Riemann image routing", () => {
	test("does not attach images to child Agent model context", async () => {
		const readBuffer = vi.fn();
		const fakeThis = {
			root: false,
			pendingRestoreNotice: undefined,
			shared: {
				config: { limits: { maxModelTextBytes: 10_000 } },
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
			shared: { config: { limits: { maxModelTextBytes: 1024 } } },
		};
		const result: KernelExecuteResult = {
			status: "error",
			stdout: "中😀".repeat(1000),
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
		) => Promise<{ content: Array<{ type: string; text?: string }>; moreRef?: string; error?: string }>;
		try {
			const formatted = await formatResult.call(fakeThis, result);
			const rendered = formatted.content[0]?.text ?? "";
			expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(1024);
			expect(rendered).toContain("ValueError: bad argument");
			expect(rendered).not.toContain("private internal frame");
			expect(rendered).not.toContain("artifact://");
			expect(rendered).not.toContain("�");
			expect(stored.join("\n")).toContain("private internal frame");
			expect(stored.join("\n")).toContain("native detail");
			expect(stored.join("\n")).not.toContain("\x1b[");
			let complete = rendered.replace(/\n\[more=r[0-9a-z]+\]$/, "");
			let more = formatted.moreRef;
			for (let i = 0; more && i < 50; i++) {
				const next = await renderModelText(views, [await views.more(more)], 1024);
				complete += next.more ? next.text.replace(/\n\[more=r[0-9a-z]+\]$/, "") : next.text;
				more = next.more;
			}
			expect(more).toBeUndefined();
			expect(complete).toContain(result.stdout);
			expect(complete).toContain(result.stderr);
			putText.mockRejectedValueOnce(new Error("disk full"));
			const failed = await formatResult.call(fakeThis, { ...result, error: undefined });
			expect(Buffer.byteLength(failed.content[0]?.text ?? "")).toBeLessThanOrEqual(1024);
			expect(failed.error).toBe("disk full");
			expect(failed.moreRef).toBeUndefined();
			putText.mockClear();
			const invalid = await formatResult.call(fakeThis, {
				...result,
				stdout: "",
				stderr: "",
				error: {
					ename: "RiemannError",
					evalue: "max_items: expected 1..1000, got 30000",
					code: "invalid_arguments",
					traceback: ["unneeded trace"],
				},
			});
			expect(invalid.content[0]?.text).toContain("max_items");
			expect(putText).not.toHaveBeenCalled();
		} finally {
			putText.mockRestore();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
