import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { type ContextUsageEstimate, estimateContextTokens, estimateTokens } from "./compaction/index.ts";

const payloadEstimates = new WeakMap<
	object,
	{ kind: "encrypted" | "image"; value: string; detail?: unknown; bytes: number }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON escaping overhead without allocating a serialized copy of a large payload. */
function jsonEscapeBytes(value: string): number {
	let bytes = 0;
	for (const match of value.matchAll(/["\\\u0000-\u001f\ud800-\udfff]/gu)) {
		const code = match[0].charCodeAt(0);
		bytes += code >= 0xd800 ? 3 : code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
	}
	return bytes;
}

/** Codex core/context_manager/history.rs native-payload byte estimates, before the bytes/4 conversion. */
function nativeItemTokens(item: Record<string, unknown>): number {
	if (
		(item.type === "reasoning" || item.type === "compaction" || item.type === "context_compaction") &&
		typeof item.encrypted_content === "string"
	) {
		return Math.ceil(Math.max(0, Math.floor((Buffer.byteLength(item.encrypted_content) * 3) / 4) - 650) / 4);
	}
	let payloadBytes = 0;
	const field = Array.isArray(item.output) ? "output" : Array.isArray(item.content) ? "content" : undefined;
	const parts = field ? (item[field] as unknown[]) : [];
	const metadata = parts.map((part) => {
		if (!isRecord(part)) return part;
		if (
			(item.type === "function_call_output" || item.type === "agent_message") &&
			part.type === "encrypted_content" &&
			typeof part.encrypted_content === "string"
		) {
			let cached = payloadEstimates.get(part);
			if (cached?.kind !== "encrypted" || cached.value !== part.encrypted_content) {
				const encoded = Buffer.byteLength(part.encrypted_content);
				cached = {
					kind: "encrypted",
					value: part.encrypted_content,
					bytes: Math.ceil((encoded * 9) / 16) + jsonEscapeBytes(part.encrypted_content),
				};
				payloadEstimates.set(part, cached);
			}
			payloadBytes += cached.bytes;
			return { ...part, encrypted_content: "" };
		}
		if (part.type !== "input_image" || typeof part.image_url !== "string") return part;
		const comma = part.image_url.indexOf(",");
		if (comma < 0 || part.image_url.slice(0, 11).toLowerCase() !== "data:image/") return part;
		const [mime, ...parameters] = part.image_url.slice(5, comma).toLowerCase().split(";");
		if (!parameters.includes("base64")) return part;
		let cached = payloadEstimates.get(part);
		if (cached?.kind !== "image" || cached.value !== part.image_url || cached.detail !== part.detail) {
			const payload = part.image_url.slice(comma + 1);
			let imageBytes = 7373;
			if (part.detail === "original") {
				const dimensions = getImageDimensions(payload, mime);
				if (dimensions)
					imageBytes =
						Math.min(10000, Math.ceil(dimensions.widthPx / 32) * Math.ceil(dimensions.heightPx / 32)) * 4;
			}
			cached = {
				kind: "image",
				value: part.image_url,
				detail: part.detail,
				bytes: imageBytes + jsonEscapeBytes(payload),
			};
			payloadEstimates.set(part, cached);
		}
		// Preserve the data URL prefix and JSON framing, as upstream does.
		payloadBytes += cached.bytes;
		return { ...part, image_url: part.image_url.slice(0, comma + 1) };
	});
	const bytes = Buffer.byteLength(JSON.stringify(field ? { ...item, [field]: metadata } : item)) + payloadBytes;
	return Math.ceil(Math.max(0, bytes) / 4);
}

/** Native history/notes payloads intentionally have no public content; they still consume model context. */
export function estimateCodexContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const estimate = estimateContextTokens(messages);
	let adjustment = 0;
	for (
		let index = estimate.lastUsageIndex === null ? 0 : estimate.lastUsageIndex + 1;
		index < messages.length;
		index++
	) {
		const message = messages[index];
		let nativeTokens: number | undefined;
		if (message.role === "user" && message.providerPayload?.type === "openaiResponsesHistory") {
			nativeTokens = message.providerPayload.items.reduce((sum, item) => sum + nativeItemTokens(item), 0);
		} else if (message.role === "toolResult" && message.openaiCodexOutput !== undefined) {
			nativeTokens = nativeItemTokens({
				type: "function_call_output",
				call_id: message.toolCallId.split("|")[0],
				id: message.openaiCodexItemId,
				output: message.openaiCodexOutput,
				...(message.openaiCodexMetadata
					? { internal_chat_message_metadata_passthrough: message.openaiCodexMetadata }
					: {}),
			});
		}
		if (nativeTokens !== undefined) adjustment += nativeTokens - estimateTokens(message);
	}
	return {
		...estimate,
		tokens: estimate.tokens + adjustment,
		trailingTokens: estimate.lastUsageIndex === null ? 0 : estimate.trailingTokens + adjustment,
	};
}
