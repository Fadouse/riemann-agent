import { fauxAssistantMessage, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { estimateCodexContextTokens } from "../src/core/codex-context-token-estimate.ts";

const encrypted: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call|fc_server",
	toolName: "read_file",
	content: [],
	openaiCodexItemId: "fco_test",
	openaiCodexOutput: [{ type: "encrypted_content", encrypted_content: "x".repeat(1600) }],
	isError: false,
	timestamp: 0,
};
const wire = { type: "function_call_output", call_id: "call", id: "fco_test", output: encrypted.openaiCodexOutput };
const encryptedTokens = Math.ceil((Buffer.byteLength(JSON.stringify(wire)) - 1600 + Math.ceil((1600 * 9) / 16)) / 4);

describe("Codex native context estimates", () => {
	test("counts encrypted native outputs absent from the public tool content", () => {
		expect(estimateCodexContextTokens([encrypted]).tokens).toBe(encryptedTokens);
	});

	test("counts UTF-8 developer payloads instead of display fallback text", () => {
		const item = {
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "上下文".repeat(100) }],
		};
		const message: UserMessage = {
			role: "user",
			content: "not sent",
			timestamp: 0,
			providerPayload: { type: "openaiResponsesHistory", items: [item] },
		};
		expect(estimateCodexContextTokens([message]).tokens).toBe(Math.ceil(Buffer.byteLength(JSON.stringify(item)) / 4));
	});

	test("adds only unsampled native outputs to the last server usage", () => {
		const assistant = fauxAssistantMessage("done");
		assistant.usage.totalTokens = 100;
		expect(estimateCodexContextTokens([encrypted, assistant, encrypted])).toMatchObject({
			tokens: 100 + encryptedTokens,
			usageTokens: 100,
			trailingTokens: encryptedTokens,
			lastUsageIndex: 1,
		});
	});

	test("uses the Codex resized image estimate rather than the base64 payload size", () => {
		const url = `data:image/png;base64,${"A".repeat(40000)}`;
		const item = { type: "message", role: "user", content: [{ type: "input_image", image_url: url }] };
		const message: UserMessage = {
			role: "user",
			content: [],
			timestamp: 0,
			providerPayload: { type: "openaiResponsesHistory", items: [item] },
		};
		expect(estimateCodexContextTokens([message]).tokens).toBe(
			Math.ceil((Buffer.byteLength(JSON.stringify(item)) - 40000 + 7373) / 4),
		);
	});
	test("uses original-image patch counts and the encrypted-reasoning overhead", () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
		const item = {
			type: "message",
			role: "user",
			content: [{ type: "input_image", detail: "original", image_url: `data:image/png;base64,${png}` }],
		};
		const image: UserMessage = {
			role: "user",
			content: [],
			timestamp: 0,
			providerPayload: { type: "openaiResponsesHistory", items: [item] },
		};
		expect(estimateCodexContextTokens([image]).tokens).toBe(
			Math.ceil((Buffer.byteLength(JSON.stringify(item)) - png.length + 4) / 4),
		);
		const reasoning: UserMessage = {
			role: "user",
			content: [],
			timestamp: 0,
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [{ type: "reasoning", encrypted_content: "x".repeat(1600) }],
			},
		};
		expect(estimateCodexContextTokens([reasoning]).tokens).toBe(Math.ceil((1200 - 650) / 4));
	});
});
