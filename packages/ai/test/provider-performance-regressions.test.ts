import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { convertResponsesTools } from "../src/api/openai-responses-shared.ts";
import { createProvider } from "../src/models.ts";
import type { Api, Model, Tool } from "../src/types.ts";

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "fake",
		baseUrl: "https://unused.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 100,
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
describe("provider performance regressions", () => {
	it("converts strict schemas once, preserves mutation visibility and isolates returned schemas", () => {
		const tool: Tool = {
			name: "test",
			description: "test",
			parameters: Type.Object({ value: Type.String() }),
			constrainedSampling: { type: "json_schema", strict: "require" },
		};
		const clone = vi.spyOn(globalThis, "structuredClone");
		const first = convertResponsesTools([tool])[0];
		expect(clone.mock.calls.filter(([value]) => value === tool.parameters)).toHaveLength(1);
		if (first.type !== "function") throw new Error("Expected function tool");
		expect(first.parameters).not.toBe(tool.parameters);
		first.parameters!.description = "mutated output";
		Object.assign(tool.parameters, { description: "mutated input" });
		const second = convertResponsesTools([tool])[0];
		expect(second).toMatchObject({ parameters: { description: "mutated input" } });
	});

	it("merges dynamic catalogs in linear work while preserving order, duplicates and fresh results", async () => {
		let idReads = 0;
		const baseline = Array.from({ length: 200 }, (_, index) => {
			const entry = model(String(index));
			Object.defineProperty(entry, "id", {
				get: () => {
					idReads++;
					return String(index);
				},
				enumerable: true,
			});
			return entry;
		});
		const duplicate = model("0");
		baseline.push(duplicate);
		const dynamic = Array.from({ length: 200 }, (_, index) => model(String(index)));
		const extra = model("extra");
		const overlay = model("extra");
		dynamic.push(extra, overlay);
		for (const entry of dynamic) {
			const id = entry.id;
			Object.defineProperty(entry, "id", {
				get: () => {
					idReads++;
					return id;
				},
				enumerable: true,
			});
		}
		const provider = createProvider({
			id: "fake",
			auth: {},
			models: baseline,
			fetchModels: async () => dynamic,
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		});
		await provider.refreshModels!({
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		idReads = 0;
		const result = provider.getModels();
		expect(result).toHaveLength(202);
		expect(result[0]).toBe(dynamic[0]);
		expect(result[200]).toBe(duplicate);
		expect(result[201]).toBe(overlay);
		expect(idReads).toBeLessThan(1000);
		expect(provider.getModels()).not.toBe(result);
		dynamic[0].name = "changed";
		expect(provider.getModels()[0].name).toBe("changed");
	});

	it.each([400, 401, 403, 404, 422])("does not retry deterministic Codex HTTP %i failures", async (status) => {
		vi.useFakeTimers();
		const token = `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake" } })).toString("base64")}.fake`;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status }),
		);
		const result = streamCodex(
			model("fake") as Model<"openai-codex-responses">,
			{ messages: [] },
			{ apiKey: token, transport: "sse", fetch, maxRetries: 2 },
		).result();
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({ stopReason: "error", errorMessage: "bad request" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each(["network", 429, 500] as const)("preserves Codex recovery after %s failures", async (failure) => {
		vi.useFakeTimers();
		const token = `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake" } })).toString("base64")}.fake`;
		let attempts = 0;
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			if (attempts++ === 0) {
				if (failure === "network") throw new TypeError("fetch failed");
				return new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), { status: failure });
			}
			return new Response(
				`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } })}\n\n`,
			);
		});
		const result = streamCodex(
			model("fake") as Model<"openai-codex-responses">,
			{ messages: [] },
			{
				apiKey: token,
				transport: "sse",
				fetch,
				maxRetries: 2,
			},
		).result();
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({ stopReason: "stop", responseId: "resp_1" });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
