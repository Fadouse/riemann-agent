import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { glob } from "glob";
import lockfile from "proper-lockfile";
import { Type } from "typebox";
import { assertReadable, assertWritable, type FileAccessPolicy, isInside } from "../access-policy.ts";
import { RiemannHostError } from "../errors.ts";
import { type StoredModelImage, storeModelImage } from "../images.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { ArtifactStore } from "../state/artifacts.ts";
import { PageStore, pageSchema } from "../state/pages.ts";
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

const artifactSchema = Type.Object(
	{
		$riemann: Type.Literal("artifact"),
		handle: Type.String(),
		mime_type: Type.String(),
		size: Type.Integer({ minimum: 0 }),
		name: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false, $id: "Ref" },
);

const pathEntrySchema = Type.Object(
	{
		$riemann: Type.Literal("path_entry"),
		path: Type.String(),
		kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
	},
	{ additionalProperties: false, $id: "PathEntry" },
);

const textSnapshotSchema = Type.Object(
	{
		kind: Type.Literal("text"),
		$riemann: Type.Literal("text_snapshot"),
		path: Type.String(),
		text: Type.String(),
		encoding: Type.Literal("utf-8"),
		_capability: Type.String(),
	},
	{ additionalProperties: false, $id: "TextSnapshot" },
);

const imageSnapshotSchema = Type.Object(
	{
		kind: Type.Literal("image"),
		$riemann: Type.Literal("image_snapshot"),
		path: Type.String(),
		artifact: artifactSchema,
		mime_type: Type.String(),
		source_size: Type.Integer({ minimum: 0 }),
		_capability: Type.String(),
		width: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		height: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	},
	{ additionalProperties: false, $id: "ImageSnapshot" },
);

const fileSnapshotSchema = Type.Union([textSnapshotSchema, imageSnapshotSchema], { $id: "FileSnapshot" });

const textSnapshotReferenceSchema = Type.Object(
	{
		$riemann: Type.Literal("text_snapshot_ref"),
		capability: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const fileSnapshotReferenceSchema = Type.Union([
	textSnapshotReferenceSchema,
	Type.Object(
		{
			$riemann: Type.Literal("image_snapshot_ref"),
			capability: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

const editOperationSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("replace"),
			start: Type.Integer({ minimum: 0 }),
			end: Type.Integer({ minimum: 0 }),
			text: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("insert"),
			at: Type.Integer({ minimum: 0 }),
			text: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("delete"),
			start: Type.Integer({ minimum: 0 }),
			end: Type.Integer({ minimum: 0 }),
		},
		{ additionalProperties: false },
	),
]);

const removedFileSchema = Type.Object(
	{ $riemann: Type.Literal("removed_file"), path: Type.String(), removed: Type.Literal(true) },
	{ additionalProperties: false, $id: "RemovedFile" },
);

const noCancellation = {
	supported: false,
	description: "Filesystem operations do not observe cancellation after they start.",
} as const;

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
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new RiemannHostError("invalid_arguments", `${name} must be a boolean`);
	return value;
}

function optionalString(args: Record<string, JsonValue>, name: string, fallback: string): string {
	const value = args[name];
	if (value === undefined) return fallback;
	if (typeof value !== "string" || value.length === 0)
		throw new RiemannHostError("invalid_arguments", `${name} must be a non-empty string`);
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

function assertSafeRegex(pattern: string): void {
	if (pattern.length > 256)
		throw new RiemannHostError("invalid_arguments", "regular expression exceeds 256 characters");
	if (/\\[1-9]|\(\?[=!<]|\([^)]*(?:[+*]|\{\d+,?\d*\})[^)]*\)(?:[+*]|\{)/.test(pattern)) {
		throw new RiemannHostError("invalid_arguments", "regular expression uses unsupported backtracking constructs");
	}
}

export class FileFunctions {
	private readonly policy: FileAccessPolicy;
	private readonly runId: string;
	private readonly store: RiemannStore;
	private readonly artifacts: ArtifactStore;
	private readonly pages: PageStore;

	constructor(
		policy: FileAccessPolicy,
		runId: string,
		store: RiemannStore,
		artifacts: ArtifactStore,
		pages?: PageStore,
	) {
		this.policy = policy;
		this.runId = runId;
		this.store = store;
		this.artifacts = artifacts;
		this.pages = pages ?? new PageStore(artifacts, runId);
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

	private async openedPath(file: FileHandle, fallback: string): Promise<string> {
		const descriptorPath = process.platform === "linux" ? `/proc/self/fd/${file.fd}` : `/dev/fd/${file.fd}`;
		try {
			return await realpath(descriptorPath);
		} catch {
			const [opened, currentPath, canonical] = await Promise.all([file.stat(), stat(fallback), realpath(fallback)]);
			if (opened.dev !== currentPath.dev || opened.ino !== currentPath.ino) {
				throw new RiemannHostError("conflict", `Path changed while opening: ${fallback}`);
			}
			return canonical;
		}
	}

	private async readContents(file: FileHandle): Promise<Buffer> {
		const info = await file.stat();
		if (!info.isFile()) throw new RiemannHostError("unsupported_media_type", "Path is not a regular file");
		const chunks: Buffer[] = [];
		let total = 0;
		while (true) {
			const chunk = Buffer.allocUnsafe(64 * 1024);
			const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
		return Buffer.concat(chunks, total);
	}

	private async openReadable(input: string): Promise<{ path: string; file: FileHandle }> {
		const candidate = await this.resolveExisting(input);
		let file: FileHandle;
		try {
			file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if (isNoEntity(error)) throw new RiemannHostError("not_found", `Path does not exist: ${input}`);
			throw error;
		}
		try {
			const path = await this.openedPath(file, candidate);
			assertReadable(this.policy, path, input);
			return { path, file };
		} catch (error) {
			await file.close().catch(() => undefined);
			throw error;
		}
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
		return { kind: "text", $riemann: "text_snapshot", path, text, encoding: "utf-8", _capability: capability };
	}

	private createImageSnapshot(path: string, sourceBytes: Uint8Array, image: StoredModelImage): JsonValue {
		const capability = randomBytes(32).toString("base64url");
		this.store.putFileCapability({
			runId: this.runId,
			token: capability,
			path,
			contentHash: hashBytes(sourceBytes),
		});
		if (typeof image.artifact !== "object" || image.artifact === null || Array.isArray(image.artifact)) {
			throw new RiemannHostError("artifact_error", "Image artifact metadata is invalid");
		}
		return {
			kind: "image",
			$riemann: "image_snapshot",
			path,
			artifact: { ...image.artifact, $riemann: "artifact" },
			mime_type: image.sourceMimeType,
			source_size: sourceBytes.byteLength,
			_capability: capability,
			width: null,
			height: null,
		};
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
		for (let leftIndex = 0; leftIndex < edits.length; leftIndex += 1) {
			const left = edits[leftIndex];
			if (!left) continue;
			for (let rightIndex = leftIndex + 1; rightIndex < edits.length; rightIndex += 1) {
				const right = edits[rightIndex];
				if (!right) continue;
				if (left.kind === "insert" && right.kind === "insert" && left.start === right.start) {
					throw new RiemannHostError("invalid_arguments", "multiple inserts at the same offset are not allowed");
				}
				const leftContainsRight = left.start < right.start && right.start < left.end;
				const rightContainsLeft = right.start < left.start && left.start < right.end;
				const rangesOverlap =
					left.start < left.end && right.start < right.end && left.start < right.end && right.start < left.end;
				if (leftContainsRight || rightContainsLeft || rangesOverlap) {
					throw new RiemannHostError("invalid_arguments", "operations overlap");
				}
			}
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

	private async globMatches(pattern: string, includeHidden: boolean, onlyFiles: boolean): Promise<string[]> {
		return glob(pattern, {
			cwd: this.policy.cwd,
			dot: includeHidden,
			nodir: onlyFiles,
			ignore: [".git/**", "node_modules/**"],
		});
	}

	private displayPath(path: string): string {
		return isInside(this.policy.cwd, path) ? globPath(relative(this.policy.cwd, path)) : globPath(path);
	}

	definitions(): FunctionDefinition[] {
		const pathDescription = "File path; relative paths resolve from the current working directory";
		return [
			{
				name: "read",
				namespace: "fs",
				description:
					"Read a UTF-8 text file or supported image. Returns a discriminated FileSnapshot containing text or image metadata.",
				inputSchema: Type.Object(
					{ path: Type.String({ minLength: 1, description: pathDescription }) },
					{ additionalProperties: false },
				),
				outputSchema: fileSnapshotSchema,
				pythonReturnType: "FileSnapshot",
				errors: [
					{
						code: "limit_exceeded",
						description: "The run has exhausted its resource reference numbers.",
						retryable: false,
					},
					{ code: "invalid_arguments", description: "The path is empty or invalid.", retryable: false },
					{ code: "not_found", description: "The path does not exist.", retryable: false },
					{
						code: "permission_denied",
						description: "The path is outside readable policy roots.",
						retryable: false,
					},
					{ code: "image_decode_failed", description: "The image cannot be decoded.", retryable: false },
					{ code: "artifact_error", description: "Image artifact metadata is invalid.", retryable: false },
					{
						code: "conflict",
						description: "The readable path changed while opening.",
						retryable: false,
						recovery: "refresh",
					},
					{
						code: "unsupported_media_type",
						description: "The file is neither valid UTF-8 text nor a supported image.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "read", resource: "filesystem" },
					{ kind: "write", resource: "artifact-store" },
					{ kind: "write", resource: "capability-store" },
				],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Read a UTF-8 file or image for inspection and safe snapshot-based operations.",
					example: 'snap = await fs.read(path="src/main.ts")',
					guidelines: [
						"Files: prefer fs.search / fs.glob / fs.edit over shell grep / find / sed; snapshot edits detect concurrent modification that exit codes cannot.",
					],
				},
				capability: "fs.read",
				handler: async (args) => {
					const opened = await this.openReadable(requiredString(args, "path"));
					const path = opened.path;
					let bytes: Buffer;
					try {
						bytes = await this.readContents(opened.file);
					} finally {
						await opened.file.close();
					}
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
						text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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
				description: "List readable files and directories matching a glob pattern as PathEntry records.",
				inputSchema: Type.Object(
					{
						pattern: Type.String({ minLength: 1, description: "Glob pattern" }),
						include_hidden: Type.Optional(Type.Boolean({ default: false, description: "Include dotfiles" })),
						kind: Type.Optional(
							Type.Union([Type.Literal("any"), Type.Literal("file"), Type.Literal("directory")], {
								default: "any",
								description: "Entry kinds to include",
							}),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: pageSchema(pathEntrySchema),
				pythonReturnType: "Page[PathEntry]",
				errors: [
					{
						code: "limit_exceeded",
						description: "The run has exhausted its resource reference numbers.",
						retryable: false,
					},
					{ code: "artifact_error", description: "The result snapshot artifact is invalid.", retryable: false },
					{ code: "invalid_arguments", description: "The pattern or options are invalid.", retryable: false },
				],
				effects: [
					{ kind: "read", resource: "filesystem-metadata" },
					{ kind: "write", resource: "artifact-store" },
				],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Find readable file and directory entries without reading file contents.",
					example: 'entries = await fs.glob(pattern="src/*"); print(entries)',
				},
				capability: "fs.read",
				handler: async (args) => {
					const kind = optionalString(args, "kind", "any");
					if (kind !== "any" && kind !== "file" && kind !== "directory")
						throw new RiemannHostError("invalid_arguments", "kind must be any, file, or directory");
					const matches = await this.globMatches(
						requiredString(args, "pattern"),
						optionalBoolean(args, "include_hidden", false),
						kind === "file",
					);
					const visible: JsonValue[] = [];
					let skippedFiles = 0;
					for (const match of matches.sort()) {
						let path: string;
						let entryKind: "file" | "directory";
						try {
							path = await this.resolveExisting(match);
							const info = await stat(path);
							if (!info.isFile() && !info.isDirectory()) {
								skippedFiles += 1;
								continue;
							}
							entryKind = info.isDirectory() ? "directory" : "file";
						} catch {
							// Glob patterns may match unreadable paths or symlink escapes.
							skippedFiles += 1;
							continue;
						}
						if (kind !== "any" && kind !== entryKind) continue;
						visible.push({ $riemann: "path_entry", path: this.displayPath(path) || ".", kind: entryKind });
					}
					const skipped = [];
					if (skippedFiles) skipped.push({ reason: "unreadable_or_unavailable_file", count: skippedFiles });
					return this.pages.create("fs.glob", visible, {
						coverage: skipped.length ? "limited" : "complete",
						skipped,
					});
				},
			},
			{
				name: "search",
				namespace: "fs",
				description: "Search readable UTF-8 files and return canonical paths, line numbers, and matching lines.",
				inputSchema: Type.Object(
					{
						query: Type.String({ minLength: 1, description: "Literal text or JavaScript regular expression" }),
						glob: Type.Optional(Type.String({ minLength: 1, default: "**/*", description: "File glob" })),
						mode: Type.Optional(
							Type.Union([Type.Literal("literal"), Type.Literal("regex")], {
								default: "literal",
								description: "Literal or regular-expression matching",
							}),
						),
						case_sensitive: Type.Optional(
							Type.Boolean({ default: true, description: "Use case-sensitive matching" }),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: pageSchema(
					Type.Object(
						{
							$riemann: Type.Literal("search_match"),
							path: Type.String(),
							line: Type.Integer({ minimum: 1 }),
							text: Type.String(),
							truncated: Type.Boolean(),
						},
						{ additionalProperties: false },
					),
				),
				pythonReturnType: "Page[SearchMatch]",
				errors: [
					{
						code: "limit_exceeded",
						description: "The run has exhausted its resource reference numbers.",
						retryable: false,
					},
					{ code: "artifact_error", description: "The result snapshot artifact is invalid.", retryable: false },
					{
						code: "invalid_arguments",
						description: "The query, regular expression, or options are invalid.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "read", resource: "filesystem" },
					{ kind: "write", resource: "artifact-store" },
				],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Search file text with canonical paths and line numbers.",
					example: 'matches = await fs.search(query="needle", glob="src/**/*.ts"); print(matches)',
				},
				capability: "fs.read",
				handler: async (args) => {
					const query = requiredString(args, "query");
					const caseSensitive = optionalBoolean(args, "case_sensitive", true);
					let matcher: RegExp | undefined;
					if (optionalString(args, "mode", "literal") === "regex") {
						assertSafeRegex(query);
						try {
							matcher = new RegExp(query, caseSensitive ? "g" : "gi");
						} catch {
							throw new RiemannHostError(
								"invalid_arguments",
								"query must be a valid JavaScript regular expression",
							);
						}
					}
					const needle = caseSensitive ? query : query.toLowerCase();
					const files = await this.globMatches(optionalString(args, "glob", "**/*"), false, true);
					const hits: JsonValue[] = [];
					const skippedCounts = new Map<string, number>();
					const skip = (reason: string) => skippedCounts.set(reason, (skippedCounts.get(reason) ?? 0) + 1);
					for (const file of files.sort()) {
						let data: Buffer;
						let displayPath: string;
						try {
							const opened = await this.openReadable(file);
							try {
								displayPath = this.displayPath(opened.path);
								data = await this.readContents(opened.file);
							} finally {
								await opened.file.close();
							}
						} catch {
							// Glob results can be unreadable or escape through a symlink.
							skip("unreadable_or_unavailable_file");
							continue;
						}
						if (data.includes(0)) {
							skip("binary_file");
							continue;
						}
						let text: string;
						try {
							text = new TextDecoder("utf-8", { fatal: true }).decode(data);
						} catch {
							skip("invalid_utf8_file");
							continue;
						}
						// Visit lines without retaining a second, whole-file array of strings.
						// Include the final empty line and strip CR only when it precedes LF.
						let start = 0;
						for (let lineNumber = 1; start <= text.length; lineNumber += 1) {
							const newline = text.indexOf("\n", start);
							const end = newline === -1 ? text.length : newline;
							const line = text.slice(start, newline !== -1 && text.charCodeAt(end - 1) === 13 ? end - 1 : end);
							start = newline === -1 ? text.length + 1 : newline + 1;
							if (matcher) matcher.lastIndex = 0;
							const matched = matcher
								? matcher.test(line)
								: (caseSensitive ? line : line.toLowerCase()).includes(needle);
							if (matched) {
								hits.push({
									$riemann: "search_match",
									path: displayPath,
									line: lineNumber,
									text: line,
									truncated: false,
								});
							}
						}
					}
					const skipped = [...skippedCounts].map(([reason, count]) => ({ reason, count }));
					return this.pages.create("fs.search", hits, {
						coverage: skipped.length ? "limited" : "complete",
						skipped,
					});
				},
			},
			{
				name: "edit",
				namespace: "fs",
				description:
					"Apply non-overlapping, end-exclusive Unicode code-point edits to a TextSnapshot. Fails if the file changed since it was read.",
				inputSchema: Type.Object(
					{
						snapshot: textSnapshotReferenceSchema,
						operations: Type.Array(editOperationSchema, {
							minItems: 1,
							description: "Replace, insert, or delete operations against the snapshot text",
						}),
					},
					{ additionalProperties: false },
				),
				outputSchema: textSnapshotSchema,
				pythonReturnType: "TextSnapshot",
				errors: [
					{
						code: "invalid_arguments",
						description: "The snapshot or edit operations are invalid or overlap.",
						retryable: false,
					},
					{ code: "not_found", description: "The snapshot capability or file does not exist.", retryable: false },
					{
						code: "permission_denied",
						description: "The file is outside writable policy roots.",
						retryable: false,
					},
					{
						code: "conflict",
						description:
							"The file changed after the snapshot was created. Read a fresh snapshot before editing or removing.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "read", resource: "filesystem" },
					{ kind: "write", resource: "filesystem" },
					{ kind: "write", resource: "capability-store" },
				],
				idempotency: "conditional",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Apply Unicode code-point edits; fail if the file changed after reading.",
					example:
						'await fs.edit(snapshot=snap, operations=[{"kind":"replace","start":10,"end":13,"text":"new"}])',
					guidelines: ["Read before editing; pass the returned TextSnapshot to fs.edit or fs.remove."],
				},
				capability: "fs.write",
				handler: async (args) => {
					const snapshot = this.resolveSnapshot(args.snapshot);
					if (snapshot.kind !== "text") {
						throw new RiemannHostError("invalid_arguments", "fs.edit only accepts TextSnapshot");
					}
					const release = await lockfile.lock(snapshot.path, { realpath: false, stale: 30_000, retries: 8 });
					try {
						let currentBytes: Buffer;
						try {
							if ((await realpath(snapshot.path)) !== snapshot.path) throw new Error("path changed");
							currentBytes = await readFile(snapshot.path);
						} catch {
							throw new RiemannHostError("conflict", `File path changed since snapshot: ${snapshot.path}`);
						}
						if (hashBytes(currentBytes) !== snapshot.contentHash) {
							throw new RiemannHostError("conflict", `File changed since snapshot: ${snapshot.path}`, {
								path: snapshot.path,
							});
						}
						const current = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(currentBytes);
						const codePoints = Array.from(current);
						const edits = this.parseEdits(args.operations, codePoints.length);
						const fragments: string[] = [];
						let unchangedEnd = codePoints.length;
						for (const edit of edits) {
							fragments.push(codePoints.slice(edit.end, unchangedEnd).join(""), edit.text);
							unchangedEnd = edit.start;
						}
						fragments.push(codePoints.slice(0, unchangedEnd).join(""));
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
				description: "Exclusively create a new UTF-8 file. Refuses to overwrite an existing path.",
				inputSchema: Type.Object(
					{
						path: Type.String({ minLength: 1, description: pathDescription }),
						text: Type.String({ description: "Complete file content" }),
					},
					{ additionalProperties: false },
				),
				outputSchema: textSnapshotSchema,
				pythonReturnType: "TextSnapshot",
				errors: [
					{ code: "invalid_arguments", description: "The path or text is invalid.", retryable: false },
					{
						code: "permission_denied",
						description: "The path is outside writable policy roots.",
						retryable: false,
					},
					{ code: "conflict", description: "The destination already exists.", retryable: false },
				],
				effects: [
					{ kind: "write", resource: "filesystem" },
					{ kind: "write", resource: "capability-store" },
				],
				idempotency: "non-idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Exclusively create a new UTF-8 file; never overwrite.",
					example: 'await fs.create(path="src/new.ts", text="export {};\\n")',
				},
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
					const canonical = await realpath(path);
					return this.createSnapshot(canonical, text);
				},
			},
			{
				name: "remove",
				namespace: "fs",
				description:
					"Delete the file represented by a TextSnapshot or ImageSnapshot. Fails if it changed after the snapshot.",
				inputSchema: Type.Object({ snapshot: fileSnapshotReferenceSchema }, { additionalProperties: false }),
				outputSchema: removedFileSchema,
				pythonReturnType: "RemovedFile",
				errors: [
					{ code: "invalid_arguments", description: "The snapshot reference is invalid.", retryable: false },
					{ code: "not_found", description: "The snapshot capability or file does not exist.", retryable: false },
					{
						code: "permission_denied",
						description: "The file is outside writable policy roots.",
						retryable: false,
					},
					{
						code: "conflict",
						description:
							"The file changed after the snapshot was created. Read a fresh snapshot before editing or removing.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "read", resource: "filesystem" },
					{ kind: "delete", resource: "filesystem" },
				],
				idempotency: "conditional",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Delete an unchanged snapshotted file.",
					example: "await fs.remove(snapshot=snap)",
					guidelines: ["Read before editing; pass the returned TextSnapshot to fs.edit or fs.remove."],
				},
				capability: "fs.write",
				handler: async (args) => {
					const snapshot = this.resolveSnapshot(args.snapshot);
					const release = await lockfile.lock(snapshot.path, { realpath: false, stale: 30_000, retries: 8 });
					try {
						let current: Buffer;
						try {
							if ((await realpath(snapshot.path)) !== snapshot.path) throw new Error("path changed");
							current = await readFile(snapshot.path);
						} catch {
							throw new RiemannHostError("conflict", `File path changed since snapshot: ${snapshot.path}`);
						}
						if (hashBytes(current) !== snapshot.contentHash)
							throw new RiemannHostError("conflict", `File changed since snapshot: ${snapshot.path}`);
						await unlink(snapshot.path).catch((error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT")
								throw new RiemannHostError("conflict", `File path changed since snapshot: ${snapshot.path}`);
							throw error;
						});
						await syncDirectory(dirname(snapshot.path));
						return { $riemann: "removed_file", path: snapshot.path, removed: true };
					} finally {
						await release();
					}
				},
			},
		];
	}
}
