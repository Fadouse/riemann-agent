import type * as BedrockSdk from "@aws-sdk/client-bedrock-runtime";
import type { ConverseStreamCommandOutput, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { parseStreamingJson } from "../src/utils/json-parse.ts";

const bedrock = vi.hoisted(() => ({ events: [] as ConverseStreamOutput[], fail: false }));
vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => {
	const actual = await importOriginal<typeof BedrockSdk>();
	return {
		...actual,
		BedrockRuntimeClient: class {
			async send(): Promise<ConverseStreamCommandOutput> {
				return {
					$metadata: {},
					stream: (async function* () {
						yield* bedrock.events;
						if (bedrock.fail) throw new Error("mock stream failure");
					})(),
				};
			}
		},
	};
});

type Provider = "completions" | "bedrock" | "mistral";
type Delta = { index: number; input: string | Record<string, unknown>; id?: string };
function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test",
		name: "Test",
		api,
		provider: "test",
		baseUrl: "https://unused.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
	};
}
function chunk(
	delta: ChatCompletionChunk.Choice.Delta,
	finish: ChatCompletionChunk.Choice["finish_reason"] = null,
): ChatCompletionChunk {
	return {
		id: "response-1",
		model: "test",
		object: "chat.completion.chunk",
		created: 0,
		choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
	};
}
function rawInput(delta: Delta): string {
	return typeof delta.input === "string" ? delta.input : JSON.stringify(delta.input);
}
async function run(
	provider: Provider,
	deltas: Delta[],
	options: { fail?: boolean; signal?: AbortSignal; stopBlocks?: boolean } = {},
): Promise<AssistantMessage> {
	const indices = [...new Set(deltas.map((delta) => delta.index))];
	if (provider === "bedrock") {
		bedrock.fail = options.fail ?? false;
		bedrock.events = [
			{ messageStart: { role: "assistant" } },
			...indices.map((index) => ({
				contentBlockStart: {
					contentBlockIndex: index,
					start: { toolUse: { toolUseId: `call-${index}`, name: `tool-${index}` } },
				},
			})),
			...deltas.map((delta) => ({
				contentBlockDelta: { contentBlockIndex: delta.index, delta: { toolUse: { input: rawInput(delta) } } },
			})),
			...(!options.fail && options.stopBlocks !== false
				? indices.map((index) => ({ contentBlockStop: { contentBlockIndex: index } }))
				: []),
			...(!options.fail ? [{ messageStop: { stopReason: "tool_use" as const } }] : []),
		];
		return streamBedrock(
			model("bedrock-converse-stream"),
			{ messages: [] },
			{ apiKey: "fake", signal: options.signal, env: { NO_PROXY: "*" } },
		).result();
	}
	const events = deltas.map((delta) =>
		chunk({
			tool_calls: [
				{
					index: delta.index,
					id: delta.id ?? `call-${delta.index}`,
					type: "function",
					function: { name: `tool-${delta.index}`, arguments: rawInput(delta) },
				},
			],
		}),
	);
	const wireEvents: unknown[] =
		provider === "mistral"
			? events.map((event, index) => ({
					...event,
					choices: [
						{
							...event.choices[0],
							delta: {
								tool_calls: [
									{
										index: deltas[index].index,
										id: `call-${deltas[index].index}`,
										function: { name: `tool-${deltas[index].index}`, arguments: deltas[index].input },
									},
								],
							},
						},
					],
				}))
			: events;
	if (options.fail) wireEvents.push({ error: { message: "mock stream failure" } });
	else wireEvents.push(chunk({}, "tool_calls"));
	const body = `${wireEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	const fetch: typeof globalThis.fetch = async () =>
		new Response(body, { headers: { "content-type": "text/event-stream" } });
	return provider === "completions"
		? streamCompletions(
				model("openai-completions"),
				{ messages: [] },
				{ apiKey: "fake", fetch, signal: options.signal },
			).result()
		: streamMistral(
				model("mistral-conversations"),
				{ messages: [] },
				{ apiKey: "fake", fetch, signal: options.signal },
			).result();
}
function capture(onDelta?: () => void) {
	const snapshots: unknown[] = [];
	const deltas: string[] = [];
	const types: AssistantMessageEvent["type"][] = [];
	const indices: number[] = [];
	const push = AssistantMessageEventStream.prototype.push;
	vi.spyOn(AssistantMessageEventStream.prototype, "push").mockImplementation(function (
		this: AssistantMessageEventStream,
		event,
	) {
		types.push(event.type);
		if (event.type === "toolcall_delta") {
			const block = event.partial.content[event.contentIndex];
			if (block?.type !== "toolCall") throw new Error("Missing tool block");
			snapshots.push(structuredClone(block.arguments));
			deltas.push(event.delta);
			indices.push(event.contentIndex);
			onDelta?.();
		}
		push.call(this, event);
	});
	return { snapshots, deltas, types, indices };
}
afterEach(() => vi.restoreAllMocks());
describe("remaining provider incremental tool JSON", () => {
	for (const provider of ["completions", "bedrock", "mistral"] as const) {
		it(`${provider} updates interleaved tools without reparsing long string prefixes`, async () => {
			const jsons = [
				JSON.stringify({ code: 'const x = "value";\nconst path = "C:\\tmp";\n'.repeat(400) }),
				JSON.stringify({ other: "y".repeat(16384), items: [1, true, null] }),
			];
			const deltas: Delta[] = [];
			const expected: unknown[] = [];
			const contentIndices: number[] = [];
			for (let offset = 0; offset < Math.max(...jsons.map((json) => json.length)); offset += 64) {
				for (let index = 0; index < jsons.length; index++) {
					if (offset >= jsons[index].length) continue;
					deltas.push({ index: index ? 7 : 2, input: jsons[index].slice(offset, offset + 64) });
					expected.push(parseStreamingJson(jsons[index].slice(0, offset + 64)));
					contentIndices.push(index);
				}
			}
			const observed = capture();
			const parse = vi.spyOn(JSON, "parse");
			const output = await run(provider, deltas);
			const parsedChars = parse.mock.calls.reduce((sum, [text]) => sum + (text.length > 2048 ? text.length : 0), 0);
			expect(output.stopReason, output.errorMessage).toBe("toolUse");
			expect(observed.deltas).toEqual(deltas.map(rawInput));
			expect(observed.snapshots).toEqual(expected);
			expect(observed.indices).toEqual(contentIndices);
			expect(observed.types.filter((type) => type === "toolcall_end")).toHaveLength(2);
			expect(output.content).toEqual(
				jsons.map((json, index) => ({
					type: "toolCall",
					id: `call-${index ? 7 : 2}`,
					name: `tool-${index ? 7 : 2}`,
					arguments: JSON.parse(json),
				})),
			);
			expect(parsedChars).toBeLessThan(jsons.reduce((sum, json) => sum + json.length, 0) * 8);
		});

		it(`${provider} preserves repair precedence and empty argument events`, async () => {
			const json = `${String.raw`{"path":"A\H","value":"before`}\t after"}`;
			const deltas: Delta[] = [...json].flatMap((char) => [
				{ index: 2, input: char },
				{ index: 2, input: "" },
			]);
			let partial = "";
			const expected = deltas.map((delta) => {
				partial += rawInput(delta);
				return parseStreamingJson(partial);
			});
			const observed = capture();
			const output = await run(provider, deltas);
			expect(output.stopReason, output.errorMessage).toBe("toolUse");
			expect(observed.deltas).toEqual(deltas.map(rawInput));
			expect(observed.snapshots).toEqual(expected);
			expect(output.content[0]).toEqual({
				type: "toolCall",
				id: "call-2",
				name: "tool-2",
				arguments: parseStreamingJson(json),
			});
		});

		for (const abort of [false, true]) {
			it(`${provider} preserves partial arguments and cleans scratch state on ${abort ? "abort" : "error"}`, async () => {
				const controller = new AbortController();
				const observed = capture(abort ? () => controller.abort() : undefined);
				const json = '{"partial":"kept';
				const output = await run(provider, [{ index: 2, input: json }], { fail: true, signal: controller.signal });
				expect(output.stopReason).toBe(abort ? "aborted" : "error");
				expect(observed.deltas).toEqual([json]);
				expect(observed.types.at(-1)).toBe("error");
				expect(output.content[0]).toEqual({
					type: "toolCall",
					id: "call-2",
					name: "tool-2",
					arguments: parseStreamingJson(json),
				});
			});
		}
	}

	it("Mistral retains object-valued arguments and concatenation semantics", async () => {
		const deltas: Delta[] = [
			{ index: 0, input: '{"nested":' },
			{ index: 0, input: { value: "first" } },
			{ index: 0, input: "}" },
		];
		const observed = capture();
		const output = await run("mistral", deltas);
		expect(output.stopReason).toBe("toolUse");
		expect(observed.deltas).toEqual(deltas.map(rawInput));
		expect(output.content[0]).toEqual({
			type: "toolCall",
			id: "call-0",
			name: "tool-0",
			arguments: { nested: { value: "first" } },
		});
	});

	it("Bedrock preserves the last partial snapshot when block stops are absent", async () => {
		const json = '{"value":"partial';
		const output = await run("bedrock", [{ index: 0, input: json }], { stopBlocks: false });
		expect(output.stopReason).toBe("toolUse");
		expect(output.content[0]).toEqual({
			type: "toolCall",
			id: "call-0",
			name: "tool-0",
			arguments: parseStreamingJson(json),
		});
	});

	it("Completions keeps parser identity when a tool ID arrives after its first arguments", async () => {
		const observed = capture();
		const output = await run("completions", [
			{ index: 2, id: "", input: '{"value":' },
			{ index: 2, id: "resolved-id", input: "42}" },
		]);
		expect(output.stopReason).toBe("toolUse");
		expect(observed.snapshots).toEqual([{}, { value: 42 }]);
		expect(output.content).toEqual([
			{ type: "toolCall", id: "resolved-id", name: "tool-2", arguments: { value: 42 } },
		]);
	});

	it("Completions preserves transitions from function fragments to custom tool input", async () => {
		const tools = [
			{ index: 0, id: "call-0", type: "function", function: { name: "tool-0", arguments: '{"old":"prefix' } },
			{ index: 0, type: "custom", custom: { name: "tool-0", input: "next" } },
			{ index: 0, type: "custom", custom: { name: "tool-0", input: " delta" } },
		];
		const events: unknown[] = tools.map((tool) => ({
			choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [tool] } }],
		}));
		events.push(chunk({}, "tool_calls"));
		const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
		const observed = capture();
		const output = await streamCompletions(
			model("openai-completions"),
			{ messages: [] },
			{
				apiKey: "fake",
				fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
			},
		).result();
		expect(output.stopReason, output.errorMessage).toBe("toolUse");
		expect(observed.snapshots).toEqual([
			{ old: "prefix" },
			{ input: "next" },
			{ input: "next delta" },
			{ input: "next delta" },
		]);
		expect(output.content).toEqual([
			{ type: "toolCall", id: "call-0", name: "tool-0", arguments: { input: "next delta" } },
		]);
	});
});
