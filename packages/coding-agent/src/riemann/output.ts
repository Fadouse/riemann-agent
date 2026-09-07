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

const MAX_VIEW_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SEGMENTS = 10000;
const SourceSchema = Type.Object(
	{
		path: Type.Array(Type.String(), { maxItems: 64 }),
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
		sources: Type.Array(SourceSchema, { maxItems: MAX_SEGMENTS }),
	},
	{ additionalProperties: false },
);
const SegmentSchema = Type.Object(
	{
		handle: Type.String({ minLength: 1 }),
		offset_bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		prefix: Type.String({ maxLength: 1024 }),
		stop_after: Type.Boolean(),
	},
	{ additionalProperties: false },
);
const ViewSchema = Type.Object(
	{
		segments: Type.Array(SegmentSchema, { maxItems: MAX_SEGMENTS }),
	},
	{ additionalProperties: false },
);
type Segment = Static<typeof SegmentSchema>;
export type OutputPart = string | { type: "output_ref"; handle: string };

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
		if (Buffer.byteLength(text) > MAX_VIEW_BYTES) {
			throw new RiemannHostError("response_too_large", "Selected output exceeds 64 MiB; select fewer fields");
		}
		const handle = handleOf(await this.artifacts.putText(text, { name: "output-text.txt" }));
		return { handle, offset_bytes: 0, prefix: "", stop_after: stopAfter };
	}

	private async save(segments: Segment[]): Promise<string> {
		const value = { segments };
		if (!Value.Check(ViewSchema, value)) throw new RiemannHostError("response_too_large", "Too many output segments");
		const text = JSON.stringify(value);
		if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
			throw new RiemannHostError("response_too_large", "Output cursor exceeds its size bound");
		return handleOf(await this.artifacts.putText(text, { mimeType: OUTPUT_VIEW_MIME, name: "output-cursor.json" }));
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
		if (metadata.size > MAX_MANIFEST_BYTES)
			throw new RiemannHostError("response_too_large", "Output cursor exceeds its size bound");
		const bytes = await this.artifacts.readBuffer(handle, MAX_MANIFEST_BYTES);
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

	async prepare(envelope: JsonValue, maxItems: number, budget: number): Promise<KernelModelContent> {
		if (!Value.Check(EnvelopeSchema, envelope)) {
			throw new RiemannHostError(
				"invalid_arguments",
				"Use output.show(value=..., fields=..., max_items=...) to construct an output view",
			);
		}
		const overflow: Array<{ path: string[]; value: JsonValue }> = [];
		let nodes = 0;
		const select = (value: JsonValue, path: string[], depth: number): JsonValue => {
			if (++nodes > 100000 || depth > 64)
				throw new RiemannHostError(
					"response_too_large",
					"Selected output is too deeply nested; select fewer fields",
				);
			if (Array.isArray(value)) {
				if (value.length > maxItems) overflow.push({ path, value: value.slice(maxItems) });
				return value.slice(0, maxItems).map((item, index) => select(item, [...path, String(index)], depth + 1));
			}
			if (value !== null && typeof value === "object") {
				return Object.fromEntries(
					Object.entries(value).map(([key, item]) => [key, select(item, [...path, key], depth + 1)]),
				);
			}
			return value;
		};
		const preview = select(envelope.value as JsonValue, [], 0);
		let visible = typeof preview === "string" ? preview : JSON.stringify(preview, null, 2);
		const pending: Segment[] = [];
		for (const remainder of overflow) {
			const label = utf8Prefix(remainder.path.join("."), 256) || "items";
			visible += `\n[${label}: ${Array.isArray(remainder.value) ? remainder.value.length : 0} retained items omitted]`;
			pending.push(await this.literal(`\n${label} (continued):\n${JSON.stringify(remainder.value, null, 2)}`));
		}
		for (const source of envelope.sources) {
			this.artifacts.assertPublic(source.handle);
			const metadata = this.artifacts.getMetadata(source.handle);
			const label = utf8Prefix(source.path.join("."), 256) || "text";
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
		if (!pending.length && Buffer.byteLength(visible) <= budget) return { type: "text", text: visible };
		const initial = await this.literal(visible, pending.length > 0);
		return { type: "output_ref", handle: await this.save([initial, ...pending]) };
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
				if (segments.length && next.length && !next[0].prefix.startsWith("\n\n"))
					next[0].prefix = `\n\n${next[0].prefix}`;
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
	maxBytes: number,
): Promise<{ text: string; more?: string; error?: string }> {
	const visible: string[] = [];
	const pending: OutputPart[] = [];
	let remaining = Math.max(0, maxBytes - 128);
	let emitted = false;
	let outputError: string | undefined;
	for (const part of parts) {
		if (emitted && remaining >= 2) {
			visible.push("\n\n");
			remaining -= 2;
		}
		if (typeof part === "string") {
			const prefix = utf8Prefix(part, remaining);
			visible.push(prefix);
			remaining -= Buffer.byteLength(prefix);
			emitted ||= prefix.length > 0;
			if (prefix.length < part.length) pending.push(part.slice(prefix.length));
		} else if (remaining >= 4) {
			try {
				const result = await views.read(part.handle, remaining);
				visible.push(result.text);
				remaining -= Buffer.byteLength(result.text);
				emitted ||= result.text.length > 0;
				if (result.next) pending.push({ type: "output_ref", handle: result.next });
			} catch (error) {
				outputError = error instanceof Error ? error.message : String(error);
				const failure = utf8Prefix(
					`[Output unavailable: ${error instanceof Error ? error.message : String(error)}]`,
					remaining,
				);
				visible.push(failure);
				remaining -= Buffer.byteLength(failure);
				emitted = true;
			}
		} else pending.push(part);
	}
	let more: string | undefined;
	let footer = "";
	if (pending.length) {
		try {
			more = await views.combine(pending);
			footer = `\n[more=${more}]`;
		} catch (error) {
			outputError = error instanceof Error ? error.message : String(error);
			footer = utf8Prefix(
				`\n[Recovery unavailable: ${error instanceof Error ? error.message : String(error)}]`,
				128,
			);
		}
	}
	return {
		text: visible.join("") + footer,
		...(more ? { more } : {}),
		...(outputError ? { error: outputError } : {}),
	};
}
