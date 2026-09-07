import { fauxAssistantMessage, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
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
	test("payload caches preserve escaping, caller mutations, framing, and image detail changes", () => {
		const encryptedPart = { type: "encrypted_content", encrypted_content: 'a"\\\n\u0000\ud800上下文🌍' };
		const item = { type: "function_call_output", output: [encryptedPart], label: "original" };
		const message: UserMessage = {
			role: "user",
			content: [],
			timestamp: 0,
			providerPayload: { type: "openaiResponsesHistory", items: [item] },
		};
		for (const value of [encryptedPart.encrypted_content, "short", "x".repeat(2000)]) {
			encryptedPart.encrypted_content = value;
			item.label += "changed";
			const encoded = Buffer.byteLength(value);
			expect(estimateCodexContextTokens([message]).tokens).toBe(
				Math.ceil((Buffer.byteLength(JSON.stringify(item)) - encoded + Math.ceil((encoded * 9) / 16)) / 4),
			);
			expect(encryptedPart.encrypted_content).toBe(value);
		}
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
		const imagePart = { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${png}` };
		const imageItem = { type: "message", content: [imagePart] };
		message.providerPayload = { type: "openaiResponsesHistory", items: [imageItem] };
		for (const detail of ["auto", "original", "auto"]) {
			imagePart.detail = detail;
			expect(estimateCodexContextTokens([message]).tokens).toBe(
				Math.ceil(
					(Buffer.byteLength(JSON.stringify(imageItem)) - png.length + (detail === "original" ? 4 : 7373)) / 4,
				),
			);
		}
	});

	test.each(["encrypted", "image"])("does not serialize large %s payloads for a footer estimate", (kind) => {
		const payload = "A".repeat(16 * 1024 * 1024);
		const part =
			kind === "encrypted"
				? { type: "encrypted_content", encrypted_content: payload }
				: { type: "input_image", image_url: `data:image/png;base64,${payload}` };
		const item = { type: "function_call_output", output: [part] };
		const message: UserMessage = {
			role: "user",
			content: [],
			timestamp: 0,
			providerPayload: { type: "openaiResponsesHistory", items: [item] },
		};
		const expected = Math.ceil(
			(Buffer.byteLength(JSON.stringify(item)) -
				payload.length +
				(kind === "encrypted" ? Math.ceil((payload.length * 9) / 16) : 7373)) /
				4,
		);
		const stringify = vi.spyOn(JSON, "stringify");
		try {
			const started = performance.now();
			for (let index = 0; index < 10; index++) expect(estimateCodexContextTokens([message]).tokens).toBe(expected);
			console.info({ kind, payloadMiB: 16, estimate10Ms: performance.now() - started });
			for (const [value] of stringify.mock.calls) {
				if (value === null || typeof value !== "object" || !("output" in value) || !Array.isArray(value.output))
					continue;
				for (const output of value.output) {
					expect(output.encrypted_content?.length ?? output.image_url?.length ?? 0).toBeLessThan(1024);
				}
			}
		} finally {
			stringify.mockRestore();
		}
	});

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
