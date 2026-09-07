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

test("retains omitted rows and only advances text that fits the final model message", async () => {
	const { artifacts, views } = await fixture();
	const rows = Array.from({ length: 8 }, (_, i) => ({ path: `row-${i}`, text: "中文😀".repeat(8) }));
	const prepared = await views.prepare({ $riemann: "output_view", value: rows, sources: [] });
	expect(prepared.type).toBe("output_ref");
	if (prepared.type !== "output_ref") throw new Error("Expected deferred view");
	const first = await renderModelText(views, ["header".repeat(10000), prepared]);
	expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
	expect(first.text).not.toContain("row-0");
	expect(first.more).toMatch(/^r[0-9a-z]+$/);
	let cursor = first.more;
	let combined = first.text;
	const restored = new OutputViews(artifacts);
	for (let steps = 0; cursor && steps < 100; steps++) {
		const next = await renderModelText(restored, [await restored.more(cursor)]);
		expect(Buffer.byteLength(next.text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
		expect(next.text).not.toContain("�");
		combined += next.text;
		cursor = next.more;
	}
	expect(cursor).toBeUndefined();
	for (const row of rows) expect(combined.match(new RegExp(row.path, "g"))).toHaveLength(1);
	expect(combined).not.toContain("artifact://");
});

test("continues retained stdout without losing capture status and transfers authorized views", async () => {
	const { parent, child, system, artifacts } = await fixture();
	const childArtifacts = system.forAgent(child.id);
	const childViews = new OutputViews(childArtifacts);
	const full = `α😀${"BODY".repeat(18000)}END`;
	const source = await childArtifacts.putText(full);
	const prepared = await childViews.prepare({
		$riemann: "output_view",
		value: { stdout: "α😀", stdout_capture_truncated: true },
		sources: [
			{ path: ["stdout"], handle: ref(source), offset_bytes: Buffer.byteLength("α😀"), capture_truncated: true },
		],
	});
	if (prepared.type !== "output_ref") throw new Error("Expected view");
	const parentViews = new OutputViews(artifacts);
	await expect(parentViews.more(prepared.handle)).rejects.toMatchObject({ code: "permission_denied" });
	system.grantFromAgent(child.id, parent.id);
	let cursor: string | undefined = prepared.handle;
	let output = "";
	for (let steps = 0; cursor && steps < 100; steps++) {
		const next = await renderModelText(parentViews, [await parentViews.more(cursor)]);
		output += next.more ? next.text.replace(/\n\[more r[0-9a-z]+\]$/, "") : next.text;
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
	const prepared = await views.prepare({
		$riemann: "output_view",
		value: { stdout: literal },
		sources: [{ path: ["stdout"], handle: ref(data), offset_bytes: 0, capture_truncated: false }],
	});
	if (prepared.type !== "output_ref") throw new Error("Expected retained output");
	const rendered = await renderModelText(views, [prepared]);
	expect(rendered.text).toContain(literal);
	expect(rendered.text).toContain(`binary resource ${ref(data)}`);
	expect(rendered.text).not.toContain("/wBB");
	await expect(views.more(ref(data))).rejects.toMatchObject({ code: "unsupported_media_type" });
});
