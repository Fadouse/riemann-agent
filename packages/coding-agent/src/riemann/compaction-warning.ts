import type { SessionEntry } from "../core/session-manager.ts";
import type { EffectiveCompactionStrategy } from "./compaction-strategy.ts";
import { getPreservedOpenAICompaction } from "./openai-compaction-state.ts";

export const COMPACTION_WARNING_CODES = [
	"encrypted-openai-context-transition",
	"snapshot-requires-image-model",
	"openai-requires-codex-model",
	"openai-requires-oauth",
] as const;

export type CompactionWarningCode = (typeof COMPACTION_WARNING_CODES)[number];

export const COMPACTION_WARNING_TRIGGERS = [
	"model-change",
	"strategy-change",
	"session-resume",
	"compaction-dispatch",
] as const;

export type CompactionWarningTrigger = (typeof COMPACTION_WARNING_TRIGGERS)[number];

export interface CurrentCompactionModelCapabilities {
	supportsImageInput: boolean;
	supportsOpenAICompaction: boolean;
	usingOAuth?: boolean;
}

export interface DetectCompactionWarningsInput {
	trigger: CompactionWarningTrigger;
	hasEncryptedOpenAIContext: boolean;
	previousEffectiveStrategy: EffectiveCompactionStrategy;
	effectiveStrategy: EffectiveCompactionStrategy;
	currentModel: CurrentCompactionModelCapabilities;
}

export interface CompactionWarning {
	code: CompactionWarningCode;
	trigger: CompactionWarningTrigger;
	message: string;
}

const WARNING_MESSAGES: Record<CompactionWarningCode, string> = {
	"encrypted-openai-context-transition":
		"This session contains encrypted OpenAI compaction context. Changing the model, provider, or compaction strategy may make earlier context unavailable.",
	"snapshot-requires-image-model":
		"Snapshot compaction requires an image-capable model. The selected model does not support image input, so snapshot compaction will fail.",
	"openai-requires-codex-model":
		"OpenAI Codex compaction requires an active OpenAI Codex Responses model. The selected model is incompatible, so OpenAI compaction will fail.",
	"openai-requires-oauth": "OpenAI Codex compaction requires OpenAI Codex subscription OAuth.",
};

/** Detect compaction compatibility warnings without changing session or configuration state. */
export function detectCompactionWarnings(input: DetectCompactionWarningsInput): CompactionWarning[] {
	const codes: CompactionWarningCode[] = [];
	const encryptedContextTransition =
		input.hasEncryptedOpenAIContext &&
		(input.trigger === "model-change" ||
			input.trigger === "session-resume" ||
			input.previousEffectiveStrategy !== input.effectiveStrategy ||
			input.effectiveStrategy !== "openai" ||
			!input.currentModel.supportsOpenAICompaction);
	if (encryptedContextTransition) codes.push("encrypted-openai-context-transition");
	if (input.effectiveStrategy === "snapshot" && !input.currentModel.supportsImageInput) {
		codes.push("snapshot-requires-image-model");
	}
	if (input.effectiveStrategy === "openai" && !input.currentModel.supportsOpenAICompaction) {
		codes.push("openai-requires-codex-model");
	}
	if (
		input.effectiveStrategy === "openai" &&
		input.currentModel.supportsOpenAICompaction &&
		input.currentModel.usingOAuth === false
	) {
		codes.push("openai-requires-oauth");
	}
	return codes.map((code) => ({ code, trigger: input.trigger, message: WARNING_MESSAGES[code] }));
}

/** Check the newest compaction on an already-resolved active branch for valid encrypted OpenAI state. */
export function latestActiveCompactionHasOpenAIContext(activeBranch: readonly SessionEntry[]): boolean {
	for (let index = activeBranch.length - 1; index >= 0; index--) {
		const entry = activeBranch[index];
		if (entry.type !== "compaction") continue;
		return getPreservedOpenAICompaction(entry.preserveData) !== undefined;
	}
	return false;
}
