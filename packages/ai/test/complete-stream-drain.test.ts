import { afterEach, describe, expect, it, vi } from "vitest";
import { complete, completeSimple, registerApiProvider, unregisterApiProviders } from "../src/compat.ts";
import { createModels, createProvider } from "../src/models.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"drain-test"> = {
	id: "test",
	name: "Test",
	api: "drain-test",
	provider: "drain-test",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};
function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 0,
	};
}
afterEach(() => {
	vi.restoreAllMocks();
	unregisterApiProviders("drain-test");
});
describe("result-only completion stream consumption", () => {
	for (const wrapper of [
		"models.complete",
		"models.completeSimple",
		"models.fetchDeferred",
		"compat.complete",
		"compat.completeSimple",
	] as const) {
		it(`${wrapper} consumes progress without suppressing any events`, async () => {
			const count = 1000;
			let peakQueued = 0;
			let deltaPushes = 0;
			const push = AssistantMessageEventStream.prototype.push;
			vi.spyOn(AssistantMessageEventStream.prototype, "push").mockImplementation(function (
				this: AssistantMessageEventStream,
				event,
			) {
				push.call(this, event);
				const state = this as unknown as { queue: unknown[]; queueHead: number };
				peakQueued = Math.max(peakQueued, state.queue.length - state.queueHead);
				if (event.type === "text_delta") deltaPushes++;
			});
			const output = message();
			const produce = () => {
				const stream = new AssistantMessageEventStream();
				void (async () => {
					stream.push({ type: "start", partial: output });
					for (let index = 0; index < count; index++) {
						await new Promise<void>((resolve) => setImmediate(resolve));
						const text = output.content[0];
						if (text.type !== "text") throw new Error("Expected text");
						text.text += "x";
						stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: output });
					}
					output.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message: output });
					stream.end();
				})();
				return stream;
			};
			const models = createModels();
			models.setProvider(
				createProvider({
					id: model.provider,
					models: [model],
					auth: { apiKey: { name: "fake", resolve: async () => ({ auth: {} }) } },
					api: { stream: produce, streamSimple: produce, fetchDeferred: produce },
				}),
			);
			registerApiProvider({ api: model.api, stream: produce, streamSimple: produce }, "drain-test");
			const calls = {
				"models.complete": () => models.complete(model, { messages: [] }),
				"models.completeSimple": () => models.completeSimple(model, { messages: [] }),
				"models.fetchDeferred": () =>
					models.fetchDeferred(model, {
						provider: model.provider,
						modelId: model.id,
						api: model.api,
						id: "deferred-test",
					}),
				"compat.complete": () => complete(model, { messages: [] }, { apiKey: "fake" }),
				"compat.completeSimple": () => completeSimple(model, { messages: [] }, { apiKey: "fake" }),
			};
			const result = await calls[wrapper]();
			expect(result).toBe(output);
			expect(result.content).toEqual([{ type: "text", text: "x".repeat(count) }]);
			expect(deltaPushes).toBe(
				wrapper === "models.fetchDeferred" ? count * 3 : wrapper.startsWith("models.") ? count * 2 : count,
			);
			expect(peakQueued).toBeLessThan(10);
		});
	}

	it("keeps direct stream.result() history available for subsequent iteration", async () => {
		const stream = new AssistantMessageEventStream();
		const output = message();
		stream.push({ type: "start", partial: output });
		stream.push({ type: "done", reason: "stop", message: output });
		expect(await stream.result()).toBe(output);
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		expect(types).toEqual(["start", "done"]);
	});
});
