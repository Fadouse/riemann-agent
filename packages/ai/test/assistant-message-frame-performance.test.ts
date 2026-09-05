import { expect, test, vi } from "vitest";
import type { AssistantMessage, ToolCall } from "../src/types.ts";
import { type AssistantMessageFrame, AssistantMessageFrameEncoder } from "../src/utils/assistant-message-frame.ts";

test("catches up queued tool deltas without reparsing the growing JSON and fixed snapshot", () => {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool",
		name: "ipython",
		arguments: { code: "x".repeat(65_536) },
	};
	const partial: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: "openai-responses",
		provider: "test",
		model: "test",
		timestamp: 0,
		stopReason: "pending",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const json = JSON.stringify(toolCall.arguments);
	const encoder = new AssistantMessageFrameEncoder();
	encoder.encode({ type: "start", partial });
	encoder.encode({ type: "toolcall_start", contentIndex: 0, partial });
	const parse = vi.spyOn(JSON, "parse");
	const frames: AssistantMessageFrame[] = [];
	try {
		for (let offset = 0; offset < json.length; offset += 64) {
			const frame = encoder.encode({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: json.slice(offset, offset + 64),
				partial,
			});
			if (frame) frames.push(frame);
		}
		expect(frames).toEqual([{ type: "toolcall_checkpoint", contentIndex: 0, json }]);
		expect(parse.mock.calls.reduce((sum, [text]) => sum + text.length, 0)).toBeLessThan(json.length * 2);
	} finally {
		parse.mockRestore();
	}
	expect(encoder.encode({ type: "toolcall_end", contentIndex: 0, partial, toolCall })).toMatchObject({
		type: "toolcall_end",
		arguments: toolCall.arguments,
	});
});

test("releases catch-up state when a stream terminates before toolcall_end", () => {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool", name: "ipython", arguments: { code: "large" } }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		timestamp: 0,
		stopReason: "error",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const encoder = new AssistantMessageFrameEncoder();
	encoder.encode({ type: "start", partial: message });
	encoder.encode({ type: "toolcall_start", contentIndex: 0, partial: message });
	encoder.encode({ type: "error", reason: "error", error: message });
	expect((encoder as unknown as { blocks: Map<number, unknown> }).blocks.size).toBe(0);
	expect(() => encoder.encode({ type: "start", partial: message })).toThrow("follows a terminal event");
});
