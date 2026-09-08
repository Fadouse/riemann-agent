import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FULL_FILESYSTEM } from "../src/riemann/access-policy.ts";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { MODEL_TEXT_BYTES, OutputViews, renderModelText } from "../src/riemann/output.ts";
import { compactOutputPreview } from "../src/riemann/output-format.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "riemann-output-"));
	const store = new RiemannStore(join(root, "agent"));
	const run = store.openRun("output-test", root);
	const parent = store.ensureRootAgent(run.id, root);
	const child = store.createAgent({
		runId: run.id,
		parentId: parent.id,
		name: "worker",
		status: "idle",
		prompt: "",
		modelRole: "inherit",
		workspace: root,
		workspaceMode: "shared",
		filesystem: FULL_FILESYSTEM,
		network: "deny",
		depth: 1,
		capabilities: ["*"],
	});
	const system = new ArtifactStore(store, run.id);
	const artifacts = system.forAgent(parent.id);
	cleanups.push(async () => {
		store.close();
		await rm(root, { recursive: true, force: true });
	});
	return { store, run, parent, child, system, artifacts, views: new OutputViews(artifacts) };
}
function ref(value: JsonValue): string {
	if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.handle !== "string")
		throw new Error("Missing reference");
	return value.handle;
}

function body(text: string): string {
	return text.replace(/\n\n\[ref=r[0-9a-z]+[^\]]*\]$/, "");
}

test("shows a continuous tail and retains unique, complete, repeatable results", async () => {
	const { artifacts, views } = await fixture();
	const full = `HEAD${"中文😀".repeat(10000)}END`;
	const first = await renderModelText(views, [full]);
	expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(16384);
	expect(first.text).not.toContain("HEAD");
	expect(first.text).not.toContain("�");
	expect(body(first.text)).toMatch(/END$/);
	expect(full.endsWith(body(first.text))).toBe(true);
	expect(first.text).toContain(
		`${Buffer.byteLength(full) - Buffer.byteLength(body(first.text))} UTF-8 bytes omitted before; partial line]`,
	);
	expect(compactOutputPreview(first.text)).toContain(`[ref ${first.ref}]`);
	const restored = new OutputViews(artifacts);
	for (let i = 0; i < 2; i++) {
		expect((await restored.text(first.ref)).text).toBe(full);
		const repeated = await renderModelText(restored, [await restored.read(first.ref)]);
		expect(repeated.ref).not.toBe(first.ref);
		expect(body(repeated.text)).toBe(body(first.text));
	}
	const ids = new Set<string>();
	for (const value of [null, "", "same", "same"]) {
		const result = await renderModelText(views, [], { value });
		ids.add(result.ref);
		const contract = await artifacts.readResult(result.ref);
		expect(JSON.parse((await artifacts.readBuffer(contract.value_ref)).toString())).toEqual(value);
	}
	expect(ids.size).toBe(4);
	for (const size of [MODEL_TEXT_BYTES - 100, MODEL_TEXT_BYTES - 1, MODEL_TEXT_BYTES, MODEL_TEXT_BYTES + 1]) {
		const rendered = await renderModelText(views, ["a".repeat(size)], { header: "ok" });
		expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
		expect(rendered.text.startsWith("ok\n\n")).toBe(true);
		expect((await views.text(rendered.ref)).text).toBe("a".repeat(size));
	}
});

test("retains capture failure details and transfers only authorized full views", async () => {
	const { parent, child, system, artifacts } = await fixture();
	const childViews = new OutputViews(system.forAgent(child.id));
	const full = `capture incomplete\nα😀${"BODY".repeat(18000)}END`;
	const result = await renderModelText(childViews, [full]);
	const parentViews = new OutputViews(artifacts);
	await expect(parentViews.read(result.ref)).rejects.toMatchObject({ code: "permission_denied" });
	system.grantFromAgent(child.id, parent.id);
	expect((await parentViews.text(result.ref)).text).toBe(full);
	await expect(artifacts.get(result.ref)).rejects.toMatchObject({ code: "permission_denied" });
});

test("does not reinterpret user text or send binary content to the model", async () => {
	const { views, artifacts } = await fixture();
	const literal = "artifact://this-is-user-data";
	const data = await artifacts.putBuffer(Buffer.from([255, 0, 65]), { mimeType: "application/octet-stream" });
	const [prepared] = await views.print({ parts: [{ text: literal }, { ref: ref(data) }] });
	if (prepared.type !== "output_ref") throw new Error("Expected retained output");
	const rendered = await renderModelText(views, [prepared]);
	expect(rendered.text).toContain(literal);
	expect(rendered.text).toContain(`binary ${ref(data)}`);
	expect(rendered.text).not.toContain("/wBB");
	await expect(views.read(ref(data))).rejects.toMatchObject({ code: "unsupported_media_type" });
	await expect(views.read(ref(data), [0, 1])).rejects.toMatchObject({ code: "unsupported_media_type" });
	const binaryResult = await artifacts.putResult("/wBB", {}, "bytes", "references.read", { encoding: "base64" });
	expect((await views.text(binaryResult)).text).toContain(`binary ${binaryResult}`);
	expect((await views.text(binaryResult)).text).not.toContain("/wBB");
	const fullResult = await artifacts.putResult({ text: literal }, {}, "JSON", "web.fetch", {
		content: [{ type: "text", text: `[source web.fetch ${ref(data)}]` }],
	});
	expect((await views.text(fullResult)).text).toContain(`[source web.fetch ${ref(data)}]`);
});

test("selects full-display-relative UTF-8 ranges across segments in order", async () => {
	const { artifacts, views, system, child } = await fixture();
	const text = `α😀${"0123456789".repeat(5000)}尾`;
	const source = ref(await artifacts.putText(text));
	const rendered = await renderModelText(views, ["HEAD", { type: "output_ref", handle: source }, "TAIL"]);
	const full = `HEAD\n\n${text}\n\nTAIL`;
	const bytes = Buffer.from(full);
	const selected = await renderModelText(views, [await views.read(rendered.ref, [2, bytes.length - 2])]);
	expect(body(selected.text).startsWith("AD\n\nα😀")).toBe(true);
	expect(selected.text).toContain("UTF-8 bytes omitted after");
	expect((await views.text(selected.ref)).text).toBe(full.slice(2, -2));
	let recovered = "";
	for (let start = 0; start < bytes.length; start += 8000) {
		const end = Math.min(start + 8000, bytes.length);
		const page = await renderModelText(views, [await views.read(rendered.ref, [start, end])]);
		expect(page.truncated).toBe(false);
		recovered += body(page.text);
	}
	expect(recovered).toBe(full);
	expect(body((await renderModelText(views, [await views.read(source, [0, 6])])).text)).toBe("α😀");
	expect(body((await renderModelText(views, [await views.read(source, [6, 6])])).text)).toBe("");
	for (const span of [
		[0, 1],
		[1, 6],
		[-1, 6],
		[7, 6],
		[0, bytes.length],
		[0, 1.5],
	] as const)
		await expect(views.read(source, span)).rejects.toMatchObject({ code: "invalid_arguments" });
	const childViews = new OutputViews(system.forAgent(child.id));
	await expect(childViews.read(rendered.ref, [0, 6])).rejects.toMatchObject({ code: "permission_denied" });
});

test("keeps complete CRLF tail lines across segments and only reads the preview window", async () => {
	const { artifacts, views } = await fixture();
	const source = Array.from(
		{ length: 2000 },
		(_, i) => `${i.toString().padStart(4, "0")}: ${"指令😀".repeat(5)}\r\n`,
	).join("");
	const split = source.indexOf("\n") + 1;
	const first = ref(await artifacts.putText(source.slice(0, split)));
	const last = ref(await artifacts.putText(source.slice(split)));
	const [prepared] = await views.print({ parts: [{ ref: first }, { ref: last }] });
	if (prepared.type !== "output_ref") throw new Error("Expected view");
	const reads = vi.spyOn(artifacts, "get");
	const rendered = await renderModelText(views, [prepared]);
	expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
	expect(rendered.text).not.toContain("partial line");
	expect(reads.mock.calls.reduce((sum, [, options]) => sum + (options?.limit ?? 0), 0)).toBeLessThanOrEqual(
		MODEL_TEXT_BYTES,
	);
	const tail = body(rendered.text);
	expect(tail).toMatch(/^\d{4}: /);
	expect(tail).toMatch(/\r\n$/);
	expect(source.endsWith(tail)).toBe(true);
	expect(Buffer.byteLength(tail)).toBeGreaterThan(MODEL_TEXT_BYTES - 512);
	expect(rendered.text).toContain(`${Buffer.byteLength(source) - Buffer.byteLength(tail)} UTF-8 bytes omitted before`);
	expect((await views.text(rendered.ref)).text).toBe(source);
});
