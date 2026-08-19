import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { glob } from "glob";
import lockfile from "proper-lockfile";
import { assertReadable, assertWritable, type FileAccessPolicy, isInside } from "../access-policy.ts";
import { RiemannHostError } from "../errors.ts";
import { imageReadNote, type StoredModelImage, storeModelImage } from "../images.ts";
import { type JsonValue, type KernelHostResult, kernelHostResult } from "../kernel/types.ts";
import type { ArtifactStore } from "../state/artifacts.ts";
import type { RiemannStore } from "../state/store.ts";
import type { FunctionDefinition } from "./registry.ts";

interface SnapshotReference {
	$riemann: "text_snapshot_ref" | "image_snapshot_ref";
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

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
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

function globPath(path: string): string {
	return path.split(sep).join("/");
}

function isNoEntity(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
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

export class FileFunctions {
	private readonly policy: FileAccessPolicy;
	private readonly runId: string;
	private readonly store: RiemannStore;
	private readonly artifacts: ArtifactStore;

	constructor(policy: FileAccessPolicy, runId: string, store: RiemannStore, artifacts: ArtifactStore) {
		this.policy = policy;
		this.runId = runId;
		this.store = store;
		this.artifacts = artifacts;
	}

	/** Resolves an existing readable path, rejecting symlink escapes into unreadable locations. */
	private async resolveExisting(input: string): Promise<string> {
		const candidate = resolve(this.policy.cwd, input);
		assertReadable(this.policy, candidate, input);
		let canonical: string;
		try {
			canonical = await realpath(candidate);
		} catch (error) {
			if (isNoEntity(error)) throw new RiemannHostError("not_found", `Path does not exist: ${input}`);
			throw error;
		}
		assertReadable(this.policy, canonical, input);
		return canonical;
	}

	/** Resolves the destination of a new writable path, creating missing parent directories. */
	private async resolveNew(input: string): Promise<string> {
		const candidate = resolve(this.policy.cwd, input);
		assertWritable(this.policy, candidate, input);
		let ancestor = dirname(candidate);
		while (true) {
			try {
				const canonical = await realpath(ancestor);
				assertWritable(this.policy, canonical, input);
				break;
			} catch (error) {
				if (!isNoEntity(error)) throw error;
				const parent = dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
		await mkdir(dirname(candidate), { recursive: true });
		const parent = await realpath(dirname(candidate));
		assertWritable(this.policy, parent, input);
		return candidate;
	}

	private createSnapshot(path: string, text: string): JsonValue {
		const capability = randomBytes(32).toString("base64url");
		this.store.putFileCapability({ runId: this.runId, token: capability, path, contentHash: hashText(text) });
		return { $riemann: "text_snapshot", path, text, encoding: "utf-8", _capability: capability };
	}

	private createImageSnapshot(path: string, sourceBytes: Uint8Array, image: StoredModelImage): KernelHostResult {
		const capability = randomBytes(32).toString("base64url");
		this.store.putFileCapability({
			runId: this.runId,
			token: capability,
			path,
			contentHash: hashBytes(sourceBytes),
		});
		const note = imageReadNote(image.reference.mimeType, image.hints);
		return kernelHostResult(
			{
				$riemann: "image_snapshot",
				path,
				artifact: image.artifact,
				mime_type: image.reference.mimeType,
				source_size: sourceBytes.byteLength,
				_capability: capability,
				width: null,
				height: null,
			},
			[{ type: "text", text: note }, image.reference],
		);
	}

	private resolveSnapshot(value: JsonValue | undefined): {
		path: string;
		contentHash: string;
		capability: string;
		kind: "text" | "image";
	} {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new RiemannHostError("invalid_arguments", "snapshot must be a snapshot returned by fs.read or fs.edit");
		}
		const reference = value as Partial<SnapshotReference>;
		if (
			(reference.$riemann !== "text_snapshot_ref" && reference.$riemann !== "image_snapshot_ref") ||
			typeof reference.capability !== "string"
		) {
			throw new RiemannHostError("invalid_arguments", "snapshot capability is invalid");
		}
		const capability = this.store.getFileCapability(this.runId, reference.capability);
		if (!capability)
			throw new RiemannHostError("not_found", "Snapshot capability is unknown or belongs to another run");
		assertReadable(this.policy, capability.path, capability.path);
		assertWritable(this.policy, capability.path, capability.path);
		return {
			...capability,
			capability: reference.capability,
			kind: reference.$riemann === "text_snapshot_ref" ? "text" : "image",
		};
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

	private async globMatches(pattern: string, includeHidden: boolean): Promise<string[]> {
		return glob(pattern, {
			cwd: this.policy.cwd,
			dot: includeHidden,
			nodir: true,
			ignore: [".git/**", "node_modules/**"],
		});
	}

	/** Validates one glob result and returns its display path, or undefined when filtered out. */
	private async visiblePath(match: string): Promise<string | undefined> {
		try {
			const path = await this.resolveExisting(match);
			return isInside(this.policy.cwd, path) ? globPath(relative(this.policy.cwd, path)) : globPath(path);
		} catch {
			// Glob patterns may match unreadable paths or symlink escapes.
			return undefined;
		}
	}

	definitions(): FunctionDefinition[] {
		const pathDescription = "File path; relative paths resolve from the current working directory";
		return [
			{
				name: "read",
				namespace: "fs",
				description:
					"Read a UTF-8 text file or supported image. Text returns TextSnapshot; images return ImageSnapshot.",
				promptSnippet: "Read a UTF-8 file or image for inspection and safe snapshot-based operations.",
				parameters: [{ name: "path", description: pathDescription, type: "str", required: true }],
				returns: "TextSnapshot | ImageSnapshot",
				examples: [
					"snap = await fs.read(path='src/main.ts')",
					"image = await fs.read(path='/abs/path/screenshot.png')",
				],
				capability: "fs.read",
				promptGuidelines: [
					"Files: prefer fs.search / fs.glob / fs.edit over shell grep / find / sed; snapshot edits detect concurrent modification that exit codes cannot.",
				],
				handler: async (args) => {
					const path = await this.resolveExisting(requiredString(args, "path"));
					const bytes = await readFile(path);
					const detectedImage =
						bytes.byteLength === 0
							? undefined
							: await storeModelImage({
									artifacts: this.artifacts,
									bytes,
									name: basename(path),
								}).catch((error: unknown) => {
									if (error instanceof RiemannHostError && error.code === "unsupported_media_type")
										return undefined;
									throw error;
								});
					if (detectedImage) return this.createImageSnapshot(path, bytes, detectedImage);
					if (bytes.includes(0)) {
						throw new RiemannHostError("unsupported_media_type", `Cannot read binary file as UTF-8: ${path}`);
					}
					let text: string;
					try {
						text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
					} catch {
						throw new RiemannHostError(
							"unsupported_media_type",
							`File is neither UTF-8 text nor a supported image: ${path}`,
						);
					}
					return this.createSnapshot(path, text);
				},
			},
			{
				name: "glob",
				namespace: "fs",
				description: "List readable files matching one or more glob patterns without reading their contents.",
				promptSnippet: "Find files without reading them.",
				parameters: [
					{ name: "pattern", description: "Glob pattern", type: "str", required: true },
					{ name: "include_hidden", description: "Include dotfiles", type: "bool | None", required: false },
					{ name: "limit", description: "Maximum paths", type: "int | None", required: false },
				],
				returns: "list[str]",
				examples: ["await fs.glob(pattern='src/**/*.ts', limit=200)"],
				capability: "fs.read",
				handler: async (args) => {
					const matches = await this.globMatches(
						requiredString(args, "pattern"),
						optionalBoolean(args, "include_hidden", false),
					);
					const limit = Math.max(1, Math.min(optionalInteger(args, "limit", 200), 5_000));
					const visible: string[] = [];
					for (const match of matches.sort()) {
						if (visible.length >= limit) break;
						const path = await this.visiblePath(match);
						if (path) visible.push(path);
					}
					return visible;
				},
			},
			{
				name: "search",
				namespace: "fs",
				description: "Search readable UTF-8 files and return matching paths, line numbers, and lines.",
				promptSnippet: "Search file text with paths and line numbers.",
				parameters: [
					{
						name: "query",
						description: "Literal text or JavaScript regular expression",
						type: "str",
						required: true,
					},
					{ name: "glob", description: "File glob", type: "str | None", required: false },
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
				capability: "fs.read",
				handler: async (args) => {
					const query = requiredString(args, "query");
					const caseSensitive = optionalBoolean(args, "case_sensitive", true);
					const matcher = optionalBoolean(args, "regex", false)
						? new RegExp(query, caseSensitive ? "g" : "gi")
						: undefined;
					const needle = caseSensitive ? query : query.toLowerCase();
					const files = await this.globMatches(typeof args.glob === "string" ? args.glob : "**/*", false);
					const limit = Math.max(1, Math.min(optionalInteger(args, "limit", 100), 2_000));
					const hits: JsonValue[] = [];
					for (const file of files.sort()) {
						if (hits.length >= limit) break;
						let data: Buffer;
						try {
							const path = await this.resolveExisting(file);
							data = await readFile(path);
						} catch {
							// Glob results can be unreadable or escape through a symlink.
							continue;
						}
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
				namespace: "fs",
				description:
					"Apply non-overlapping character-offset operations to a TextSnapshot. Fails if the file changed since it was read.",
				promptSnippet: "Apply non-overlapping edits; fail if the file changed after reading.",
				parameters: [
					{
						name: "snapshot",
						description: "TextSnapshot from fs.read or fs.edit",
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
					"snap = await fs.edit(snapshot=snap, operations=[{'kind':'replace','start':10,'end':13,'text':'new'}])",
				],
				capability: "fs.write",
				promptGuidelines: ["Read before editing; pass the returned TextSnapshot to fs.edit or fs.remove."],
				handler: async (args) => {
					const snapshot = this.resolveSnapshot(args.snapshot);
					if (snapshot.kind !== "text") {
						throw new RiemannHostError("invalid_arguments", "fs.edit only accepts TextSnapshot");
					}
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
						const fragments: string[] = [];
						let unchangedEnd = current.length;
						for (const edit of edits) {
							fragments.push(current.slice(edit.end, unchangedEnd), edit.text);
							unchangedEnd = edit.start;
						}
						fragments.push(current.slice(0, unchangedEnd));
						const next = fragments.reverse().join("");
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
				namespace: "fs",
				description: "Create a new UTF-8 file atomically. Refuses to overwrite an existing path.",
				promptSnippet: "Create a new UTF-8 file atomically; never overwrite.",
				parameters: [
					{ name: "path", description: pathDescription, type: "str", required: true },
					{ name: "text", description: "Complete file content", type: "str", required: true },
				],
				returns: "TextSnapshot",
				capability: "fs.write",
				handler: async (args) => {
					const inputPath = requiredString(args, "path");
					const text = typeof args.text === "string" ? args.text : undefined;
					if (text === undefined) throw new RiemannHostError("invalid_arguments", "text must be a string");
					const path = await this.resolveNew(inputPath);
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
				namespace: "fs",
				description:
					"Delete the file represented by a TextSnapshot or ImageSnapshot. Fails if it changed after the snapshot.",
				promptSnippet: "Delete an unchanged snapshotted file.",
				parameters: [
					{
						name: "snapshot",
						description: "TextSnapshot or ImageSnapshot to delete",
						type: "TextSnapshot | ImageSnapshot",
						required: true,
					},
				],
				returns: "dict",
				capability: "fs.write",
				promptGuidelines: ["Read before editing; pass the returned TextSnapshot to fs.edit or fs.remove."],
				handler: async (args) => {
					const snapshot = this.resolveSnapshot(args.snapshot);
					const release = await lockfile.lock(snapshot.path, { realpath: false, stale: 30_000, retries: 8 });
					try {
						const current = await readFile(snapshot.path);
						if (hashBytes(current) !== snapshot.contentHash)
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
