import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { type ContextUsageEstimate, estimateContextTokens, estimateTokens } from "./compaction/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Codex core/context_manager/history.rs native-payload byte estimates, before the bytes/4 conversion. */
function nativeItemTokens(item: Record<string, unknown>): number {
	if (
		(item.type === "reasoning" || item.type === "compaction" || item.type === "context_compaction") &&
		typeof item.encrypted_content === "string"
	) {
		return Math.ceil(Math.max(0, Math.floor((Buffer.byteLength(item.encrypted_content) * 3) / 4) - 650) / 4);
	}
	let bytes = Buffer.byteLength(JSON.stringify(item));
	const parts = Array.isArray(item.output) ? item.output : Array.isArray(item.content) ? item.content : [];
	for (const part of parts) {
		if (!isRecord(part)) continue;
		if (
			(item.type === "function_call_output" || item.type === "agent_message") &&
			part.type === "encrypted_content" &&
			typeof part.encrypted_content === "string"
		) {
			const encoded = Buffer.byteLength(part.encrypted_content);
			bytes += Math.ceil((encoded * 9) / 16) - encoded;
		}
		if (part.type !== "input_image" || typeof part.image_url !== "string") continue;
		const comma = part.image_url.indexOf(",");
		if (comma < 0 || !part.image_url.toLowerCase().startsWith("data:image/")) continue;
		const [mime, ...parameters] = part.image_url.slice(5, comma).toLowerCase().split(";");
		if (!parameters.includes("base64")) continue;
		const payload = part.image_url.slice(comma + 1);
		let imageBytes = 7373;
		if (part.detail === "original") {
			const dimensions = getImageDimensions(payload, mime);
			if (dimensions)
				imageBytes = Math.min(10000, Math.ceil(dimensions.widthPx / 32) * Math.ceil(dimensions.heightPx / 32)) * 4;
		}
		// Preserve the data URL prefix and JSON framing, as upstream does.
		bytes += imageBytes - Buffer.byteLength(payload);
	}
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
