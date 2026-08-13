import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WorkspaceFunctions } from "../src/riemann/functions/workspace.ts";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function objectValue(value: JsonValue): Record<string, JsonValue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object result");
	return value;
}

describe("Riemann workspace capabilities", () => {
	test("applies atomic snapshot edits and rejects stale capabilities", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-workspace-test-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("workspace-test", root);
		const workspace = new WorkspaceFunctions(root, run.id, store);
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
		const create = new WorkspaceFunctions(root, run.id, store)
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
		const create = new WorkspaceFunctions(root, run.id, store)
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
		const search = new WorkspaceFunctions(root, run.id, store)
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
});
