import {
	type Api,
	type Context,
	contentText,
	type Model,
	type ModelsApiStreamOptions,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, test, vi } from "vitest";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { createFileOps } from "../src/core/compaction/utils.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createRiemannCompaction, createRiemannSnapshotCompaction } from "../src/riemann/compaction.ts";
import { createRiemannOpenAICompaction } from "../src/riemann/openai-compaction.ts";
import { getPreservedOpenAICompaction } from "../src/riemann/openai-compaction-state.ts";
import { getPreservedArchive } from "../src/riemann/snapshot-compaction.ts";

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

describe("Riemann context compaction", () => {
	test("uses the approved compaction prompt and appends deterministic durable state", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in test model is unavailable");
		const completeCalls: Array<{ context: Context; options?: ModelsApiStreamOptions<Api> }> = [];
		const complete = vi.fn(async (_model: Model<Api>, context: Context, options?: ModelsApiStreamOptions<Api>) => {
			completeCalls.push({ context, options });
			return fauxAssistantMessage("## Objective\nPreserve the task");
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [userMessage("Implement the persistent control plane")],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 42_000,
			fileOps: createFileOps(),
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const result = await createRiemannCompaction({
			preparation,
			signal: new AbortController().signal,
			context: {
				model,
				modelRegistry: { complete } as unknown as ExtensionContext["modelRegistry"],
			},
			durableState: { version: 1, agents: [{ id: "child-1", status: "running" }] },
		});

		expect(result.summary).toContain("## Objective\nPreserve the task");
		expect(result.summary).toContain('<riemann_state>\n{"version":1,"agents":[{"id":"child-1","status":"running"}]}');
		expect(result.firstKeptEntryId).toBe("kept-entry");
		const call = completeCalls[0];
		if (!call) throw new Error("Compaction model was not called");
		expect(call.context.systemPrompt).toContain("Riemann Agent's context compaction engine");
		expect(contentText(call.context.messages[0]?.content ?? "")).toContain("<kind>initial</kind>");
		expect(call.options?.cacheRetention).toBe("none");
	});

	test("summarizes a split turn prefix separately and appends durable state once", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in test model is unavailable");
		const kinds: string[] = [];
		const complete = vi.fn(async (_model: Model<Api>, context: Context) => {
			const request = contentText(context.messages[0]?.content ?? "");
			const kind = /<kind>([^<]+)<\/kind>/.exec(request)?.[1] ?? "missing";
			kinds.push(kind);
			return fauxAssistantMessage(kind === "prefix" ? "prefix checkpoint" : "history checkpoint");
		});
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [userMessage("Earlier history")],
			turnPrefixMessages: [userMessage("Large turn prefix")],
			isSplitTurn: true,
			tokensBefore: 42_000,
			fileOps: createFileOps(),
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const result = await createRiemannCompaction({
			preparation,
			signal: new AbortController().signal,
			context: {
				model,
				modelRegistry: { complete } as unknown as ExtensionContext["modelRegistry"],
			},
			durableState: { version: 1, agents: [] },
		});

		expect(kinds).toEqual(["initial", "prefix"]);
		expect(result.summary).toContain("history checkpoint");
		expect(result.summary).toContain("## Turn Context\nprefix checkpoint");
		expect(result.summary.match(/<riemann_state>/g)).toHaveLength(1);
	});

	test("archives old history into OMP snapshot frames and restores them into model context", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in test model is unavailable");
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [userMessage("exact archived line\n".repeat(5_000))],
			turnPrefixMessages: [],
			recentMessages: [userMessage("recent suffix")],
			isSplitTurn: false,
			tokensBefore: 80_000,
			fileOps: createFileOps(),
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const result = await createRiemannSnapshotCompaction({
			preparation,
			signal: new AbortController().signal,
			context: { model },
			durableState: { version: 1, agents: [] },
		});
		const archive = getPreservedArchive(result.preserveData);
		expect(archive).toBeDefined();
		expect(archive?.frames.length).toBeGreaterThan(0);
		expect(result.summary).toContain("<riemann_state>");
		expect(result.details).toMatchObject({ strategy: "snapshot" });

		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("discarded"));
		const keptEntryId = session.appendMessage(userMessage("recent suffix"));
		session.appendCompaction(
			result.summary,
			keptEntryId,
			result.tokensBefore,
			result.details,
			true,
			undefined,
			result.preserveData,
		);
		const context = convertToLlm(session.buildSessionContext().messages);
		const first = context[0];
		expect(first?.role).toBe("user");
		expect(Array.isArray(first?.content) && first.content.some((block) => block.type === "image")).toBe(true);
		expect(Array.isArray(first?.content) && first.content.find((block) => block.type === "image")?.detail).toBe(
			"original",
		);
	});

	test("persists Codex subscription compaction and restores provider-native history", async () => {
		const model = getModel("openai-codex", "gpt-5.5");
		if (!model || model.api !== "openai-codex-responses") {
			throw new Error("Built-in OpenAI Codex test model is unavailable");
		}
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		).toString("base64");
		const token = `aaa.${tokenPayload}.bbb`;
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				item: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
			})}`,
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
				},
			})}`,
		].join("\n\n")}\n\n`;
		const fetchMock = vi.fn(async () => new Response(sse, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [userMessage("cloud archived line\n".repeat(5_000))],
			turnPrefixMessages: [],
			recentMessages: [userMessage("recent suffix")],
			isSplitTurn: false,
			tokensBefore: 80_000,
			fileOps: createFileOps(),
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const result = await createRiemannOpenAICompaction({
			preparation,
			signal: new AbortController().signal,
			context: {
				model,
				modelRegistry: {
					isUsingOAuth: () => true,
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
				} as unknown as ExtensionContext["modelRegistry"],
				getSystemPrompt: () => "Riemann system",
				thinkingLevel: "low",
			},
			durableState: { version: 1, agents: [] },
			sessionId: "session-1",
		}).finally(() => vi.unstubAllGlobals());

		expect(result.details).toEqual({
			version: 1,
			strategy: "openai",
			provider: "openai-codex",
			model: "gpt-5.5",
			format: "responses-compaction-v2",
			responseId: "resp_1",
		});
		expect(result.summary).toContain("<riemann_state>");
		expect(getPreservedArchive(result.preserveData)).toBeUndefined();
		const remote = getPreservedOpenAICompaction(result.preserveData);
		expect(remote).toMatchObject({
			model: "gpt-5.5",
			compactionItem: { type: "compaction", id: "cmp_1", encrypted_content: "opaque" },
			responseId: "resp_1",
		});

		const session = SessionManager.inMemory();
		session.appendMessage(userMessage("discarded"));
		const keptEntryId = session.appendMessage(userMessage("recent suffix"));
		session.appendCompaction(
			result.summary,
			keptEntryId,
			result.tokensBefore,
			result.details,
			true,
			undefined,
			result.preserveData,
		);
		const context = convertToLlm(session.buildSessionContext().messages);
		const compacted = context[0];
		expect(compacted?.role).toBe("user");
		expect(compacted?.role === "user" && compacted.providerPayload).toMatchObject({
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			items: [
				{ type: "compaction", encrypted_content: "opaque" },
				{ type: "message", role: "user" },
			],
		});
		expect(context[1]).toMatchObject({ role: "user" });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	test("surfaces OpenAI strategy incompatibility and cloud failures without fallback", async () => {
		const codexModel = getModel("openai-codex", "gpt-5.5");
		if (!codexModel || codexModel.api !== "openai-codex-responses") {
			throw new Error("Built-in OpenAI Codex test model is unavailable");
		}
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [userMessage("old history")],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 42_000,
			fileOps: createFileOps(),
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		const context = {
			model: codexModel,
			modelRegistry: {
				isUsingOAuth: () => true,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "invalid" }),
			} as unknown as ExtensionContext["modelRegistry"],
			getSystemPrompt: () => "Riemann system",
			thinkingLevel: "low" as const,
		};
		await expect(
			createRiemannOpenAICompaction({
				preparation,
				customInstructions: "preserve errors",
				signal: new AbortController().signal,
				context,
				durableState: { version: 1 },
				sessionId: "session-1",
			}),
		).rejects.toThrow('strategy "openai" does not support custom instructions');

		const noOAuthContext = {
			...context,
			modelRegistry: {
				isUsingOAuth: () => false,
			} as unknown as ExtensionContext["modelRegistry"],
		};
		await expect(
			createRiemannOpenAICompaction({
				preparation,
				signal: new AbortController().signal,
				context: noOAuthContext,
				durableState: { version: 1 },
				sessionId: "session-1",
			}),
		).rejects.toThrow("requires OpenAI Codex subscription OAuth");

		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		).toString("base64");
		const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			createRiemannOpenAICompaction({
				preparation,
				signal: new AbortController().signal,
				context: {
					...context,
					modelRegistry: {
						isUsingOAuth: () => true,
						getApiKeyAndHeaders: async () => ({ ok: true, apiKey: `aaa.${tokenPayload}.bbb` }),
					} as unknown as ExtensionContext["modelRegistry"],
				},
				durableState: { version: 1 },
				sessionId: "session-1",
			}),
		)
			.rejects.toThrow()
			.finally(() => vi.unstubAllGlobals());
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
