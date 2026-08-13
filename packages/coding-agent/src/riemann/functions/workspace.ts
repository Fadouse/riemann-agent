import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { glob } from "glob";
import lockfile from "proper-lockfile";
import { RiemannHostError } from "../errors.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { RiemannStore } from "../state/store.ts";
import type { FunctionDefinition } from "./registry.ts";

interface TextSnapshotReference {
	$riemann: "text_snapshot_ref";
	capability: string;
}

interface TextEdit {
	kind: "replace" | "insert" | "delete";
	start: number;
	end: number;
	text: string;
}

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function requiredString(args: Record<string, JsonValue>, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || value.length === 0)
		throw new RiemannHostError("invalid_arguments", `${name} must be a non-empty string`);
	return value;
}

function optionalBoolean(args: Record<string, JsonValue>, name: string, fallback: boolean): boolean {
	const value = args[name];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "boolean") throw new RiemannHostError("invalid_arguments", `${name} must be a boolean`);
	return value;
}

function optionalInteger(args: Record<string, JsonValue>, name: string, fallback: number): number {
	const value = args[name];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value))
		throw new RiemannHostError("invalid_arguments", `${name} must be an integer`);
	return value;
}

function isInside(root: string, path: string): boolean {
	const pathFromRoot = relative(root, path);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
	);
}

async function syncDirectory(path: string): Promise<void> {
	try {
		const directory = await open(path, constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} catch {
		// Directory fsync is unavailable on some supported platforms.
	}
}

export class WorkspaceFunctions {
	private readonly root: string;
	private readonly runId: string;
	private readonly store: RiemannStore;

	constructor(root: string, runId: string, store: RiemannStore) {
		this.root = resolve(root);
		this.runId = runId;
		this.store = store;
	}

	private async resolvePath(input: string): Promise<string> {
		const candidate = resolve(this.root, input);
		if (!isInside(this.root, candidate))
			throw new RiemannHostError("permission_denied", `Path is outside the workspace: ${input}`);
		const canonical = await realpath(candidate);
		if (!isInside(this.root, canonical))
			throw new RiemannHostError("permission_denied", `Path resolves outside the workspace: ${input}`);
		return canonical;
	}

	private async resolveNewPath(input: string): Promise<string> {
		const candidate = resolve(this.root, input);
		if (!isInside(this.root, candidate))
			throw new RiemannHostError("permission_denied", `Path is outside the workspace: ${input}`);
		let ancestor = dirname(candidate);
		while (true) {
			try {
				const canonical = await realpath(ancestor);
				if (!isInside(this.root, canonical))
					throw new RiemannHostError("permission_denied", `Parent resolves outside the workspace: ${input}`);
				break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				const parent = dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
		await mkdir(dirname(candidate), { recursive: true });
		const parent = await realpath(dirname(candidate));
		if (!isInside(this.root, parent))
			throw new RiemannHostError("permission_denied", `Parent resolves outside the workspace: ${input}`);
		return candidate;
	}

	private createSnapshot(path: string, text: string): JsonValue {
		const capability = randomBytes(32).toString("base64url");
		this.store.putFileCapability({ runId: this.runId, token: capability, path, contentHash: hashText(text) });
		return { $riemann: "text_snapshot", path, text, encoding: "utf-8", _capability: capability };
	}

	private resolveSnapshot(value: JsonValue | undefined): { path: string; contentHash: string; capability: string } {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new RiemannHostError(
				"invalid_arguments",
				"snapshot must be a TextSnapshot returned by workspace.read or workspace.edit",
			);
		}
		const reference = value as Partial<TextSnapshotReference>;
		if (reference.$riemann !== "text_snapshot_ref" || typeof reference.capability !== "string") {
			throw new RiemannHostError("invalid_arguments", "snapshot capability is invalid");
		}
		const capability = this.store.getFileCapability(this.runId, reference.capability);
		if (!capability)
			throw new RiemannHostError("not_found", "Snapshot capability is unknown or belongs to another run");
		return { ...capability, capability: reference.capability };
	}

	private parseEdits(value: JsonValue | undefined, textLength: number): TextEdit[] {
		if (!Array.isArray(value) || value.length === 0)
			throw new RiemannHostError("invalid_arguments", "operations must be a non-empty list");
		const edits: TextEdit[] = [];
		for (const operation of value) {
			if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
				throw new RiemannHostError("invalid_arguments", "each operation must be an object");
			}
			const kind = operation.kind;
			if (kind !== "replace" && kind !== "insert" && kind !== "delete") {
				throw new RiemannHostError("invalid_arguments", "operation.kind must be replace, insert, or delete");
			}
			const start = kind === "insert" ? operation.at : operation.start;
			const end = kind === "insert" ? operation.at : operation.end;
			const replacement = kind === "delete" ? "" : operation.text;
			if (
				typeof start !== "number" ||
				!Number.isInteger(start) ||
				typeof end !== "number" ||
				!Number.isInteger(end)
			) {
				throw new RiemannHostError("invalid_arguments", "operation offsets must be integers");
			}
			if (start < 0 || end < start || end > textLength) {
				throw new RiemannHostError(
					"invalid_arguments",
					`operation range ${start}:${end} is outside 0:${textLength}`,
				);
			}
			if (typeof replacement !== "string")
				throw new RiemannHostError("invalid_arguments", "operation.text must be a string");
			edits.push({ kind, start, end, text: replacement });
		}
		edits.sort((left, right) => right.start - left.start || right.end - left.end);
		for (let index = 1; index < edits.length; index += 1) {
			const previous = edits[index - 1];
			const current = edits[index];
			if (previous && current && current.end > previous.start)
				throw new RiemannHostError("invalid_arguments", "operations overlap");
		}
		return edits;
	}

	private async writeAtomically(path: string, text: string, mode: number): Promise<void> {
		const temporary = join(dirname(path), `.${randomUUID()}.riemann.tmp`);
		const file = await open(temporary, "wx", mode);
		try {
			await file.writeFile(text, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await chmod(temporary, mode);
			await rename(temporary, path);
			await syncDirectory(dirname(path));
		} finally {
			await rm(temporary, { force: true });
		}
	}

	definitions(): FunctionDefinition[] {
		return [
			{
				name: "read",
				namespace: "workspace",
				description: "Read a UTF-8 file and return an immutable TextSnapshot carrying a CAS edit capability.",
				promptSnippet: "Read a UTF-8 file for inspection and safe snapshot-based edits.",
				parameters: [{ name: "path", description: "Workspace-relative path", type: "str", required: true }],
				returns: "TextSnapshot",
				examples: ["snap = await workspace.read(path='src/main.ts')", "display(snap.lines(40, 90))"],
				capability: "workspace.read",
				handler: async (args) => {
					const path = await this.resolvePath(requiredString(args, "path"));
					const text = await readFile(path, "utf8");
					return this.createSnapshot(path, text);
				},
			},
			{
				name: "glob",
				namespace: "workspace",
				description: "List workspace files matching one or more glob patterns without reading their contents.",
				promptSnippet: "Find workspace files without reading them.",
				parameters: [
					{
						name: "pattern",
						description: "Glob string or list is represented as a comma-separated brace glob",
						type: "str",
						required: true,
					},
					{ name: "include_hidden", description: "Include dotfiles", type: "bool | None", required: false },
					{ name: "limit", description: "Maximum paths", type: "int | None", required: false },
				],
				returns: "list[str]",
				examples: ["await workspace.glob(pattern='src/**/*.ts', limit=200)"],
				capability: "workspace.read",
				handler: async (args) => {
					const matches = await glob(requiredString(args, "pattern"), {
						cwd: this.root,
						dot: optionalBoolean(args, "include_hidden", false),
						nodir: true,
						ignore: [".git/**", "node_modules/**"],
					});
					return matches.sort().slice(0, Math.max(1, Math.min(optionalInteger(args, "limit", 200), 5_000)));
				},
			},
			{
				name: "search",
				namespace: "workspace",
				description: "Search UTF-8 workspace files and return matching paths, line numbers, and lines.",
				promptSnippet: "Search workspace text with paths and line numbers.",
				parameters: [
					{
						name: "query",
						description: "Literal text or JavaScript regular expression",
						type: "str",
						required: true,
					},
					{ name: "pattern", description: "File glob", type: "str | None", required: false },
					{
						name: "regex",
						description: "Treat query as a regular expression",
						type: "bool | None",
						required: false,
					},
					{
						name: "case_sensitive",
						description: "Use case-sensitive matching",
						type: "bool | None",
						required: false,
					},
					{ name: "limit", description: "Maximum matches", type: "int | None", required: false },
				],
				returns: "list[dict]",
				capability: "workspace.read",
				handler: async (args) => {
					const query = requiredString(args, "query");
					const caseSensitive = optionalBoolean(args, "case_sensitive", true);
					const matcher = optionalBoolean(args, "regex", false)
						? new RegExp(query, caseSensitive ? "g" : "gi")
						: undefined;
					const needle = caseSensitive ? query : query.toLowerCase();
					const files = await glob(typeof args.pattern === "string" ? args.pattern : "**/*", {
						cwd: this.root,
						dot: false,
						nodir: true,
						ignore: [".git/**", "node_modules/**"],
					});
					const limit = Math.max(1, Math.min(optionalInteger(args, "limit", 100), 2_000));
					const hits: JsonValue[] = [];
					for (const file of files.sort()) {
						if (hits.length >= limit) break;
						const data = await readFile(join(this.root, file));
						if (data.includes(0)) continue;
						const lines = data.toString("utf8").split(/\r?\n/);
						for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
							const line = lines[index] ?? "";
							if (matcher) matcher.lastIndex = 0;
							const matched = matcher
								? matcher.test(line)
								: (caseSensitive ? line : line.toLowerCase()).includes(needle);
							if (matched) hits.push({ path: file, line: index + 1, text: line });
						}
					}
					return hits;
				},
			},
			{
				name: "edit",
				namespace: "workspace",
				description:
					"Apply non-overlapping character-offset operations to a TextSnapshot. Fails if the file changed since it was read.",
				promptSnippet: "Apply non-overlapping edits; fail if the file changed after reading.",
				parameters: [
					{
						name: "snapshot",
						description: "TextSnapshot from workspace.read or workspace.edit",
						type: "TextSnapshot",
						required: true,
					},
					{
						name: "operations",
						description:
							"replace/delete {start,end,...} or insert {at,text} operations against the snapshot text",
						type: "list[dict]",
						required: true,
					},
				],
				returns: "TextSnapshot",
				examples: [
					"snap = await workspace.edit(snapshot=snap, operations=[{'kind':'replace','start':10,'end':13,'text':'new'}])",
				],
				capability: "workspace.write",
				promptGuidelines: [
					"Read before editing; pass the returned TextSnapshot to workspace.edit or workspace.remove.",
				],
				handler: async (args) => {
					const snapshot = this.resolveSnapshot(args.snapshot);
					const release = await lockfile.lock(snapshot.path, { realpath: false, stale: 30_000, retries: 8 });
					try {
						const current = await readFile(snapshot.path, "utf8");
						const currentHash = hashText(current);
						if (currentHash !== snapshot.contentHash) {
							throw new RiemannHostError("conflict", `File changed since snapshot: ${snapshot.path}`, {
								path: snapshot.path,
							});
						}
						const edits = this.parseEdits(args.operations, current.length);
						let next = current;
						for (const edit of edits) next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
						const info = await stat(snapshot.path);
						await this.writeAtomically(snapshot.path, next, info.mode);
						return this.createSnapshot(snapshot.path, next);
					} finally {
						await release();
					}
				},
			},
			{
				name: "create",
				namespace: "workspace",
				description: "Create a new UTF-8 file atomically. Refuses to overwrite an existing path.",
				promptSnippet: "Create a new UTF-8 file atomically; never overwrite.",
				parameters: [
					{ name: "path", description: "Workspace-relative path", type: "str", required: true },
					{ name: "text", description: "Complete file content", type: "str", required: true },
				],
				returns: "TextSnapshot",
				capability: "workspace.write",
				handler: async (args) => {
					const inputPath = requiredString(args, "path");
					const text = typeof args.text === "string" ? args.text : undefined;
					if (text === undefined) throw new RiemannHostError("invalid_arguments", "text must be a string");
					const path = await this.resolveNewPath(inputPath);
					const file = await open(path, "wx", 0o644).catch((error: NodeJS.ErrnoException) => {
						if (error.code === "EEXIST")
							throw new RiemannHostError("conflict", `Path already exists: ${inputPath}`);
						throw error;
					});
					try {
						await file.writeFile(text, "utf8");
						await file.sync();
					} catch (error) {
						await file.close().catch(() => undefined);
						await unlink(path).catch(() => undefined);
						throw error;
					}
					await file.close();
					await syncDirectory(dirname(path));
					return this.createSnapshot(path, text);
				},
			},
			{
				name: "remove",
				namespace: "workspace",
				description: "Delete the file represented by a TextSnapshot. Fails if it changed after the snapshot.",
				promptSnippet: "Delete an unchanged snapshotted file.",
				parameters: [
					{ name: "snapshot", description: "TextSnapshot to delete", type: "TextSnapshot", required: true },
				],
				returns: "dict",
				capability: "workspace.write",
				promptGuidelines: [
					"Read before editing; pass the returned TextSnapshot to workspace.edit or workspace.remove.",
				],
				handler: async (args) => {
					const snapshot = this.resolveSnapshot(args.snapshot);
					const release = await lockfile.lock(snapshot.path, { realpath: false, stale: 30_000, retries: 8 });
					try {
						const current = await readFile(snapshot.path, "utf8");
						if (hashText(current) !== snapshot.contentHash)
							throw new RiemannHostError("conflict", `File changed since snapshot: ${snapshot.path}`);
						await unlink(snapshot.path);
						await syncDirectory(dirname(snapshot.path));
						return { path: snapshot.path, removed: true };
					} finally {
						await release();
					}
				},
			},
		];
	}
}
