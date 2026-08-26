import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { EffectiveCompactionStrategy } from "../src/riemann/compaction-strategy.ts";
import {
	COMPACTION_WARNING_TRIGGERS,
	type CompactionWarningCode,
	detectCompactionWarnings,
	latestActiveCompactionHasOpenAIContext,
} from "../src/riemann/compaction-warning.ts";
import { OPENAI_COMPACTION_PRESERVE_KEY } from "../src/riemann/openai-compaction-state.ts";

function warningCodes(
	effectiveStrategy: EffectiveCompactionStrategy,
	options: {
		hasEncryptedOpenAIContext?: boolean;
		previousEffectiveStrategy?: EffectiveCompactionStrategy;
		supportsImageInput?: boolean;
		supportsOpenAICompaction?: boolean;
		usingOAuth?: boolean;
	} = {},
): CompactionWarningCode[] {
	return detectCompactionWarnings({
		trigger: "compaction-dispatch",
		hasEncryptedOpenAIContext: options.hasEncryptedOpenAIContext ?? false,
		previousEffectiveStrategy: options.previousEffectiveStrategy ?? effectiveStrategy,
		effectiveStrategy,
		currentModel: {
			supportsImageInput: options.supportsImageInput ?? true,
			supportsOpenAICompaction: options.supportsOpenAICompaction ?? true,
			...(options.usingOAuth === undefined ? {} : { usingOAuth: options.usingOAuth }),
		},
	}).map((warning) => warning.code);
}

function entry(id: string, value: Pick<SessionEntry, "type"> & Partial<SessionEntry>): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: "2026-08-26T00:00:00.000Z",
		...value,
	} as SessionEntry;
}

const validRemoteState = {
	[OPENAI_COMPACTION_PRESERVE_KEY]: {
		compactionItem: { type: "compaction", encrypted_content: "encrypted" },
		replacementHistory: [
			{ type: "compaction", encrypted_content: "encrypted" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "summary" }] },
		],
	},
};

describe("compaction warnings", () => {
	test("covers each effective strategy capability matrix", () => {
		for (const strategy of ["default", "snapshot", "openai"] as const) {
			for (const supportsImageInput of [false, true]) {
				for (const supportsOpenAICompaction of [false, true]) {
					for (const usingOAuth of [false, true, undefined]) {
						const expected: CompactionWarningCode[] = [];
						if (strategy === "snapshot" && !supportsImageInput) expected.push("snapshot-requires-image-model");
						if (strategy === "openai" && !supportsOpenAICompaction) expected.push("openai-requires-codex-model");
						if (strategy === "openai" && supportsOpenAICompaction && usingOAuth === false) {
							expected.push("openai-requires-oauth");
						}
						expect(warningCodes(strategy, { supportsImageInput, supportsOpenAICompaction, usingOAuth })).toEqual(
							expected,
						);
					}
				}
			}
		}
	});

	test("detects encrypted context transitions for every trigger and preserves the trigger", () => {
		for (const trigger of COMPACTION_WARNING_TRIGGERS) {
			const warnings = detectCompactionWarnings({
				trigger,
				hasEncryptedOpenAIContext: true,
				previousEffectiveStrategy: "openai",
				effectiveStrategy: "default",
				currentModel: { supportsImageInput: true, supportsOpenAICompaction: true, usingOAuth: true },
			});
			expect(warnings).toEqual([
				{
					code: "encrypted-openai-context-transition",
					trigger,
					message:
						"This session contains encrypted OpenAI compaction context. Changing the model, provider, or compaction strategy may make earlier context unavailable.",
				},
			]);
		}
	});

	test("warns on encrypted model changes and session resume", () => {
		const compatible = {
			hasEncryptedOpenAIContext: true,
			previousEffectiveStrategy: "openai" as const,
			effectiveStrategy: "openai" as const,
			currentModel: { supportsImageInput: true, supportsOpenAICompaction: true, usingOAuth: true },
		};
		expect(
			detectCompactionWarnings({ trigger: "model-change", ...compatible }).map((warning) => warning.code),
		).toEqual(["encrypted-openai-context-transition"]);
		expect(
			detectCompactionWarnings({ trigger: "session-resume", ...compatible }).map((warning) => warning.code),
		).toEqual(["encrypted-openai-context-transition"]);
	});

	test("returns combined encrypted and snapshot warnings in fixed order", () => {
		expect(
			detectCompactionWarnings({
				trigger: "strategy-change",
				hasEncryptedOpenAIContext: true,
				previousEffectiveStrategy: "openai",
				effectiveStrategy: "snapshot",
				currentModel: { supportsImageInput: false, supportsOpenAICompaction: false },
			}).map((warning) => warning.code),
		).toEqual(["encrypted-openai-context-transition", "snapshot-requires-image-model"]);
	});

	test("uses static messages without provider or model identifiers", () => {
		const messages = detectCompactionWarnings({
			trigger: "compaction-dispatch",
			hasEncryptedOpenAIContext: true,
			previousEffectiveStrategy: "default",
			effectiveStrategy: "openai",
			currentModel: { supportsImageInput: false, supportsOpenAICompaction: false, usingOAuth: false },
		}).map((warning) => warning.message);
		expect(messages.join(" ")).not.toMatch(/openai-codex|gpt-5|provider[=:]|model[=:]/i);
	});
});

describe("latest active OpenAI compaction state", () => {
	test("accepts valid state on only the latest compaction", () => {
		const branch: SessionEntry[] = [
			entry("old", {
				type: "compaction",
				summary: "old",
				firstKeptEntryId: "first",
				tokensBefore: 1,
				preserveData: { [OPENAI_COMPACTION_PRESERVE_KEY]: { malformed: true } },
			}),
			entry("latest", {
				type: "compaction",
				summary: "latest",
				firstKeptEntryId: "first",
				tokensBefore: 2,
				preserveData: validRemoteState,
			}),
			entry("message", { type: "message", message: { role: "user", content: "after", timestamp: 0 } }),
		];
		expect(latestActiveCompactionHasOpenAIContext(branch)).toBe(true);
	});

	test("returns false when the latest compaction is malformed even if an older one is valid", () => {
		const branch: SessionEntry[] = [
			entry("old", {
				type: "compaction",
				summary: "old",
				firstKeptEntryId: "first",
				tokensBefore: 1,
				preserveData: validRemoteState,
			}),
			entry("latest", {
				type: "compaction",
				summary: "latest",
				firstKeptEntryId: "first",
				tokensBefore: 2,
				preserveData: { [OPENAI_COMPACTION_PRESERVE_KEY]: { unexpected: true } },
			}),
		];
		expect(latestActiveCompactionHasOpenAIContext(branch)).toBe(false);
		expect(
			latestActiveCompactionHasOpenAIContext([
				entry("message", { type: "message", message: { role: "user", content: "none", timestamp: 0 } }),
			]),
		).toBe(false);
		expect(latestActiveCompactionHasOpenAIContext([])).toBe(false);
	});
});
