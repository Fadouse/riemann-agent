import type { Message, UserMessage } from "@earendil-works/pi-ai";
import {
	compactOpenAICodexResponses,
	type OpenAICodexCompactionResult,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { CompactionPreparation, CompactionResult } from "../core/compaction/index.ts";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { convertToLlm } from "../core/messages.ts";
import type { JsonValue } from "./kernel/types.ts";
import {
	getPreservedOpenAICompaction,
	OPENAI_COMPACTION_FORMAT,
	OPENAI_COMPACTION_PRESERVE_KEY,
	type PreservedOpenAICompaction,
} from "./openai-compaction-state.ts";

function priorCompactionMessage(preparation: CompactionPreparation): UserMessage | undefined {
	const previous = getPreservedOpenAICompaction(preparation.previousPreserveData);
	if (!previous) return undefined;
	return {
		role: "user",
		content: "",
		providerPayload: {
			type: "openaiResponsesHistory",
			items: [previous.compactionItem],
		},
		timestamp: 0,
	};
}

function cloudContextMessages(preparation: CompactionPreparation): Message[] {
	const previous = priorCompactionMessage(preparation);
	return [
		...(previous ? [previous] : []),
		...convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
	];
}

function compactionSummary(durableState: JsonValue): string {
	return [
		"OpenAI Codex cloud compaction is active for the preceding conversation.",
		`<riemann_state>\n${JSON.stringify(durableState)}\n</riemann_state>`,
	].join("\n\n");
}

function replacementHistory(
	compactionItem: OpenAICodexCompactionResult["compactionItem"],
	summary: string,
): Array<Record<string, unknown>> {
	return [
		compactionItem,
		{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: summary }],
		},
	];
}

export async function createRiemannOpenAICompaction(options: {
	preparation: CompactionPreparation;
	customInstructions?: string;
	signal: AbortSignal;
	context: Pick<ExtensionContext, "model" | "modelRegistry" | "getSystemPrompt" | "thinkingLevel">;
	durableState: JsonValue;
	sessionId: string;
}): Promise<CompactionResult> {
	if (options.customInstructions !== undefined) {
		throw new Error(
			'compaction.strategy "openai" does not support custom instructions; configure strategy "default"',
		);
	}
	const model = options.context.model;
	if (!model || model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
		throw new Error("OpenAI cloud compaction requires an active openai-codex model");
	}
	if (!options.context.modelRegistry.isUsingOAuth(model)) {
		throw new Error("OpenAI cloud compaction requires OpenAI Codex subscription OAuth");
	}
	const auth = await options.context.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error("OpenAI Codex OAuth did not provide an access token");
	const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
	const thinkingLevel = options.context.thinkingLevel;
	const remote = await compactOpenAICodexResponses(
		requestModel,
		{
			systemPrompt: options.context.getSystemPrompt(),
			messages: cloudContextMessages(options.preparation),
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: options.signal,
			sessionId: options.sessionId,
			cacheRetention: "short",
			...(thinkingLevel ? { reasoningEffort: thinkingLevel === "off" ? "none" : thinkingLevel } : {}),
		},
	);

	const summary = compactionSummary(options.durableState);
	const history = replacementHistory(remote.compactionItem, summary);
	const preserved: PreservedOpenAICompaction = {
		version: 1,
		format: OPENAI_COMPACTION_FORMAT,
		compactionItem: remote.compactionItem,
		replacementHistory: history,
		...(remote.responseId ? { responseId: remote.responseId } : {}),
	};
	return {
		summary,
		firstKeptEntryId: options.preparation.firstKeptEntryId,
		tokensBefore: options.preparation.tokensBefore,
		usage: remote.usage,
		details: {
			version: 1,
			strategy: "openai",
			format: preserved.format,
			responseId: preserved.responseId,
		},
		preserveData: {
			[OPENAI_COMPACTION_PRESERVE_KEY]: preserved,
		},
	};
}
