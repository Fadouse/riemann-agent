import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { RiemannHostError } from "./errors.ts";
import type { JsonValue, KernelModelContent } from "./kernel/types.ts";
import type { ArtifactStore } from "./state/artifacts.ts";
import { OUTPUT_VIEW_MIME, RESULT_MIME } from "./state/references.ts";

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

export const MODEL_TEXT_BYTES = 16_384;
const SegmentSchema = Type.Object(
	{
		handle: Type.String({ minLength: 1 }),
		offset_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		prefix: Type.String(),
		stop_after: Type.Boolean(),
		end_bytes: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		selected: Type.Optional(Type.Boolean()),
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
		if (metadata.mimeType === RESULT_MIME) {
			const result = await this.artifacts.readResult(handle);
			return this.load(result.value_ref);
		}
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
					"Binary reference; use await refs[id].read() or its view() method",
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

	private extent(segment: Segment): number {
		return segment.end_bytes ?? this.artifacts.getMetadata(segment.handle).size;
	}

	private size(segments: Segment[]): number {
		return segments.reduce(
			(total, segment) => total + Buffer.byteLength(segment.prefix) + this.extent(segment) - segment.offset_bytes,
			0,
		);
	}

	/** Read only the boundary byte, never the intervening output. */
	private async boundary(segments: Segment[], offset: number, direction: -1 | 1): Promise<number> {
		let position = 0;
		for (const segment of segments) {
			const prefix = Buffer.from(segment.prefix);
			const length = prefix.length + this.extent(segment) - segment.offset_bytes;
			if (offset < position + length) {
				let local = offset - position;
				if (local < prefix.length) {
					while ((prefix[local] & 0xc0) === 0x80) local += direction;
					return position + local;
				}
				const metadata = this.artifacts.assertPublic(segment.handle);
				const file = await open(metadata.path, "r");
				try {
					const byte = Buffer.allocUnsafe(1);
					while (local < length) {
						const { bytesRead } = await file.read(byte, 0, 1, segment.offset_bytes + local - prefix.length);
						if (bytesRead !== 1) throw new RiemannHostError("artifact_error", "Output source is incomplete");
						if ((byte[0] & 0xc0) !== 0x80) break;
						local += direction;
						if (Math.abs(local - (offset - position)) > 3)
							throw new RiemannHostError("unsupported_media_type", "Output boundary is not valid UTF-8");
					}
					return position + local;
				} finally {
					await file.close();
				}
			}
			position += length;
		}
		return offset;
	}

	/** A slice is a manifest of existing bytes, not a new copy of the payload. */
	private slice(segments: Segment[], start: number, end: number, selected = false): Segment[] {
		const result: Segment[] = [];
		let position = 0;
		for (const segment of segments) {
			const prefix = Buffer.from(segment.prefix);
			const bodyStart = position + prefix.length;
			const segmentEnd = bodyStart + this.extent(segment) - segment.offset_bytes;
			if (start < segmentEnd && end > position) {
				const offset = segment.offset_bytes + Math.max(0, start - bodyStart);
				const stop = segment.offset_bytes + Math.max(0, Math.min(end, segmentEnd) - bodyStart);
				result.push({
					...segment,
					prefix: prefix.subarray(Math.max(0, start - position), Math.max(0, end - position)).toString("utf8"),
					offset_bytes: offset,
					end_bytes: stop,
					...(selected ? { selected: true } : {}),
				});
			}
			position = segmentEnd;
			if (position >= end) break;
		}
		return result;
	}

	async read(
		ref: string,
		span?: readonly [number, number],
	): Promise<Extract<KernelModelContent, { type: "output_ref" }>> {
		const segments = await this.load(ref);
		if (span === undefined) return { type: "output_ref", handle: ref };
		const [start, end] = span;
		const size = this.size(segments);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > size)
			throw new RiemannHostError("invalid_arguments", `span must satisfy 0 <= start <= end <= ${size} UTF-8 bytes`);
		if ((await this.boundary(segments, start, 1)) !== start || (await this.boundary(segments, end, 1)) !== end)
			throw new RiemannHostError("invalid_arguments", "span endpoints must be UTF-8 code-point boundaries");
		return { type: "output_ref", handle: await this.save(this.slice(segments, start, end, true)) };
	}

	async text(ref: string, span?: readonly [number, number]): Promise<{ text: string; reference: string }> {
		const selected = await this.read(ref, span);
		const segments = await this.load(selected.handle);
		const result = await this.readSegments(segments, this.size(segments));
		return { text: result.text, reference: selected.handle };
	}

	async print(value: JsonValue): Promise<KernelModelContent[]> {
		if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.parts))
			throw new RiemannHostError("invalid_arguments", "Invalid print event");
		const segments: Segment[] = [];
		let literal = value.stderr === true ? "\n[stderr]\n" : "";
		for (const part of value.parts) {
			if (!part || typeof part !== "object" || Array.isArray(part))
				throw new RiemannHostError("invalid_arguments", "Invalid print part");
			if (typeof part.text === "string") literal += part.text;
			else if (typeof part.ref === "string") {
				const metadata = this.artifacts.getMetadata(part.ref);
				if (
					!metadata.mimeType.startsWith("text/") &&
					!metadata.mimeType.includes("json") &&
					!metadata.mimeType.includes("xml")
				) {
					this.artifacts.assertPublic(part.ref);
					literal += `[binary ${part.ref}; use read() or view()]`;
					continue;
				}
				if (literal) segments.push(await this.literal(literal));
				literal = "";
				segments.push(...(await this.load(part.ref)));
			} else throw new RiemannHostError("invalid_arguments", "Print parts require text or ref");
		}
		if (literal) segments.push(await this.literal(literal));
		return [{ type: "output_ref", handle: await this.save(segments), separator: "" }];
	}

	private async readSegments(segments: Segment[], maxBytes: number): Promise<{ text: string; remaining: Segment[] }> {
		const parts: string[] = [];
		let remaining = Math.max(0, maxBytes);
		while (segments.length && remaining > 0) {
			const segment = segments[0];
			if (segment.prefix) {
				const prefix = utf8Prefix(segment.prefix, remaining);
				parts.push(prefix);
				remaining -= Buffer.byteLength(prefix);
				segment.prefix = segment.prefix.slice(prefix.length);
				if (segment.prefix || remaining === 0) break;
			}
			const end = this.extent(segment);
			if (segment.offset_bytes === end) {
				segments.shift();
				continue;
			}
			const slice = await this.artifacts.get(segment.handle, {
				offset: segment.offset_bytes,
				limit: Math.min(Math.max(remaining, 4), end - segment.offset_bytes, 1048576),
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
			const text = utf8Prefix(slice.text, remaining);
			parts.push(text);
			const length = Buffer.byteLength(text);
			remaining -= length;
			segment.offset_bytes += length;
			if (segment.offset_bytes < end) {
				if (text !== slice.text || remaining < 4) break;
				if (length === 0) throw new RiemannHostError("artifact_error", "Output source is incomplete");
				continue;
			}
			segments.shift();
			if (segment.stop_after) break;
		}
		return {
			text: parts.join(""),
			remaining: segments.filter((segment) => segment.prefix || segment.offset_bytes < this.extent(segment)),
		};
	}

	async preview(ref: string): Promise<{ text: string; more?: string }> {
		const segments = await this.load(ref);
		const budget = MODEL_TEXT_BYTES - 128;
		const size = this.size(segments);
		if (size <= MODEL_TEXT_BYTES || segments.some((segment) => segment.selected)) {
			const result = await this.readSegments(segments, size <= MODEL_TEXT_BYTES ? MODEL_TEXT_BYTES : budget);
			if (!result.remaining.length) return { text: result.text };
			const more = await this.save(result.remaining);
			return { text: `${result.text}\n[more ${more}]`, more };
		}
		const headEnd = await this.boundary(segments, Math.floor(budget / 2), -1);
		const tailStart = await this.boundary(segments, size - Math.ceil(budget / 2), 1);
		const head = await this.readSegments(this.slice(segments, 0, headEnd), headEnd);
		const tail = await this.readSegments(this.slice(segments, tailStart, size), size - tailStart);
		const more = await this.save(this.slice(segments, headEnd, tailStart));
		return { text: `${head.text}\n[more ${more}]\n${tail.text}`, more };
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
	return views.preview(ref);
}
