import { createHash } from "node:crypto";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { RiemannHostError } from "../errors.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { PAGE_CURSOR_MIME, PAGE_MANIFEST_MIME } from "./references.ts";

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_PAGE_LIMIT = 100_000;
const coverageSchema = Type.Union([Type.Literal("complete"), Type.Literal("limited"), Type.Literal("unknown")]);
const skippedSchema = Type.Array(
	Type.Object(
		{ reason: Type.String({ minLength: 1 }), count: Type.Integer({ minimum: 1 }) },
		{ additionalProperties: false },
	),
);

export function pageSchema(items: TSchema): TSchema {
	return Type.Object(
		{
			$riemann: Type.Literal("page"),
			items: Type.Array(items),
			next_cursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
			coverage: coverageSchema,
			skipped: skippedSchema,
		},
		{ additionalProperties: false, $id: "Page" },
	);
}

interface PageOptions {
	limit: number;
	coverage: "complete" | "limited" | "unknown";
	skipped?: { reason: string; count: number }[];
}

interface Cursor {
	handle: string;
	runId: string;
	ownerId: string;
	operation: string;
	offset: number;
	limit: number;
}

const cursorSchema = Type.Object(
	{
		handle: Type.String({ minLength: 1 }),
		runId: Type.String({ minLength: 1 }),
		ownerId: Type.String(),
		operation: Type.String({ minLength: 1 }),
		offset: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT }),
	},
	{ additionalProperties: false },
);

const manifestSchema = Type.Object(
	{
		ownerId: Type.String(),
		operation: Type.String({ minLength: 1 }),
		limit: Type.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT }),
		items: Type.Array(Type.Unknown()),
		coverage: coverageSchema,
		skipped: skippedSchema,
	},
	{ additionalProperties: false },
);

function artifactHandle(artifact: JsonValue): string {
	if (
		typeof artifact !== "object" ||
		artifact === null ||
		Array.isArray(artifact) ||
		typeof artifact.handle !== "string"
	) {
		throw new RiemannHostError("artifact_error", "Invalid page artifact");
	}
	return artifact.handle;
}

/** Dedicated artifact media types distinguish issued cursors from ordinary JSON artifacts. */
export class PageStore {
	private readonly artifacts: ArtifactStore;
	private readonly ownerId: string;

	constructor(artifacts: ArtifactStore, ownerId: string) {
		this.artifacts = artifacts;
		this.ownerId = ownerId;
	}

	async create(operation: string, items: JsonValue[], options: PageOptions): Promise<JsonValue> {
		const manifest = {
			ownerId: this.ownerId,
			operation,
			items,
			limit: options.limit,
			coverage: options.coverage,
			skipped: options.skipped ?? [],
		};
		if (!Value.Check(manifestSchema, manifest))
			throw new RiemannHostError("invalid_arguments", "Invalid page snapshot options");
		if (items.length <= options.limit) {
			return {
				$riemann: "page",
				items: structuredClone(items),
				next_cursor: null,
				coverage: options.coverage,
				skipped: structuredClone(manifest.skipped),
			};
		}
		const encoded = JSON.stringify(manifest);
		if (Buffer.byteLength(encoded) > MAX_MANIFEST_BYTES)
			throw new RiemannHostError("response_too_large", "Page snapshot exceeds the manifest limit");
		const handle = artifactHandle(
			await this.artifacts.putText(encoded, { mimeType: PAGE_MANIFEST_MIME, name: "page-snapshot.json" }),
		);
		const metadata = this.artifacts.getMetadata(handle);
		// Decode the persisted representation so callers cannot mutate an issued snapshot.
		return this.slice(JSON.parse(encoded) as Record<string, JsonValue>, {
			handle,
			runId: metadata.runId,
			ownerId: this.ownerId,
			operation,
			offset: 0,
			limit: options.limit,
		});
	}

	private async readJson(handle: string, mimeType: string, maximumBytes: number): Promise<JsonValue> {
		const metadata = this.artifacts.getMetadata(handle);
		if (metadata.mimeType !== mimeType)
			throw new RiemannHostError("invalid_arguments", "Artifact is not an issued page cursor or snapshot");
		if (metadata.size > maximumBytes)
			throw new RiemannHostError("response_too_large", "Page artifact exceeds its read bound");
		const bytes = await this.artifacts.readBuffer(handle, maximumBytes);
		if (createHash("sha256").update(bytes).digest("hex") !== metadata.hash)
			throw new RiemannHostError("invalid_arguments", "Page artifact integrity check failed");
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as JsonValue;
		} catch {
			throw new RiemannHostError("invalid_arguments", "Invalid page artifact encoding");
		}
	}

	async next(cursor: string, authorize: (operation: string) => void): Promise<JsonValue> {
		const value = await this.readJson(cursor, PAGE_CURSOR_MIME, MAX_CURSOR_BYTES);
		if (!Value.Check(cursorSchema, value)) throw new RiemannHostError("invalid_arguments", "Invalid page cursor");
		const reference = value as unknown as Cursor;
		if (
			reference.ownerId !== this.ownerId ||
			reference.runId !== this.artifacts.getMetadata(cursor).runId ||
			reference.offset % reference.limit !== 0
		) {
			throw new RiemannHostError("invalid_arguments", "Page cursor does not match its owner, run or offset");
		}
		authorize(reference.operation);
		const manifestValue = await this.readJson(reference.handle, PAGE_MANIFEST_MIME, MAX_MANIFEST_BYTES);
		if (!Value.Check(manifestSchema, manifestValue))
			throw new RiemannHostError("invalid_arguments", "Invalid page snapshot");
		const manifest = manifestValue as Record<string, JsonValue>;
		if (
			this.artifacts.getMetadata(reference.handle).runId !== reference.runId ||
			manifest.ownerId !== this.ownerId ||
			manifest.operation !== reference.operation ||
			manifest.limit !== reference.limit ||
			!Array.isArray(manifest.items) ||
			reference.offset >= manifest.items.length
		) {
			throw new RiemannHostError("invalid_arguments", "Page cursor does not match its snapshot");
		}
		return this.slice(manifest, reference);
	}

	private async slice(manifest: Record<string, JsonValue>, reference: Cursor): Promise<JsonValue> {
		const items = manifest.items;
		if (!Array.isArray(items)) throw new RiemannHostError("invalid_arguments", "Invalid page snapshot items");
		const nextOffset = Math.min(items.length, reference.offset + reference.limit);
		let nextCursor: string | null = null;
		if (nextOffset < items.length) {
			const encoded = JSON.stringify({ ...reference, offset: nextOffset });
			if (Buffer.byteLength(encoded) > MAX_CURSOR_BYTES)
				throw new RiemannHostError("response_too_large", "Page cursor exceeds its size bound");
			nextCursor = artifactHandle(
				await this.artifacts.putText(encoded, { mimeType: PAGE_CURSOR_MIME, name: "page-cursor.json" }),
			);
		}
		return {
			$riemann: "page",
			items: items.slice(reference.offset, nextOffset),
			next_cursor: nextCursor,
			coverage: manifest.coverage,
			skipped: manifest.skipped,
		};
	}
}
