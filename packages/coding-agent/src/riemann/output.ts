import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { RiemannHostError } from "./errors.ts";
import type { JsonValue, KernelModelContent } from "./kernel/types.ts";
import type { ArtifactStore } from "./state/artifacts.ts";
import { OUTPUT_VIEW_MIME } from "./state/references.ts";

/** A UTF-8 byte budget must not split a code point or materialize the full encoded input. */
export function utf8Prefix(text: string, bytes: number): string {
	let used = 0;
	let end = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character);
		if (used + size > bytes) break;
		used += size;
		end += character.length;
	}
	return text.slice(0, end);
}

export const MODEL_TEXT_BYTES = 50 * 1024;
const SourceSchema = Type.Object(
	{
		path: Type.Array(Type.String()),
		handle: Type.String({ minLength: 1 }),
		offset_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		capture_truncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);
const EnvelopeSchema = Type.Object(
	{
		$riemann: Type.Literal("output_view"),
		value: Type.Unknown(),
		sources: Type.Array(SourceSchema),
	},
	{ additionalProperties: false },
);
const SegmentSchema = Type.Object(
	{
		handle: Type.String({ minLength: 1 }),
		offset_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		prefix: Type.String(),
		stop_after: Type.Boolean(),
	},
	{ additionalProperties: false },
);
const ViewSchema = Type.Object(
	{
		segments: Type.Array(SegmentSchema),
	},
	{ additionalProperties: false },
);
type Segment = Static<typeof SegmentSchema>;
export type OutputPart = string | Extract<KernelModelContent, { type: "output_ref" }>;

function handleOf(value: JsonValue): string {
	if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.handle !== "string") {
		throw new RiemannHostError("internal_error", "Artifact store returned no resource reference");
	}
	return value.handle;
}

/** Durable display cursors contain data references, never producer code or commands. */
export class OutputViews {
	private readonly artifacts: ArtifactStore;
	constructor(artifacts: ArtifactStore) {
		this.artifacts = artifacts;
	}

	private async literal(text: string, stopAfter = false): Promise<Segment> {
		const handle = handleOf(await this.artifacts.putText(text, { name: "output-text.txt" }));
		return { handle, offset_bytes: 0, prefix: "", stop_after: stopAfter };
	}

	private async save(segments: Segment[]): Promise<string> {
		const value = { segments };
		if (!Value.Check(ViewSchema, value)) throw new RiemannHostError("invalid_output", "Invalid output segments");
		return handleOf(await this.artifacts.putJson(value, "output-cursor.json", OUTPUT_VIEW_MIME));
	}

	private async load(handle: string): Promise<Segment[]> {
		const metadata = this.artifacts.getMetadata(handle);
		if (metadata.mimeType !== OUTPUT_VIEW_MIME) {
			// A diagnostic or retained text artifact can be read from its beginning.
			this.artifacts.assertPublic(handle);
			if (
				!metadata.mimeType.startsWith("text/") &&
				!metadata.mimeType.includes("json") &&
				!metadata.mimeType.includes("xml")
			) {
				throw new RiemannHostError(
					"unsupported_media_type",
					"output.more reads retained text, not binary data; use Artifact.read in Python",
				);
			}
			return [{ handle, offset_bytes: 0, prefix: "", stop_after: false }];
		}
		const bytes = await this.artifacts.readBuffer(handle);
		if (createHash("sha256").update(bytes).digest("hex") !== metadata.hash) {
			throw new RiemannHostError("invalid_arguments", "Output cursor integrity check failed");
		}
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new RiemannHostError("invalid_arguments", "Invalid output cursor encoding");
		}
		if (!Value.Check(ViewSchema, value)) throw new RiemannHostError("invalid_arguments", "Invalid output cursor");
		return value.segments;
	}

	async prepare(envelope: JsonValue): Promise<KernelModelContent> {
		if (!Value.Check(EnvelopeSchema, envelope)) {
			throw new RiemannHostError(
				"invalid_arguments",
				"Use output.show(value=..., fields=...) to construct an output view",
			);
		}
		const preview = envelope.value;
		const retained =
			typeof preview === "string"
				? await this.artifacts.putText(preview, { name: "output-text.txt" })
				: await this.artifacts.putJson(preview as JsonValue, "output-value.json");
		let visible = "";
		const pending: Segment[] = [];
		for (const source of envelope.sources) {
			this.artifacts.assertPublic(source.handle);
			const metadata = this.artifacts.getMetadata(source.handle);
			const label = source.path.join(".") || "text";
			if (source.capture_truncated) visible += `\n[${label}: capture incomplete; only retained bytes are available]`;
			const text =
				metadata.mimeType.startsWith("text/") ||
				metadata.mimeType.includes("json") ||
				metadata.mimeType.includes("xml");
			if (!text) {
				visible += `\n[${label}: binary resource ${source.handle}; read bytes with Artifact.read]`;
				continue;
			}
			if (source.offset_bytes > metadata.size)
				throw new RiemannHostError("invalid_arguments", "Output preview offset exceeds its retained source");
			if (source.offset_bytes < metadata.size)
				pending.push({
					handle: source.handle,
					offset_bytes: source.offset_bytes,
					prefix: `\n${label} (continued):\n`,
					stop_after: false,
				});
		}
		const initial: Segment = { handle: handleOf(retained), offset_bytes: 0, prefix: "", stop_after: false };
		return {
			type: "output_ref",
			handle: await this.save([initial, ...(visible ? [await this.literal(visible)] : []), ...pending]),
		};
	}

	async more(ref: string): Promise<Extract<KernelModelContent, { type: "output_ref" }>> {
		await this.load(ref); // Validate authorization and kind before accepting the operation.
		return { type: "output_ref", handle: ref };
	}

	async read(ref: string, maxBytes: number): Promise<{ text: string; next?: string }> {
		const segments = await this.load(ref);
		const parts: string[] = [];
		let remaining = Math.max(0, maxBytes);
		while (segments.length && remaining >= 4) {
			const segment = segments[0];
			if (segment.prefix) {
				const prefix = utf8Prefix(segment.prefix, remaining);
				parts.push(prefix);
				remaining -= Buffer.byteLength(prefix);
				segment.prefix = segment.prefix.slice(prefix.length);
				if (segment.prefix || remaining < 4) break;
			}
			const slice = await this.artifacts.get(segment.handle, {
				offset: segment.offset_bytes,
				limit: Math.min(remaining, 1048576),
			});
			if (
				typeof slice !== "object" ||
				slice === null ||
				Array.isArray(slice) ||
				slice.kind !== "text" ||
				typeof slice.text !== "string" ||
				typeof slice.next_offset !== "number"
			) {
				throw new RiemannHostError("unsupported_media_type", "Output source is not retained UTF-8 text");
			}
			parts.push(slice.text);
			remaining -= Buffer.byteLength(slice.text);
			segment.offset_bytes = slice.next_offset;
			if (!slice.eof) break;
			segments.shift();
			if (segment.stop_after) break;
		}
		return { text: parts.join(""), ...(segments.length ? { next: await this.save(segments) } : {}) };
	}

	async combine(parts: OutputPart[]): Promise<string> {
		const segments: Segment[] = [];
		for (const part of parts) {
			if (typeof part === "string") {
				if (part) segments.push(await this.literal((segments.length ? "\n\n" : "") + part));
			} else {
				const next = await this.load(part.handle);
				if (segments.length && next.length) next[0].prefix = (part.separator ?? "\n\n") + next[0].prefix;
				segments.push(...next);
			}
		}
		return this.save(segments);
	}
}

/** Final cell budgeting runs after all producers settle, so hidden bytes never advance a visible cursor. */
export async function renderModelText(
	views: OutputViews,
	parts: OutputPart[],
): Promise<{ text: string; more?: string; error?: string }> {
	// Persist the ordered output before publishing any continuation. Reading a
	// cursor never consumes it, so a failed delivery or repeated read is safe.
	const ref = await views.combine(parts);
	const result = await views.read(ref, MODEL_TEXT_BYTES - 128);
	return {
		text: result.text + (result.next ? `\n[more ${result.next}]` : ""),
		...(result.next ? { more: result.next } : {}),
	};
}
