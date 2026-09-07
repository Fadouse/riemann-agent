import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { closeOpenAICodexWebSocketSessions, stream } from "../src/api/openai-codex-responses.ts";
import type { Context, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.4",
	name: "test",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 1000,
};
const apiKey = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test", chatgpt_plan_type: "plus" } })).toString("base64url")}.signature`;
const metadata = {
	openaiCodexContext: {
		installation_id: "test",
		session_id: "test",
		thread_id: "test",
		agent_name: "/root",
		turn_id: "turn",
		window_id: "test:0",
		context_window_id: "window",
		window_number: 0,
	},
};
const complete = JSON.stringify({
	type: "response.completed",
	response: { id: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } },
});

class Socket extends EventTarget {
	static sent: string[] = [];
	readyState = 1;
	constructor() {
		super();
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}
	send(data: string) {
		Socket.sent.push(data);
		queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: complete })));
	}
	close() {
		this.readyState = 3;
	}
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	Socket.sent = [];
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it.each(["fresh", "restored"])("serializes only transmitted WebSocket data (%s context)", async (scenario) => {
	vi.stubGlobal("WebSocket", Socket);
	const context: Context = {
		systemPrompt: "tool instructions ".repeat(4000),
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	};
	if (scenario === "restored")
		context.messages.unshift({
			role: "user",
			content: [],
			timestamp: 0,
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{
						type: "agent_message",
						content: [{ type: "encrypted_content", encrypted_content: "A".repeat(16 * 1024 * 1024) }],
					},
				],
			},
		});
	const stringify = JSON.stringify;
	const costs: Array<{ chars: number; ms: number }> = [];
	vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
		const started = performance.now();
		const text = stringify(value, replacer, space);
		if (text && text.length > 60000) costs.push({ chars: text.length, ms: performance.now() - started });
		return text;
	});
	const first = await stream(model, context, { apiKey, metadata, transport: "auto", sessionId: "test" }).result();
	expect(first.stopReason).toBe("stop");
	const firstCosts = costs.splice(0);
	context.messages.push({ role: "user", content: "next", timestamp: 1 });
	const second = await stream(model, context, { apiKey, metadata, transport: "auto", sessionId: "test" }).result();
	expect(second.stopReason).toBe("stop");
	console.info({ scenario, first: firstCosts, next: costs });
	expect(JSON.parse(Socket.sent[1]).input).toHaveLength(1);
	expect(firstCosts).toHaveLength(1);
	expect(costs).toHaveLength(1); // Only the transmitted frame; no prefix/header comparison serialization.
});

it("compresses native SSE requests without synchronous zstd work on the UI thread", async () => {
	const payload = randomBytes(12 * 1024 * 1024).toString("base64");
	const context: Context = {
		messages: [
			{
				role: "user",
				content: [],
				timestamp: 0,
				providerPayload: {
					type: "openaiResponsesHistory",
					items: [{ type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: payload }] }],
				},
			},
		],
	};
	const sync = vi.spyOn(zlib, "zstdCompressSync");
	let eventLoopRan = false;
	const tick = new Promise<void>((resolve) =>
		setImmediate(() => {
			eventLoopRan = true;
			resolve();
		}),
	);
	let dispatchMs = 0;
	let responsiveAtDispatch = false;
	const started = performance.now();
	const result = await stream(model, context, {
		apiKey,
		metadata,
		transport: "sse",
		fetch: async (_url, init) => {
			dispatchMs = performance.now() - started;
			responsiveAtDispatch = eventLoopRan;
			expect(new Headers(init?.headers).get("content-encoding")).toBe("zstd");
			expect(init?.body).toBeInstanceOf(Uint8Array);
			return new Response(`data: ${complete}\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	}).result();
	await tick;
	console.info({ dispatchMs, responsiveAtDispatch, syncCompressionCalls: sync.mock.calls.length });
	expect(result.stopReason).toBe("stop");
	expect(sync.mock.calls.length).toBe(0);
	expect(responsiveAtDispatch).toBe(true);
});
