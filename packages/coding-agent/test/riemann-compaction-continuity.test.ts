import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { type Api, type Context, contentText, type Model, type UserMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { createFileOps } from "../src/core/compaction/utils.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createRiemannCompaction, createRiemannSnapshotCompaction } from "../src/riemann/compaction.ts";
import { createRiemannOpenAICompaction } from "../src/riemann/openai-compaction.ts";
import {
	getPreservedOpenAICompaction,
	OPENAI_COMPACTION_PRESERVE_KEY,
} from "../src/riemann/openai-compaction-state.ts";
import { archiveSourceText, getPreservedArchive, PRESERVE_KEY } from "../src/riemann/snapshot-compaction.ts";

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function basePreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [userMessage("new history")],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 42_000,
		fileOps: createFileOps(),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

function defaultPreparation(summary: string): CompactionPreparation {
	return { ...basePreparation(), previousSummary: summary };
}

function snapshotPreparation(marker: string): CompactionPreparation {
	return {
		...basePreparation(),
		previousSummary: "snapshot reader instructions without transcript content",
		previousPreserveData: {
			[PRESERVE_KEY]: {
				frames: [],
				totalChars: marker.length,
				truncatedChars: 0,
				text: `¶user:${marker}`,
				textHead: `¶user:${marker}`,
			},
		},
	};
}

function openAIPreparation(options?: { marker?: string; opaque?: string }): CompactionPreparation {
	const marker = options?.marker ?? "OpenAI cloud context marker";
	const compactionItem = {
		type: "compaction",
		id: "cmp_old",
		encrypted_content: options?.opaque ?? "old-encrypted-context",
	} as const;
	return {
		...basePreparation(),
		previousSummary: marker,
		previousPreserveData: {
			[OPENAI_COMPACTION_PRESERVE_KEY]: {
				compactionItem,
				replacementHistory: [
					compactionItem,
					{ type: "message", role: "user", content: [{ type: "input_text", text: marker }] },
				],
			},
		},
	};
}

function codexModel(): Model<"openai-codex-responses"> {
	const model = getModel("openai-codex", "gpt-5.5");
	if (!model || model.api !== "openai-codex-responses") throw new Error("Codex test model is unavailable");
	return model;
}

function codexSse(): string {
	return `${[
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: { type: "compaction", id: "cmp_new", encrypted_content: "new-encrypted-context" },
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_new",
				status: "completed",
				usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
			},
		})}`,
	].join("\n\n")}\n\n`;
}

function oauthToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function requestBodyText(body: RequestInit["body"] | undefined): string {
	if (typeof body === "string") return body;
	if (!ArrayBuffer.isView(body)) throw new Error("Expected a string or compressed request body");
	return zstdDecompressSync(Buffer.from(body.buffer, body.byteOffset, body.byteLength)).toString("utf8");
}

function openAIContext(model = codexModel()) {
	return {
		model,
		modelRegistry: {
			isUsingOAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: oauthToken() }),
			complete: vi.fn(async () => fauxAssistantMessage("unexpected semantic fallback")),
		} as unknown as ExtensionContext["modelRegistry"],
		getSystemPrompt: () => "Riemann system",
		thinkingLevel: "low" as const,
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("Riemann compaction strategy continuity", () => {
	test("does not create a plaintext fallback when transitioning to OpenAI", async () => {
		for (const preparation of [
			defaultPreparation("default plaintext summary"),
			snapshotPreparation("snapshot plaintext transcript"),
		]) {
			const fetchMock = vi.fn(
				async (_input: string | URL | Request, _init?: RequestInit) => new Response(codexSse(), { status: 200 }),
			);
			vi.stubGlobal("fetch", fetchMock);
			const context = openAIContext();
			await createRiemannOpenAICompaction({
				preparation,
				signal: new AbortController().signal,
				context,
				durableState: {},
				sessionId: "session-1",
			});
			expect(fetchMock).toHaveBeenCalledOnce();
			const body = requestBodyText(fetchMock.mock.calls[0]?.[1]?.body);
			expect(body).not.toContain("default plaintext summary");
			expect(body).not.toContain("snapshot plaintext transcript");
			expect(context.modelRegistry.complete).not.toHaveBeenCalled();
		}
	});

	test("snapshot to semantic compaction directly follows previousSummary behavior", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Default test model is unavailable");
		let request = "";
		const complete = vi.fn(async (_model: Model<Api>, context: Context) => {
			request = contentText(context.messages[0]?.content ?? "");
			return fauxAssistantMessage("updated summary");
		});

		await createRiemannCompaction({
			preparation: snapshotPreparation("snapshot-to-default-plaintext"),
			includeImages: true,
			signal: new AbortController().signal,
			context: { model, modelRegistry: { complete } as unknown as ExtensionContext["modelRegistry"] },
			durableState: {},
		});

		expect(complete).toHaveBeenCalledOnce();
		expect(request).toContain("snapshot reader instructions without transcript content");
		expect(request).not.toContain("snapshot-to-default-plaintext");
	});

	test("replays the opaque item in one compact request without provider or model binding", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) => new Response(codexSse(), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const context = openAIContext();
		const result = await createRiemannOpenAICompaction({
			preparation: openAIPreparation({ marker: "host-only-marker", opaque: "unbound-encrypted" }),
			signal: new AbortController().signal,
			context,
			durableState: {},
			sessionId: "session-1",
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const body = requestBodyText(fetchMock.mock.calls[0]?.[1]?.body);
		expect(body).toContain("unbound-encrypted");
		expect(body).not.toContain("host-only-marker");
		expect(context.modelRegistry.complete).not.toHaveBeenCalled();
		const preserved = getPreservedOpenAICompaction(result.preserveData);
		expect(preserved).toMatchObject({
			compactionItem: { encrypted_content: "new-encrypted-context" },
		});
		expect(preserved).not.toHaveProperty("provider");
		expect(preserved).not.toHaveProperty("model");
		expect(result.summary).toContain("OpenAI Codex cloud compaction is active");
		expect(result.summary).not.toContain("unavailable");
		expect(result.preserveData).not.toHaveProperty(`${OPENAI_COMPACTION_PRESERVE_KEY}.portableFallback`);
	});

	test("replays opaque context after an OpenAI model change without defensive records", async () => {
		const fetchMock = vi.fn(
			async (_input: string | URL | Request, _init?: RequestInit) => new Response(codexSse(), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const model = { ...codexModel(), id: "gpt-5.5-different" };
		const context = openAIContext(model);
		const result = await createRiemannOpenAICompaction({
			preparation: openAIPreparation({ marker: "existing textual marker", opaque: "replayed-opaque" }),
			signal: new AbortController().signal,
			context,
			durableState: {},
			sessionId: "session-1",
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const body = requestBodyText(fetchMock.mock.calls[0]?.[1]?.body);
		expect(body).toContain("replayed-opaque");
		expect(body).not.toContain("existing textual marker");
		expect(body).not.toContain("unavailable");
		expect(context.modelRegistry.complete).not.toHaveBeenCalled();
		expect(result.details).toEqual({
			strategy: "openai",
			responseId: "resp_new",
		});
		expect(result.details).not.toHaveProperty("priorEncryptedContext");
		const preserved = getPreservedOpenAICompaction(result.preserveData);
		expect(preserved).not.toHaveProperty("provider");
		expect(preserved).not.toHaveProperty("model");
	});

	test("switching from OpenAI to semantic compaction follows ordinary previousSummary behavior", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Default test model is unavailable");
		let request = "";
		const complete = vi.fn(async (_model: Model<Api>, context: Context) => {
			request = contentText(context.messages[0]?.content ?? "");
			return fauxAssistantMessage("updated summary");
		});
		const result = await createRiemannCompaction({
			preparation: openAIPreparation({ marker: "existing cloud marker", opaque: "unavailable-opaque" }),
			includeImages: true,
			signal: new AbortController().signal,
			context: { model, modelRegistry: { complete } as unknown as ExtensionContext["modelRegistry"] },
			durableState: {},
		});

		expect(complete).toHaveBeenCalledOnce();
		expect(request).toContain("existing cloud marker");
		expect(request).not.toContain("unavailable-opaque");
		expect(request).not.toContain("unavailable after switching");
		expect(result.details).not.toHaveProperty("priorEncryptedContext");
	});

	test("switching from OpenAI to snapshot directly archives previousSummary", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Snapshot test model is unavailable");
		const result = await createRiemannSnapshotCompaction({
			preparation: openAIPreparation({ marker: "existing snapshot marker", opaque: "snapshot-opaque" }),
			signal: new AbortController().signal,
			context: { model },
			durableState: {},
		});
		const archive = getPreservedArchive(result.preserveData);
		if (!archive) throw new Error("Snapshot archive is unavailable");
		const text = archiveSourceText(archive);
		expect(text).toContain("existing snapshot marker");
		expect(text).not.toContain("unavailable after switching");
		expect(text).not.toContain("snapshot-opaque");
		expect(getPreservedOpenAICompaction(result.preserveData)).toBeUndefined();
		expect(result.details).not.toHaveProperty("priorEncryptedContext");
	});

	test("rejects length-truncated semantic summaries", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Default test model is unavailable");
		const complete = vi.fn(async () => fauxAssistantMessage("partial semantic summary", { stopReason: "length" }));

		await expect(
			createRiemannCompaction({
				preparation: defaultPreparation("prior semantic history"),
				includeImages: true,
				signal: new AbortController().signal,
				context: { model, modelRegistry: { complete } as unknown as ExtensionContext["modelRegistry"] },
				durableState: {},
			}),
		).rejects.toThrow("Riemann compaction failed: generation hit the token cap and the summary is incomplete");
		expect(complete).toHaveBeenCalledOnce();
	});

	test("OpenAI preserve data survives JSONL persistence without a portable fallback", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-openai-compaction-"));
		try {
			const preserveData = openAIPreparation({ marker: "persisted host marker" }).previousPreserveData;
			if (!preserveData) throw new Error("OpenAI preserve fixture is unavailable");
			const session = SessionManager.create(dir, dir);
			session.appendMessage(userMessage("recent suffix"));
			const keptEntryId = session.appendMessage(fauxAssistantMessage("assistant suffix"));
			session.appendCompaction("cloud placeholder", keptEntryId, 100, undefined, true, undefined, preserveData);
			const file = session.getSessionFile();
			if (!file) throw new Error("Persisted session file is unavailable");
			const jsonl = await readFile(file, "utf8");
			expect(jsonl).toContain('"openaiRemoteCompaction":{"compactionItem":');
			expect(jsonl).not.toContain("portableFallback");

			const restored = SessionManager.open(file);
			const messages = convertToLlm(restored.buildSessionContext().messages);
			const compacted = messages[0];
			expect(compacted?.role).toBe("user");
			const payload = compacted?.role === "user" ? compacted.providerPayload : undefined;
			expect(payload).toMatchObject({
				type: "openaiResponsesHistory",
				items: [
					{ type: "compaction", encrypted_content: "old-encrypted-context" },
					{ type: "message", role: "user" },
				],
			});
			expect(payload).not.toHaveProperty("provider");
			expect(payload).not.toHaveProperty("model");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
