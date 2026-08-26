import type { ProviderPayload } from "@earendil-works/pi-ai";
import type { OpenAICodexCompactionResult } from "@earendil-works/pi-ai/api/openai-codex-responses";

export const OPENAI_COMPACTION_PRESERVE_KEY = "openaiRemoteCompaction";

export interface PreservedOpenAICompaction {
	compactionItem: OpenAICodexCompactionResult["compactionItem"];
	replacementHistory: Array<Record<string, unknown>>;
	responseId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompactionItem(value: unknown): value is OpenAICodexCompactionResult["compactionItem"] {
	return (
		isRecord(value) &&
		value.type === "compaction" &&
		typeof value.encrypted_content === "string" &&
		value.encrypted_content.length > 0 &&
		(value.id === undefined || typeof value.id === "string") &&
		(value.created_by === undefined || typeof value.created_by === "string")
	);
}

function isHostContextMessage(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value) || value.type !== "message" || value.role !== "user" || !Array.isArray(value.content)) {
		return false;
	}
	return value.content.every((item) => isRecord(item) && item.type === "input_text" && typeof item.text === "string");
}

function isReplacementHistory(
	value: unknown,
	compactionItem: OpenAICodexCompactionResult["compactionItem"],
): value is Array<Record<string, unknown>> {
	if (!Array.isArray(value) || value.length !== 2) return false;
	const [remote, host] = value;
	return (
		isCompactionItem(remote) &&
		remote.encrypted_content === compactionItem.encrypted_content &&
		remote.id === compactionItem.id &&
		isHostContextMessage(host)
	);
}

export function getPreservedOpenAICompaction(
	preserveData: Record<string, unknown> | undefined,
): PreservedOpenAICompaction | undefined {
	const candidate = preserveData?.[OPENAI_COMPACTION_PRESERVE_KEY];
	if (!isRecord(candidate)) return undefined;
	const allowedFields = new Set(["compactionItem", "replacementHistory", "responseId"]);
	if (
		Object.keys(candidate).some((field) => !allowedFields.has(field)) ||
		!isCompactionItem(candidate.compactionItem) ||
		!isReplacementHistory(candidate.replacementHistory, candidate.compactionItem) ||
		(candidate.responseId !== undefined && typeof candidate.responseId !== "string")
	) {
		return undefined;
	}
	return candidate as unknown as PreservedOpenAICompaction;
}

export function openAICompactionProviderPayload(
	preserveData: Record<string, unknown> | undefined,
): ProviderPayload | undefined {
	const remote = getPreservedOpenAICompaction(preserveData);
	if (!remote) return undefined;
	return {
		type: "openaiResponsesHistory",
		items: remote.replacementHistory,
	};
}
