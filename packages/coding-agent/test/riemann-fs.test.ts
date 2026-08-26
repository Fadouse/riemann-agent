import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test } from "vitest";
import { FULL_FILESYSTEM, fileAccessPolicy, resolveFilesystemSnapshot } from "../src/riemann/access-policy.ts";
import { FileFunctions } from "../src/riemann/functions/fs.ts";
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

function fullPolicy(cwd: string) {
	return fileAccessPolicy(cwd, FULL_FILESYSTEM);
}

describe("Riemann fs capabilities", () => {
	test("applies atomic snapshot edits and rejects stale capabilities", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-test-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-test", root);
		const files = new FileFunctions(fullPolicy(root), run.id, store, new ArtifactStore(store, run.id));
		const definitions = new Map(files.definitions().map((definition) => [definition.name, definition]));
		const create = definitions.get("create");
		const read = definitions.get("read");
		const edit = definitions.get("edit");
		if (!create || !read || !edit) throw new Error("fs definitions are incomplete");
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
						operations: [
							{ kind: "insert", at: 0, text: "[" },
							{ kind: "replace", start: 6, end: 10, text: "gamma" },
							{ kind: "insert", at: 10, text: "!" },
							{ kind: "delete", start: 10, end: 11 },
						],
					},
					signal,
				),
			);
			expect(edited.text).toBe("[alpha gamma!");
			expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("[alpha gamma!");

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

	test("reads, creates, and removes absolute paths outside the working directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-cwd-"));
		const outside = await mkdtemp(join(tmpdir(), "riemann-fs-outside-"));
		roots.push(root, outside);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-absolute", root);
		const definitions = new Map(
			new FileFunctions(fullPolicy(root), run.id, store, new ArtifactStore(store, run.id))
				.definitions()
				.map((definition) => [definition.name, definition]),
		);
		const read = definitions.get("read");
		const create = definitions.get("create");
		const remove = definitions.get("remove");
		if (!read || !create || !remove) throw new Error("fs definitions are incomplete");
		const signal = new AbortController().signal;
		try {
			const target = join(outside, "note.txt");
			await writeFile(target, "outside content\n");
			const snapshot = objectValue(await read.handler({ path: target }, signal));
			expect(snapshot.text).toBe("outside content\n");
			expect(snapshot.path).toBe(target);

			const created = objectValue(
				await create.handler({ path: join(outside, "new.txt"), text: "written\n" }, signal),
			);
			expect(await readFile(join(outside, "new.txt"), "utf8")).toBe("written\n");
			await remove.handler(
				{ snapshot: { $riemann: "text_snapshot_ref", capability: created._capability as string } },
				signal,
			);
			await expect(readFile(join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			store.close();
		}
	});

	test("enforces configured write roots without limiting reads", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-write-root-"));
		const outside = await mkdtemp(join(tmpdir(), "riemann-fs-write-outside-"));
		roots.push(root, outside);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-write-root", root);
		const policy = fileAccessPolicy(root, {
			read: ["/"],
			readExclude: [],
			write: [root],
			writeExclude: [],
		});
		const definitions = new Map(
			new FileFunctions(policy, run.id, store, new ArtifactStore(store, run.id))
				.definitions()
				.map((definition) => [definition.name, definition]),
		);
		const read = definitions.get("read");
		const create = definitions.get("create");
		if (!read || !create) throw new Error("fs definitions are incomplete");
		const signal = new AbortController().signal;
		try {
			await writeFile(join(outside, "secret.txt"), "readable but not writable\n");
			const snapshot = objectValue(await read.handler({ path: join(outside, "secret.txt") }, signal));
			expect(snapshot.text).toBe("readable but not writable\n");
			await expect(
				create.handler({ path: join(outside, "blocked.txt"), text: "blocked" }, signal),
			).rejects.toMatchObject({ code: "permission_denied" });
			await expect(readFile(join(outside, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			store.close();
		}
	});

	test("applies user-configured read and write exclusions", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-exclude-"));
		const privateDir = join(root, "private");
		roots.push(root);
		await writeFile(join(root, "public.txt"), "public\n");
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-exclude", root);
		await mkdir(privateDir, { recursive: true });
		await mkdir(join(root, "frozen"));
		const policy = fileAccessPolicy(root, {
			read: ["/"],
			readExclude: [privateDir],
			write: ["/"],
			writeExclude: [join(root, "frozen")],
		});
		const definitions = new Map(
			new FileFunctions(policy, run.id, store, new ArtifactStore(store, run.id))
				.definitions()
				.map((definition) => [definition.name, definition]),
		);
		const read = definitions.get("read");
		const create = definitions.get("create");
		const glob = definitions.get("glob");
		if (!read || !create || !glob) throw new Error("fs definitions are incomplete");
		const signal = new AbortController().signal;
		try {
			await writeFile(join(privateDir, "key.txt"), "private\n");
			await expect(read.handler({ path: join(privateDir, "key.txt") }, signal)).rejects.toMatchObject({
				code: "permission_denied",
			});
			await expect(
				create.handler({ path: join(root, "frozen", "blocked.txt"), text: "blocked" }, signal),
			).rejects.toMatchObject({ code: "permission_denied" });
			const matches = (await glob.handler({ pattern: "**/*", include_hidden: true }, signal)) as string[];
			expect(matches).toEqual(expect.arrayContaining(["public.txt"]));
			expect(matches.some((path) => path.includes("private"))).toBe(false);
		} finally {
			store.close();
		}
	});

	test("rejects writes through a symlinked parent outside the write roots", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-symlink-"));
		const outside = await mkdtemp(join(tmpdir(), "riemann-fs-symlink-outside-"));
		roots.push(root, outside);
		await symlink(outside, join(root, "escape"), "dir");
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-symlink", root);
		const policy = fileAccessPolicy(root, {
			read: ["/"],
			readExclude: [],
			write: [root],
			writeExclude: [],
		});
		const create = new FileFunctions(policy, run.id, store, new ArtifactStore(store, run.id))
			.definitions()
			.find((definition) => definition.name === "create");
		if (!create) throw new Error("fs.create is unavailable");
		try {
			await expect(
				create.handler({ path: "escape/blocked.txt", text: "blocked" }, new AbortController().signal),
			).rejects.toMatchObject({ code: "permission_denied" });
			await expect(readFile(join(outside, "blocked.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			store.close();
		}
	});

	test("does not search through file symlinks excluded by policy", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-search-"));
		const outside = await mkdtemp(join(tmpdir(), "riemann-fs-search-outside-"));
		roots.push(root, outside);
		await writeFile(join(root, "inside.txt"), "find-me inside\n");
		await writeFile(join(outside, "secret.txt"), "find-me secret\n");
		await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-search", root);
		const policy = fileAccessPolicy(root, {
			read: [root],
			readExclude: [],
			write: [root],
			writeExclude: [],
		});
		const search = new FileFunctions(policy, run.id, store, new ArtifactStore(store, run.id))
			.definitions()
			.find((definition) => definition.name === "search");
		if (!search) throw new Error("fs.search is unavailable");
		try {
			const result = await search.handler({ query: "find-me" }, new AbortController().signal);
			expect(result).toEqual([{ path: "inside.txt", line: 1, text: "find-me inside", truncated: false }]);
			const scoped = await search.handler({ query: "find-me", glob: "secret.txt" }, new AbortController().signal);
			expect(scoped).toEqual([]);
		} finally {
			store.close();
		}
	});

	test("resolves filesystem defaults and inheritance without implicit limits", () => {
		const full = FULL_FILESYSTEM;
		const main = resolveFilesystemSnapshot({ config: undefined, mode: "main", workspace: "/w", parent: undefined });
		expect([...main.read]).toEqual([...full.read]);
		expect([...main.write]).toEqual([...full.write]);

		const sharedChild = resolveFilesystemSnapshot({
			config: undefined,
			mode: "shared",
			workspace: "/w",
			parent: main,
		});
		expect([...sharedChild.read]).toEqual([...main.read]);
		expect([...sharedChild.write]).toEqual([...main.write]);

		const worktreeChild = resolveFilesystemSnapshot({
			config: undefined,
			mode: "worktree",
			workspace: "/wt/root",
			parent: main,
		});
		expect([...worktreeChild.read]).toEqual([...main.read]);
		expect([...worktreeChild.write]).toEqual(["/wt/root"]);

		const restrictedParent = { read: ["/tmp/p"], readExclude: [], write: ["/tmp/p"], writeExclude: [] };
		const inheritedChild = resolveFilesystemSnapshot({
			config: { read: "inherit", write: "inherit" },
			mode: "shared",
			workspace: "/tmp/p",
			parent: restrictedParent,
		});
		expect([...inheritedChild.read]).toEqual(["/tmp/p"]);
		expect([...inheritedChild.write]).toEqual(["/tmp/p"]);

		const explicitChild = resolveFilesystemSnapshot({
			config: { write: [], read: "inherit" },
			mode: "shared",
			workspace: "/tmp/p",
			parent: restrictedParent,
		});
		expect(explicitChild.write).toEqual([]);
	});

	test("reads supported images into model content and removes them by snapshot capability", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-image-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-image", root);
		const artifacts = new ArtifactStore(store, run.id);
		const definitions = new Map(
			new FileFunctions(fullPolicy(root), run.id, store, artifacts)
				.definitions()
				.map((definition) => [definition.name, definition]),
		);
		const read = definitions.get("read");
		const remove = definitions.get("remove");
		if (!read || !remove) throw new Error("fs definitions are incomplete");
		const imageBytes = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
			"base64",
		);
		await writeFile(join(root, "pixel.png"), imageBytes);
		try {
			const result = await read.handler({ path: "pixel.png" }, new AbortController().signal);
			expect(isKernelHostResult(result)).toBe(false);
			const snapshot = objectValue(result);
			expect(Value.Check(read.outputSchema, snapshot)).toBe(true);
			expect(snapshot).toMatchObject({
				$riemann: "image_snapshot",
				path: join(root, "pixel.png"),
				mime_type: "image/png",
				source_size: imageBytes.byteLength,
			});
			const artifact = objectValue(snapshot.artifact as JsonValue);
			expect(artifact.$riemann).toBe("artifact");
			expect((await artifacts.readBuffer(String(artifact.handle))).byteLength).toBeGreaterThan(0);

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
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-binary-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-binary", root);
		const read = new FileFunctions(fullPolicy(root), run.id, store, new ArtifactStore(store, run.id))
			.definitions()
			.find((definition) => definition.name === "read");
		if (!read) throw new Error("fs.read is unavailable");
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

	test("publishes six strict ABI v2 filesystem definitions", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-abi-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-abi", root);
		try {
			const definitions = new FileFunctions(
				fullPolicy(root),
				run.id,
				store,
				new ArtifactStore(store, run.id),
			).definitions();
			expect(definitions.map((definition) => definition.name)).toEqual([
				"read",
				"glob",
				"search",
				"edit",
				"create",
				"remove",
			]);
			for (const definition of definitions) {
				expect(definition.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
				expect(definition.outputSchema).toBeDefined();
				expect(definition.pythonReturnType).toEqual(expect.any(String));
				expect(definition.errors).toEqual(expect.any(Array));
				expect(definition.effects).toEqual(expect.any(Array));
				expect(definition.cancellation).toMatchObject({ supported: false });
				expect(definition.visibility).toBe("public");
				expect(definition.prompt).toMatchObject({ inventory: expect.any(String), example: expect.any(String) });
				expect(definition).not.toHaveProperty("parameters");
				expect(definition).not.toHaveProperty("returns");
			}
			const read = definitions.find((definition) => definition.name === "read");
			const remove = definitions.find((definition) => definition.name === "remove");
			expect(read?.outputSchema).toMatchObject({ $id: "FileSnapshot" });
			expect(JSON.stringify(read?.outputSchema)).toContain('"kind"');
			expect(remove?.outputSchema).toMatchObject({ $id: "RemovedFile" });
			expect(remove?.pythonReturnType).toBe("RemovedFile");
		} finally {
			store.close();
		}
	});

	test("preserves BOM hashes and applies end-exclusive Unicode code-point edits", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-unicode-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-unicode", root);
		const definitions = new Map(
			new FileFunctions(fullPolicy(root), run.id, store, new ArtifactStore(store, run.id))
				.definitions()
				.map((definition) => [definition.name, definition]),
		);
		const read = definitions.get("read");
		const edit = definitions.get("edit");
		const remove = definitions.get("remove");
		if (!read || !edit || !remove) throw new Error("fs definitions are incomplete");
		const signal = new AbortController().signal;
		await writeFile(join(root, "unicode.txt"), "\ufeffA😀𐐷Z", "utf8");
		try {
			const snapshot = objectValue(await read.handler({ path: "unicode.txt" }, signal));
			expect(Value.Check(read.outputSchema, snapshot)).toBe(true);
			expect(snapshot).toMatchObject({ kind: "text", text: "\ufeffA😀𐐷Z" });
			const reference: JsonValue = {
				$riemann: "text_snapshot_ref",
				capability: snapshot._capability as string,
			};
			await expect(
				edit.handler(
					{
						snapshot: reference,
						operations: [
							{ kind: "insert", at: 2, text: "left" },
							{ kind: "insert", at: 2, text: "right" },
						],
					},
					signal,
				),
			).rejects.toMatchObject({ code: "invalid_arguments" });
			expect(await readFile(join(root, "unicode.txt"), "utf8")).toBe("\ufeffA😀𐐷Z");

			const edited = objectValue(
				await edit.handler(
					{ snapshot: reference, operations: [{ kind: "replace", start: 2, end: 4, text: "X" }] },
					signal,
				),
			);
			expect(edited).toMatchObject({ kind: "text", text: "\ufeffAXZ" });
			expect(await readFile(join(root, "unicode.txt"), "utf8")).toBe("\ufeffAXZ");
			const removed = await remove.handler(
				{
					snapshot: {
						$riemann: "text_snapshot_ref",
						capability: edited._capability as string,
					},
				},
				signal,
			);
			expect(Value.Check(remove.outputSchema, removed)).toBe(true);
			expect(removed).toEqual({ $riemann: "removed_file", path: join(root, "unicode.txt"), removed: true });
		} finally {
			store.close();
		}
	});

	test("normalizes invalid regexes, rejects loose options, and skips invalid UTF-8 during search", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-search-validation-"));
		roots.push(root);
		await writeFile(join(root, "valid.txt"), "find valid\n");
		await writeFile(join(root, "invalid.txt"), Buffer.from([0x66, 0x69, 0x6e, 0x64, 0x80]));
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-search-validation", root);
		const definitions = new Map(
			new FileFunctions(fullPolicy(root), run.id, store, new ArtifactStore(store, run.id))
				.definitions()
				.map((definition) => [definition.name, definition]),
		);
		const glob = definitions.get("glob");
		const search = definitions.get("search");
		if (!glob || !search) throw new Error("fs definitions are incomplete");
		const signal = new AbortController().signal;
		try {
			await expect(search.handler({ query: "[", mode: "regex" }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
				message: "query must be a valid JavaScript regular expression",
			});
			await expect(search.handler({ query: "(a+)+$", mode: "regex" }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
				message: "regular expression uses unsupported backtracking constructs",
			});
			await expect(search.handler({ query: "find", glob: 42 }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(glob.handler({ pattern: "**/*", include_hidden: null }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(glob.handler({ pattern: "**/*", limit: 0 }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			expect(await search.handler({ query: "find" }, signal)).toEqual([
				{ path: "valid.txt", line: 1, text: "find valid", truncated: false },
			]);
		} finally {
			store.close();
		}
	});

	test("search reports canonical paths for symlink matches", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "riemann-fs-search-canonical-"));
		roots.push(root);
		await writeFile(join(root, "target.txt"), "canonical hit\n");
		await symlink(join(root, "target.txt"), join(root, "alias.txt"));
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("fs-search-canonical", root);
		const search = new FileFunctions(fullPolicy(root), run.id, store, new ArtifactStore(store, run.id))
			.definitions()
			.find((definition) => definition.name === "search");
		if (!search) throw new Error("fs.search is unavailable");
		try {
			expect(await search.handler({ query: "canonical", glob: "alias.txt" }, new AbortController().signal)).toEqual([
				{ path: "target.txt", line: 1, text: "canonical hit", truncated: false },
			]);
		} finally {
			store.close();
		}
	});
});
