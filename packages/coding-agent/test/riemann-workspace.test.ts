import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceFunctions } from "../src/riemann/functions/workspace.ts";
import { isKernelHostResult, type JsonValue, type KernelHostResult } from "../src/riemann/kernel/types.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function objectValue(value: JsonValue | KernelHostResult): Record<string, JsonValue> {
	const wireValue = isKernelHostResult(value) ? value.value : value;
	if (typeof wireValue !== "object" || wireValue === null || Array.isArray(wireValue))
		throw new Error("Expected object result");
	return wireValue;
}

describe("Riemann workspace capabilities", () => {
	test("applies atomic snapshot edits and rejects stale capabilities", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-workspace-test-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("workspace-test", root);
		const workspace = new WorkspaceFunctions(root, run.id, store, new ArtifactStore(store, run.id));
		const definitions = new Map(workspace.definitions().map((definition) => [definition.name, definition]));
		const create = definitions.get("create");
		const read = definitions.get("read");
		const edit = definitions.get("edit");
		if (!create || !read || !edit) throw new Error("Workspace definitions are incomplete");
		const signal = new AbortController().signal;

		try {
			const created = objectValue(await create.handler({ path: "src/value.txt", text: "alpha beta\n" }, signal));
			expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("alpha beta\n");
			const capability = created._capability;
			expect(typeof capability).toBe("string");
			const reference: JsonValue = { $riemann: "text_snapshot_ref", capability: capability as string };
			const edited = objectValue(
				await edit.handler(
					{
						snapshot: reference,
						operations: [{ kind: "replace", start: 6, end: 10, text: "gamma" }],
					},
					signal,
				),
			);
			expect(edited.text).toBe("alpha gamma\n");
			expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("alpha gamma\n");

			const current = objectValue(await read.handler({ path: "src/value.txt" }, signal));
			await writeFile(join(root, "src", "value.txt"), "concurrent change\n", "utf8");
			await expect(
				edit.handler(
					{
						snapshot: { $riemann: "text_snapshot_ref", capability: current._capability as string },
						operations: [{ kind: "delete", start: 0, end: 5 }],
					},
					signal,
				),
			).rejects.toMatchObject({ code: "conflict" });
			expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("concurrent change\n");
		} finally {
			store.close();
		}
	});

	test("rejects file creation outside the workspace before touching the parent", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-workspace-boundary-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("boundary-test", root);
		const create = new WorkspaceFunctions(root, run.id, store, new ArtifactStore(store, run.id))
			.definitions()
			.find((definition) => definition.name === "create");
		if (!create) throw new Error("workspace.create is unavailable");
		try {
			await expect(
				create.handler({ path: "../escape.txt", text: "blocked" }, new AbortController().signal),
			).rejects.toMatchObject({ code: "permission_denied" });
		} finally {
			store.close();
		}
	}, 10_000);

	test("rejects writes through a symlinked parent outside the workspace", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "riemann-workspace-symlink-"));
		const outside = await mkdtemp(join(tmpdir(), "riemann-workspace-outside-"));
		roots.push(root, outside);
		await symlink(outside, join(root, "escape"), "dir");
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("symlink-test", root);
		const create = new WorkspaceFunctions(root, run.id, store, new ArtifactStore(store, run.id))
			.definitions()
			.find((definition) => definition.name === "create");
		if (!create) throw new Error("workspace.create is unavailable");
		try {
			await expect(
				create.handler({ path: "escape/blocked.txt", text: "blocked" }, new AbortController().signal),
			).rejects.toMatchObject({ code: "permission_denied" });
			await expect(readFile(join(outside, "blocked.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			store.close();
		}
	});

	test("does not search through file symlinks outside the workspace", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "riemann-workspace-search-"));
		const outside = await mkdtemp(join(tmpdir(), "riemann-workspace-search-outside-"));
		roots.push(root, outside);
		await writeFile(join(root, "inside.txt"), "find-me inside\n");
		await writeFile(join(outside, "secret.txt"), "find-me secret\n");
		await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("search-symlink-test", root);
		const search = new WorkspaceFunctions(root, run.id, store, new ArtifactStore(store, run.id))
			.definitions()
			.find((definition) => definition.name === "search");
		if (!search) throw new Error("workspace.search is unavailable");
		try {
			const result = await search.handler({ query: "find-me" }, new AbortController().signal);
			expect(result).toEqual([{ path: "inside.txt", line: 1, text: "find-me inside" }]);
		} finally {
			store.close();
		}
	});
	test("excludes nested Riemann state from workspace host operations", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-workspace-protected-state-"));
		roots.push(root);
		const agentDir = join(root, ".riemann", "agent");
		await mkdir(agentDir, { recursive: true });
		const store = new RiemannStore(agentDir);
		const run = store.openRun("protected-state-test", root);
		await Promise.all([
			writeFile(join(root, "visible.txt"), "visible\n"),
			writeFile(join(agentDir, "auth.json"), "RIEMANN_PRIVATE_CREDENTIAL\n"),
		]);
		const definitions = new Map(
			new WorkspaceFunctions(root, run.id, store, new ArtifactStore(store, run.id), [agentDir])
				.definitions()
				.map((definition) => [definition.name, definition]),
		);
		const read = definitions.get("read");
		const glob = definitions.get("glob");
		const search = definitions.get("search");
		const create = definitions.get("create");
		if (!read || !glob || !search || !create) throw new Error("Workspace definitions are incomplete");
		const signal = new AbortController().signal;
		try {
			await expect(read.handler({ path: ".riemann/agent/auth.json" }, signal)).rejects.toMatchObject({
				code: "permission_denied",
			});
			await expect(
				create.handler({ path: ".riemann/agent/injected.txt", text: "blocked" }, signal),
			).rejects.toMatchObject({ code: "permission_denied" });
			const matches = await glob.handler({ pattern: "**/*", include_hidden: true }, signal);
			expect(matches).toEqual(expect.arrayContaining(["visible.txt"]));
			expect((matches as JsonValue[]).some((path) => String(path).includes(".riemann/agent"))).toBe(false);
			expect(await glob.handler({ pattern: `${agentDir}/**/*`, include_hidden: true }, signal)).toEqual([]);
			expect(await search.handler({ query: "RIEMANN_PRIVATE_CREDENTIAL" }, signal)).toEqual([]);
			const visible = objectValue(await read.handler({ path: "visible.txt" }, signal));
			expect(visible.text).toBe("visible\n");
		} finally {
			store.close();
		}
	});

	test("reads supported images into model content and removes them by snapshot capability", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-workspace-image-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("image-test", root);
		const artifacts = new ArtifactStore(store, run.id);
		const definitions = new Map(
			new WorkspaceFunctions(root, run.id, store, artifacts)
				.definitions()
				.map((definition) => [definition.name, definition]),
		);
		const read = definitions.get("read");
		const remove = definitions.get("remove");
		if (!read || !remove) throw new Error("Workspace definitions are incomplete");
		const imageBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		);
		await writeFile(join(root, "pixel.png"), imageBytes);
		try {
			const result = await read.handler({ path: "pixel.png" }, new AbortController().signal);
			expect(isKernelHostResult(result)).toBe(true);
			if (!isKernelHostResult(result)) throw new Error("Expected image model content");
			const snapshot = objectValue(result);
			expect(snapshot).toMatchObject({
				$riemann: "image_snapshot",
				path: join(root, "pixel.png"),
				mime_type: "image/png",
				source_size: imageBytes.byteLength,
			});
			expect(result.modelContent[0]).toMatchObject({ type: "text", text: expect.stringContaining("Read image") });
			expect(result.modelContent[1]).toMatchObject({ type: "image_ref", mimeType: "image/png" });
			const reference = result.modelContent[1];
			if (reference?.type !== "image_ref") throw new Error("Expected image reference");
			expect((await artifacts.readBuffer(reference.artifactHandle)).byteLength).toBeGreaterThan(0);

			await remove.handler(
				{ snapshot: { $riemann: "image_snapshot_ref", capability: snapshot._capability as string } },
				new AbortController().signal,
			);
			await expect(readFile(join(root, "pixel.png"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			store.close();
		}
	});

	test("rejects unsupported binary files instead of decoding them as text", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-workspace-binary-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("binary-test", root);
		const read = new WorkspaceFunctions(root, run.id, store, new ArtifactStore(store, run.id))
			.definitions()
			.find((definition) => definition.name === "read");
		if (!read) throw new Error("workspace.read is unavailable");
		await writeFile(join(root, "empty.txt"), "");
		const empty = objectValue(await read.handler({ path: "empty.txt" }, new AbortController().signal));
		expect(empty.text).toBe("");
		await writeFile(join(root, "data.bin"), Buffer.from([0, 255, 1, 2]));
		try {
			await expect(read.handler({ path: "data.bin" }, new AbortController().signal)).rejects.toMatchObject({
				code: "unsupported_media_type",
			});
		} finally {
			store.close();
		}
	});
});
