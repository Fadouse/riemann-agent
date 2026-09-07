import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assignOpenAICodexContextItemIds,
	discoverOpenAICodexContext,
	executeOpenAICodexContextTool,
	getOpenAICodexThreadHint,
	type OpenAICodexContextIdentity,
	openAICodexContextMetadata,
	openAICodexContextTools,
} from "../src/api/openai-codex-context.ts";
import { closeOpenAICodexWebSocketSessions, streamSimple } from "../src/api/openai-codex-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Context, Model, ToolCall } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "new-remote-model",
	name: "Remote",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 10000,
};
const identity: OpenAICodexContextIdentity = {
	installation_id: "installation",
	session_id: "root",
	thread_id: "child",
	agent_name: "/root/child",
	turn_id: "turn",
	window_id: "child:2",
	context_window_id: "019caa00-0000-7000-8000-000000000000",
	window_number: 2,
	parent_thread_id: "root",
	parent_turn_id: "parent-turn",
	root_turn_id: "root-turn",
};
const budget = {
	enabled: true,
	use_history_notes_extension: true,
	reminder_threshold_tokens: 500,
	reminder_message_template: "Remaining {n_remaining}",
	guidance_message: "Guidance",
	auto_compact_fallback_prompt: "Fallback",
	auto_compact_fallback_buffer_tokens: 100,
};
const remote = {
	slug: model.id,
	supports_experimental_context: true,
	truncation_policy: { mode: "tokens", limit: 1000 },
	model_messages: { token_budget: budget },
	context_window: 100000,
};
function token(plan = "plus"): string {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account", chatgpt_plan_type: plan } })).toString("base64url")}.signature`;
}

function decode(body: RequestInit["body"]): Record<string, unknown> {
	return JSON.parse(typeof body === "string" ? body : Buffer.from(zstdDecompressSync(body as Uint8Array)).toString());
}

function sse(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
const completed = {
	type: "response.completed",
	response: { id: "response", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
};

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
});

describe("Codex native context protocol", () => {
	it.each(["plus", "pro", "prolite", "free", "enterprise", "unknown"])(
		"discovers remote capability for %s",
		async (plan) => {
			const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.2.3");
				expect(init?.method).toBe("GET");
				const headers = new Headers(init?.headers);
				expect(headers.get("authorization")).toBe(`Bearer ${token(plan)}`);
				expect(headers.get("chatgpt-account-id")).toBe("account");
				return Response.json({ models: [remote] });
			});
			const result = await discoverOpenAICodexContext(model, {
				apiKey: token(plan),
				fetch: fetchMock,
				clientVersion: "1.2.3",
			});
			expect(result.eligible).toBe(["plus", "pro", "prolite"].includes(plan));
			expect(result.model?.model_messages?.token_budget).toEqual(budget);
		},
	);
	it("fails closed for custom backends, unknown models and missing remote capability", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ models: [{ ...remote, supports_experimental_context: false }] }),
		);
		expect(
			(
				await discoverOpenAICodexContext(
					{ ...model, baseUrl: "https://proxy.invalid" },
					{ apiKey: token(), fetch: fetchMock },
				)
			).eligible,
		).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect((await discoverOpenAICodexContext(model, { apiKey: token(), fetch: fetchMock })).eligible).toBe(false);
		expect(
			(await discoverOpenAICodexContext({ ...model, id: "unknown" }, { apiKey: token(), fetch: fetchMock }))
				.eligible,
		).toBe(false);
	});
	it("validates remote budgets and numeric model limits", async () => {
		for (const invalid of [
			{ ...remote, context_window: -1 },
			{ ...remote, effective_context_window_percent: 101 },
			{ ...remote, truncation_policy: { mode: "tokens", limit: 1.5 } },
			{ ...remote, model_messages: { token_budget: { ...budget, reminder_threshold_tokens: "500" } } },
		]) {
			await expect(
				discoverOpenAICodexContext(model, {
					apiKey: token(),
					fetch: async () => Response.json({ models: [invalid] }),
				}),
			).rejects.toThrow("Invalid Codex model");
		}
	});
	it("advertises nine exact native functions and four encrypted fields", () => {
		expect(openAICodexContextTools.map((tool) => tool.type)).toEqual(["namespace", "namespace"]);
		const functions = openAICodexContextTools.flatMap((tool) => (tool.type === "namespace" ? tool.tools : []));
		expect(functions).toHaveLength(9);
		expect(functions.every((tool) => tool.type === "function" && tool.strict === false)).toBe(true);
		expect(JSON.stringify(functions).match(/"encrypted":true/g)).toHaveLength(4);
	});
	it("uses exact routes, trusted identity, headers and native encrypted image output", async () => {
		for (const namespace of openAICodexContextTools) {
			if (namespace.type !== "namespace") continue;
			for (const tool of namespace.tools) {
				const call: ToolCall = {
					type: "toolCall",
					id: "call|fc_1",
					namespace: namespace.name,
					name: tool.name,
					arguments: { context: { session_id: "untrusted" }, query: "opaque" },
					encryptedFunctionArgs: ["query"],
				};
				const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
					expect(String(url)).toBe(
						`https://chatgpt.com/backend-api/codex/alpha/${namespace.name}/v2/${tool.name}`,
					);
					expect(init?.method).toBe("POST");
					expect(JSON.parse(String(init?.body)).context).toEqual({
						session_id: "root",
						current_agent_name: "/root/child",
					});
					const headers = new Headers(init?.headers);
					expect(headers.get("x-openai-tool-output-truncation-policy")).toBe('{"mode":"tokens","limit":1000}');
					expect(headers.get("x-openai-encrypted-tool-arguments")).toBe(
						["search_contents", "append_to_file", "write_file"].includes(tool.name) ? "true" : null,
					);
					return Response.json({
						encrypted_output: "opaque-result",
						images: [{ data: "YWJj", mime_type: "image/png", detail: "original" }],
					});
				});
				const result = await executeOpenAICodexContextTool(
					model,
					call,
					identity,
					{ mode: "tokens", limit: 1000 },
					{ apiKey: token(), fetch: fetchMock },
				);
				expect(result.content).toEqual([]);
				expect(result.openaiCodexOutput).toEqual([
					{ type: "encrypted_content", encrypted_content: "opaque-result" },
					{ type: "input_image", image_url: "data:image/png;base64,YWJj", detail: "original" },
				]);
				const persisted = JSON.parse(JSON.stringify(result));
				const replay = convertResponsesMessages(model, { messages: [persisted] }, new Set(["openai-codex"]));
				expect(replay[0]).toMatchObject({
					type: "function_call_output",
					call_id: "call",
					id: result.openaiCodexItemId,
					output: result.openaiCodexOutput,
				});
			}
		}
	});
	it("validates attachments and sanitizes backend failures", async () => {
		const call: ToolCall = {
			type: "toolCall",
			id: "call",
			namespace: "notes",
			name: "read_file",
			arguments: { path: "note" },
		};
		for (const images of [{}, [{ data: "abc" }], [{ data: "abc", mime_type: "image/png", detail: "bad" }]]) {
			await expect(
				executeOpenAICodexContextTool(
					model,
					call,
					identity,
					{ mode: "bytes", limit: 100 },
					{ apiKey: token(), fetch: async () => Response.json({ images }) },
				),
			).rejects.toThrow("invalid image");
		}
		await expect(
			executeOpenAICodexContextTool(
				model,
				call,
				identity,
				{ mode: "bytes", limit: 100 },
				{
					apiKey: token(),
					fetch: async () => {
						throw new Error("secret URL");
					},
				},
			),
		).rejects.toThrow("Unable to perform operation: The backend request failed.");
	});
	it("serializes nonencrypted output without image attachments", async () => {
		const result = await executeOpenAICodexContextTool(
			model,
			{ type: "toolCall", id: "c", namespace: "notes", name: "read_file", arguments: {} },
			identity,
			{ mode: "bytes", limit: 100 },
			{ apiKey: token(), fetch: async () => Response.json({ text: "note", images: [] }) },
		);
		expect(result.openaiCodexOutput).toEqual([{ type: "input_text", text: '{"text":"note"}' }]);
	});
	it.each(["hint", "", "é".repeat(2001), null, 7])("bounds thread hints in UTF-8 bytes (%j)", async (text) => {
		const hint = await getOpenAICodexThreadHint(model, identity, {
			apiKey: token(),
			fetch: async (url, init) => {
				expect(String(url)).toContain("alpha/notes/v2/thread_hint");
				expect(new Headers(init?.headers).get("x-openai-tool-output-truncation-policy")).toBe(
					'{"mode":"bytes","limit":4000}',
				);
				return Response.json({ text });
			},
		});
		expect(hint).toBe(text === "hint" ? "hint" : undefined);
	});
	it("ignores hint failures", async () => {
		expect(
			await getOpenAICodexThreadHint(model, identity, {
				apiKey: token(),
				fetch: async () => new Response("private", { status: 500 }),
			}),
		).toBeUndefined();
	});
	it("preserves identity, native tools, encrypted args and replay through SSE", async () => {
		const item = {
			type: "function_call",
			id: "fc_server",
			call_id: "call",
			namespace: "notes",
			name: "write_file",
			arguments: '{"path":"note","text":"ciphertext"}',
			encrypted_function_args: ["text"],
		};
		const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = decode(init?.body);
			expect(body.tools).toEqual(openAICodexContextTools);
			const expected = openAICodexContextMetadata(identity);
			expect(body.client_metadata).toEqual(expected.clientMetadata);
			expect(new Headers(init?.headers).get("x-codex-turn-metadata")).toBe(
				expected.headers["x-codex-turn-metadata"],
			);
			return sse([
				{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
				{ type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
				{ type: "response.output_item.done", output_index: 0, item },
				completed,
			]);
		});
		const result = await streamSimple(
			model,
			{ messages: [] },
			{ apiKey: token(), fetch: fetchMock, transport: "sse", metadata: { openaiCodexContext: identity } },
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			namespace: "notes",
			encryptedFunctionArgs: ["text"],
			arguments: { path: "note", text: "ciphertext" },
		});
		const replay = convertResponsesMessages(
			model,
			{ messages: [JSON.parse(JSON.stringify(result))] },
			new Set(["openai-codex"]),
		);
		expect(replay[0]).toMatchObject(item);
		expect(
			convertResponsesMessages(
				{ ...model, id: "compatible-new-model" },
				{ messages: [result] },
				new Set(["openai-codex"]),
			)[0],
		).toMatchObject(item);
	});
	it("assigns stable UUIDv7 item IDs once and preserves server IDs through persistence", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hello", timestamp: 1 },
				{
					role: "user",
					content: [],
					timestamp: 2,
					providerPayload: {
						type: "openaiResponsesHistory",
						items: [
							{ role: "developer", content: "initial" },
							{ type: "message", id: "server-id", role: "developer", content: "existing" },
						],
					},
				},
				{ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 3 },
			],
		};
		assignOpenAICodexContextItemIds(context.messages);
		const persisted: Context = JSON.parse(JSON.stringify(context));
		assignOpenAICodexContextItemIds(persisted.messages);
		expect(persisted).toEqual(context);
		const input = convertResponsesMessages(model, persisted, new Set(["openai-codex"]));
		expect(input[0]).toHaveProperty(
			"id",
			context.messages[0].role === "user" ? context.messages[0].openaiCodexItemId : undefined,
		);
		expect(input[1]).toHaveProperty("id", expect.stringMatching(/^msg_.*-7[0-9a-f]{3}-/));
		expect(input[2]).toHaveProperty("id", "server-id");
	});
	it("does not opt normal requests into native context", async () => {
		const result = await streamSimple(
			model,
			{ messages: [] },
			{
				apiKey: token(),
				transport: "sse",
				fetch: async (_url, init) => {
					const body = decode(init?.body);
					expect(body.client_metadata).toBeUndefined();
					expect(body.tools).toBeUndefined();
					return sse([completed]);
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
	});
	it("sends the same ingestion identity through WebSocket headers and response.create", async () => {
		const expected = openAICodexContextMetadata(identity);
		class Socket {
			readyState = 1;
			listeners = new Map<string, Set<(event: unknown) => void>>();
			constructor(_url: string, options: { headers: Record<string, string> }) {
				expect(options.headers["x-codex-turn-metadata"]).toBe(expected.headers["x-codex-turn-metadata"]);
				queueMicrotask(() => this.emit("open", {}));
			}
			addEventListener(type: string, listener: (event: unknown) => void) {
				const set = this.listeners.get(type) ?? new Set();
				set.add(listener);
				this.listeners.set(type, set);
			}
			removeEventListener(type: string, listener: (event: unknown) => void) {
				this.listeners.get(type)?.delete(listener);
			}
			emit(type: string, event: unknown) {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
			close() {
				this.readyState = 3;
			}
			send(data: string) {
				const body = JSON.parse(data);
				expect(body.type).toBe("response.create");
				expect(body.client_metadata).toEqual(expected.clientMetadata);
				expect(body.tools).toEqual(openAICodexContextTools);
				queueMicrotask(() => this.emit("message", { data: JSON.stringify(completed) }));
			}
		}
		vi.stubGlobal("WebSocket", Socket);
		const result = await streamSimple(
			model,
			{ messages: [] },
			{
				apiKey: token(),
				transport: "websocket",
				metadata: { openaiCodexContext: identity },
				fetch: async () => {
					throw new Error("Unexpected SSE fallback");
				},
			},
		).result();
		expect(result.stopReason).toBe("stop");
	});
	it("preserves explicitly empty encrypted field lists", async () => {
		const item = {
			type: "function_call",
			id: "fc_empty",
			call_id: "c",
			namespace: "history",
			name: "list_windows",
			arguments: "{}",
			encrypted_function_args: [],
		};
		const result = await streamSimple(
			model,
			{ messages: [] },
			{
				apiKey: token(),
				transport: "sse",
				fetch: async () => sse([{ type: "response.output_item.done", output_index: 0, item }, completed]),
			},
		).result();
		expect(result.content[0]).toHaveProperty("encryptedFunctionArgs", []);
		expect(convertResponsesMessages(model, { messages: [result] }, new Set(["openai-codex"]))[0]).toHaveProperty(
			"encrypted_function_args",
			[],
		);
	});
	it("stamps item history metadata once before persistence", () => {
		const messages: Context["messages"] = [{ role: "user", content: "first", timestamp: 1234 }];
		assignOpenAICodexContextItemIds(messages, "turn-1");
		assignOpenAICodexContextItemIds(messages, "turn-2");
		expect(convertResponsesMessages(model, { messages }, new Set(["openai-codex"]))[0]).toMatchObject({
			internal_chat_message_metadata_passthrough: { turn_id: "turn-1", create_time: 1.234 },
		});
	});
	it("keeps a plain backend result as native string output when there are no attachments", async () => {
		const result = await executeOpenAICodexContextTool(
			model,
			{ type: "toolCall", id: "c", namespace: "history", name: "list_windows", arguments: {} },
			identity,
			{ mode: "bytes", limit: 100 },
			{ apiKey: token(), fetch: async () => Response.json({ windows: [] }) },
		);
		expect(result.openaiCodexOutput).toBe('{"windows":[]}');
	});
});
