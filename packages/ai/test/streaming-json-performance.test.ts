import type Anthropic from "@anthropic-ai/sdk";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { stream as streamPi } from "../src/api/pi-messages.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { parseStreamingJson } from "../src/utils/json-parse.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function model<T extends Api>(api: T): Model<T> {
	return {
		id: "test",
		name: "Test",
		api,
		provider: "test",
		baseUrl: "https://unused.invalid",
		reasoning: false,
		input: ["text"],
		cost: usage.cost,
		contextWindow: 100000,
		maxTokens: 1000,
	};
}
function response(events: Record<string, unknown>[]): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
afterEach(() => vi.restoreAllMocks());
describe("incremental provider tool JSON", () => {
	for (const provider of ["responses", "anthropic", "pi"] as const) {
		for (const malformed of [false, true]) {
			it(`${provider} preserves every argument update${malformed ? " with repair" : " without reparsing prefixes"}`, async () => {
				const json = malformed
					? `${String.raw`{"path":"A\H","text":"a`}\tb"}`
					: JSON.stringify({ code: "x".repeat(16384), nested: { enabled: true } });
				const chunkSize = malformed ? 1 : 64;
				const deltas: string[] = [];
				const expected: unknown[] = [];
				for (let i = 0; i < json.length; i += chunkSize) {
					deltas.push(json.slice(i, i + chunkSize));
					expected.push(parseStreamingJson(json.slice(0, i + chunkSize)));
				}
				const parsed = JSON.parse(json.replace("A\\H", "A\\\\H").replace("\t", "\\t"));
				const snapshots: unknown[] = [];
				const emittedDeltas: string[] = [];
				const originalPush = AssistantMessageEventStream.prototype.push;
				vi.spyOn(AssistantMessageEventStream.prototype, "push").mockImplementation(function (
					this: AssistantMessageEventStream,
					event,
				) {
					if (event.type === "toolcall_delta") {
						const block = event.partial.content[event.contentIndex];
						if (block?.type === "toolCall") snapshots.push(structuredClone(block.arguments));
						emittedDeltas.push(event.delta);
					}
					originalPush.call(this, event);
				});
				const parseSpy = vi.spyOn(JSON, "parse");
				let output: AssistantMessage;
				if (provider === "responses") {
					output = {
						role: "assistant",
						content: [],
						api: "openai-responses",
						provider: "test",
						model: "test",
						usage,
						stopReason: "pending",
						timestamp: 0,
					};
					const events = [
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "edit", arguments: "" },
						},
						...deltas.map((delta) => ({
							type: "response.function_call_arguments.delta",
							output_index: 0,
							delta,
						})),
						{
							type: "response.output_item.done",
							output_index: 0,
							item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "edit", arguments: json },
						},
						{ type: "response.completed", response: { status: "completed" } },
					] as ResponseStreamEvent[];
					await processResponsesStream(
						{
							async *[Symbol.asyncIterator]() {
								yield* events;
							},
						},
						output,
						new AssistantMessageEventStream(),
						model("openai-responses"),
					);
				} else if (provider === "anthropic") {
					const body = response([
						{ type: "message_start", message: { id: "msg_1", model: "test", usage: {} } },
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "call_1", name: "edit", input: {} },
						},
						...deltas.map((delta) => ({
							type: "content_block_delta",
							index: 0,
							delta: { type: "input_json_delta", partial_json: delta },
						})),
						{ type: "content_block_stop", index: 0 },
						{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
						{ type: "message_stop" },
					]);
					const client = {
						beta: { messages: { create: () => ({ asResponse: async () => body }) } },
					} as unknown as Anthropic;
					output = await streamAnthropic(model("anthropic-messages"), { messages: [] }, { client }).result();
				} else {
					const body = response([
						{ type: "start" },
						{ type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "edit" },
						...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta })),
						{
							type: "toolcall_end",
							contentIndex: 0,
							toolCall: { type: "toolCall", id: "call_1", name: "edit", arguments: parsed },
						},
						{ type: "done", reason: "toolUse", usage },
					]);
					output = await streamPi(
						model("pi-messages"),
						{ messages: [] },
						{ apiKey: "fake", fetch: async () => body },
					).result();
				}
				const largeParseChars = parseSpy.mock.calls.reduce(
					(total, [input]) => total + (input.length > 2048 ? input.length : 0),
					0,
				);
				expect(output.stopReason).toBe("toolUse");
				expect(output.content[0]).toMatchObject({ arguments: parsed });
				expect(emittedDeltas).toEqual(deltas);
				expect(snapshots).toEqual(expected);
				if (!malformed) expect(largeParseChars).toBeLessThan(json.length * 8);
			});
		}
	}
});
