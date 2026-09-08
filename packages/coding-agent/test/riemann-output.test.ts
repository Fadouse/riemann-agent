import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FULL_FILESYSTEM } from "../src/riemann/access-policy.ts";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { MODEL_TEXT_BYTES, OutputViews, renderModelText } from "../src/riemann/output.ts";
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

test("shows head and tail while retaining an immutable, lossless middle reference", async () => {
	const { artifacts, views } = await fixture();
	const rows = Array.from({ length: 8 }, (_, i) => ({ path: `row-${i}`, text: "中文😀".repeat(8) }));
	const [prepared] = await views.print({ parts: [{ text: JSON.stringify(rows) }] });
	expect(prepared.type).toBe("output_ref");
	if (prepared.type !== "output_ref") throw new Error("Expected deferred view");
	const first = await renderModelText(views, ["header".repeat(10000), { ...prepared, separator: "\n\n" }]);
	expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
	expect(first.text).toContain("row-0");
	expect(first.text).toMatch(/^header/);
	expect(first.text.endsWith(JSON.stringify(rows))).toBe(true);
	const halves = first.text.split(`\n[more ${first.more}]\n`);
	expect(halves).toHaveLength(2);
	expect(Buffer.byteLength(halves[0])).toBe((MODEL_TEXT_BYTES - 128) / 2);
	expect(Buffer.byteLength(halves[1])).toBeGreaterThanOrEqual((MODEL_TEXT_BYTES - 128) / 2 - 3);
	expect(first.more).toMatch(/^r[0-9a-z]+$/);
	let cursor = first.more;
	let combined = first.text;
	const restored = new OutputViews(artifacts);
	const repeated = await renderModelText(restored, [await restored.read(first.more!)]);
	const repeatedAgain = await renderModelText(restored, [await restored.read(first.more!)]);
	expect(repeatedAgain).toEqual(repeated);
	for (let steps = 0; cursor && steps < 100; steps++) {
		const next = await renderModelText(restored, [await restored.read(cursor)]);
		expect(Buffer.byteLength(next.text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
		expect(next.text).not.toContain("�");
		combined = combined.replace(`\n[more ${cursor}]\n`, () => next.text);
		cursor = next.more;
	}
	expect(cursor).toBeUndefined();
	for (const row of rows) expect(combined.match(new RegExp(row.path, "g"))).toHaveLength(1);
	expect(combined).not.toContain("artifact://");
	expect(combined).toBe(`${"header".repeat(10000)}\n\n${JSON.stringify(rows)}`);
	for (const size of [MODEL_TEXT_BYTES - 1, MODEL_TEXT_BYTES, MODEL_TEXT_BYTES + 1]) {
		const rendered = await renderModelText(views, ["a".repeat(size)]);
		expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(16_384);
		if (size <= MODEL_TEXT_BYTES) expect(rendered).toEqual({ text: "a".repeat(size) });
		else expect(rendered.more).toBeDefined();
	}
});

test("continues retained stdout without losing capture status and transfers authorized views", async () => {
	const { parent, child, system, artifacts } = await fixture();
	const childArtifacts = system.forAgent(child.id);
	const childViews = new OutputViews(childArtifacts);
	const full = `α😀${"BODY".repeat(18000)}END`;
	const source = await childArtifacts.putText(full);
	const [prepared] = await childViews.print({ parts: [{ text: "capture incomplete\n" }, { ref: ref(source) }] });
	if (prepared.type !== "output_ref") throw new Error("Expected view");
	const parentViews = new OutputViews(artifacts);
	await expect(parentViews.read(prepared.handle)).rejects.toMatchObject({ code: "permission_denied" });
	system.grantFromAgent(child.id, parent.id);
	let cursor: string | undefined = prepared.handle;
	let output = `\n[more ${cursor}]\n`;
	for (let steps = 0; cursor && steps < 100; steps++) {
		const next = await renderModelText(parentViews, [await parentViews.read(cursor)]);
		output = output.replace(`\n[more ${cursor}]\n`, () => next.text);
		cursor = next.more;
	}
	expect(cursor).toBeUndefined();
	expect(output).toContain("capture incomplete");
	expect(output.match(/α😀/g)).toHaveLength(1);
	expect(output.match(/END/g)).toHaveLength(1);
	expect(output.match(/BODY/g)).toHaveLength(18000);
	await expect(artifacts.get(prepared.handle)).rejects.toMatchObject({ code: "permission_denied" });
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
});

test("selects exact reference-relative UTF-8 spans across segments and pages them in order", async () => {
	const { artifacts, views, system, child } = await fixture();
	const body = `α😀${"0123456789".repeat(5000)}尾`;
	const source = ref(await artifacts.putText(body));
	const combined = await views.combine(["HEAD", { type: "output_ref", handle: source }, "TAIL"]);
	const full = `HEAD\n\n${body}\n\nTAIL`;
	const bytes = Buffer.from(full);
	const selected = await views.read(combined, [2, bytes.length - 2]);
	let rendered = await renderModelText(views, [selected]);
	let recovered = "";
	for (let steps = 0; steps < 10; steps++) {
		expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(16_384);
		expect(rendered.text).not.toContain("�");
		recovered += rendered.more ? rendered.text.replace(/\n\[more r[0-9a-z]+\]$/, "") : rendered.text;
		if (!rendered.more) break;
		expect(rendered.text.endsWith(`\n[more ${rendered.more}]`)).toBe(true);
		rendered = await renderModelText(views, [await views.read(rendered.more)]);
	}
	expect(rendered.more).toBeUndefined();
	expect(recovered).toBe(bytes.subarray(2, bytes.length - 2).toString("utf8"));
	expect((await renderModelText(views, [await views.read(source, [0, 6])])).text).toBe("α😀");
	expect((await renderModelText(views, [await views.read(combined, [4, 6])])).text).toBe("\n\n");
	expect((await renderModelText(views, [await views.read(source, [6, 6])])).text).toBe("");
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
	await expect(childViews.read(source, [0, 6])).rejects.toMatchObject({ code: "permission_denied" });
	await expect(childViews.read(combined, [0, 6])).rejects.toMatchObject({ code: "permission_denied" });
});
