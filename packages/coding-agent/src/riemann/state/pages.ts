import { createHash } from "node:crypto";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { RiemannHostError } from "../errors.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { PAGE_CURSOR_MIME, PAGE_MANIFEST_MIME } from "./references.ts";

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
	limit?: number;
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
		limit: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

const manifestSchema = Type.Object(
	{
		ownerId: Type.String(),
		operation: Type.String({ minLength: 1 }),
		limit: Type.Integer({ minimum: 1 }),
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
		const limit = options.limit ?? 100;
		const manifest = {
			ownerId: this.ownerId,
			operation,
			items: structuredClone(items),
			limit,
			coverage: options.coverage,
			skipped: options.skipped ?? [],
		};
		if (!Value.Check(manifestSchema, manifest))
			throw new RiemannHostError("invalid_arguments", "Invalid page snapshot options");
		if (items.length <= limit) {
			return {
				$riemann: "page",
				items: manifest.items,
				next_cursor: null,
				coverage: options.coverage,
				skipped: structuredClone(manifest.skipped),
			};
		}
		const handle = artifactHandle(await this.artifacts.putJson(manifest, "page-snapshot.json", PAGE_MANIFEST_MIME));
		const metadata = this.artifacts.getMetadata(handle);
		return this.slice(manifest, {
			handle,
			runId: metadata.runId,
			ownerId: this.ownerId,
			operation,
			offset: 0,
			limit,
		});
	}

	private async readJson(handle: string, mimeType: string): Promise<JsonValue> {
		const metadata = this.artifacts.getMetadata(handle);
		if (metadata.mimeType !== mimeType)
			throw new RiemannHostError("invalid_arguments", "Artifact is not an issued page cursor or snapshot");
		const bytes = await this.artifacts.readBuffer(handle);
		if (createHash("sha256").update(bytes).digest("hex") !== metadata.hash)
			throw new RiemannHostError("invalid_arguments", "Page artifact integrity check failed");
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as JsonValue;
		} catch {
			throw new RiemannHostError("invalid_arguments", "Invalid page artifact encoding");
		}
	}

	async next(cursor: string, authorize: (operation: string) => void): Promise<JsonValue> {
		const value = await this.readJson(cursor, PAGE_CURSOR_MIME);
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
		const manifestValue = await this.readJson(reference.handle, PAGE_MANIFEST_MIME);
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
			nextCursor = artifactHandle(
				await this.artifacts.putText(encoded, { mimeType: PAGE_CURSOR_MIME, name: "page-cursor.json" }),
			);
		}
		return {
			$riemann: "page",
			items: structuredClone(items.slice(reference.offset, nextOffset)),
			next_cursor: nextCursor,
			coverage: manifest.coverage,
			skipped: manifest.skipped,
		};
	}
}
