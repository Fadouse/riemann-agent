import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type * as CodexContextAPI from "@earendil-works/pi-ai/api/openai-codex-context";
import {
	discoverOpenAICodexContext,
	executeOpenAICodexContextTool,
	getOpenAICodexThreadHint,
} from "@earendil-works/pi-ai/api/openai-codex-context";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CODEX_CONTEXT_STATE,
	CodexContextSession,
	registerCodexContextHost,
	resolveCodexContextBudget,
} from "../src/core/codex-context-session.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("@earendil-works/pi-ai/api/openai-codex-context", async (importOriginal) => ({
	...(await importOriginal<typeof CodexContextAPI>()),
	discoverOpenAICodexContext: vi.fn(async () => ({
		eligible: true,
		model: {
			slug: "gpt-5.4",
			supports_experimental_context: true,
			context_window: 100000,
			auto_compact_token_limit: 90000,
			truncation_policy: { mode: "bytes", limit: 10000 },
		},
	})),
	getOpenAICodexThreadHint: vi.fn(async () => "fresh hint"),
	isOpenAICodexContextTool: (call: ToolCall) => call.namespace === "notes" || call.namespace === "history",
	executeOpenAICodexContextTool: vi.fn(async (_model, call: ToolCall) => ({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [],
		openaiCodexOutput: [{ type: "encrypted_content", encrypted_content: "PRIVATE" }],
		isError: false,
		timestamp: Date.now(),
	})),
}));

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.clearAllMocks();
});

async function createSession(
	respond: (context: Context, options?: SimpleStreamOptions) => string | ToolCall[] | AssistantMessage,
	restoredManager?: SessionManager,
) {
	const dir = mkdtempSync(join(tmpdir(), "codex-session-test-"));
	const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
	process.env.RIEMANN_CODING_AGENT_DIR = dir;
	cleanups.push(() => {
		if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
		else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
	});
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const model = getModel("openai-codex", "gpt-5.4")!;
	const auth = AuthStorage.create(join(dir, "auth.json"));
	await auth.modify("openai-codex", async () => ({ type: "api_key", key: "fake" }));
	const registry = await createModelRegistry(auth, dir);
	const runtime = getModelRuntime(registry);
	vi.spyOn(runtime, "isUsingOAuth").mockReturnValue(true);
	vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
	vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: "fake" } });
	const agent = new Agent({
		initialState: { model, tools: [], messages: restoredManager?.buildSessionContext().messages },
		convertToLlm,
		streamFn: (_model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const response = respond(context, options);
			const message: AssistantMessage = {
				...(typeof response === "object" && !Array.isArray(response)
					? response
					: {
							...fauxAssistantMessage(typeof response === "string" ? response : ""),
							...(Array.isArray(response) ? { content: response, stopReason: "toolUse" as const } : {}),
						}),
				api: model.api,
				provider: model.provider,
				model: model.id,
			};
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted")
					stream.push({ type: "error", reason: message.stopReason, error: message });
				else
					stream.push({
						type: "done",
						reason: message.stopReason === "pending" ? "deferred" : message.stopReason,
						message,
					});
			});
			return stream;
		},
	});
	const manager = restoredManager ?? SessionManager.inMemory(dir);
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory(),
		cwd: dir,
		modelRuntime: runtime,
		resourceLoader: createTestResourceLoader(),
		baseToolsOverride: {},
		customTools: [
			{
				name: "ipython",
				label: "Python",
				description: "Fake Python",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text", text: "tool tail must disappear" }],
					details: undefined,
				}),
			},
		],
	});
	cleanups.push(() => session.dispose());
	cleanups.push(
		registerCodexContextHost(manager.getSessionId(), {
			agentName: "/root",
			sharedSessionId: manager.getSessionId(),
			compactionStrategy: async () => "automatic",
			initialContext: async () => ({
				messages: [{ role: "user", content: "fresh runtime state", timestamp: Date.now() }],
			}),
		}),
	);
	return session;
}

function call(name: string, extra: Partial<ToolCall> = {}): ToolCall {
	return { type: "toolCall", id: name, name, arguments: {}, ...extra };
}

describe("Codex context through AgentSession", () => {
	it("activates before first generation and resets only after the complete tool batch", async () => {
		const contexts: Context[] = [];
		const identities: unknown[] = [];
		const session = await createSession((context, options) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			identities.push(options?.metadata?.openaiCodexContext);
			expect(discoverOpenAICodexContext).toHaveBeenCalledTimes(1);
			return contexts.length === 1 ? [call("new_context"), call("ipython")] : "done";
		});
		await session.prompt("original task must disappear after reset");
		expect(contexts).toHaveLength(2);
		expect(contexts[0].tools?.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["ipython", "new_context", "get_context_remaining"]),
		);
		expect(JSON.stringify(contexts[1])).not.toContain("original task must disappear");
		expect(JSON.stringify(contexts[1])).not.toContain("tool tail must disappear");
		expect(JSON.stringify(contexts[1])).toContain("fresh runtime state");
		const first = identities[0] as { context_window_id: string; window_number: number };
		const second = identities[1] as { context_window_id: string; window_number: number };
		expect(first.window_number).toBe(0);
		expect(second.window_number).toBe(1);
		expect(second.context_window_id).not.toBe(first.context_window_id);
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(getOpenAICodexThreadHint).toHaveBeenCalledTimes(2);
		const entries = session.sessionManager.getEntries();
		const resetIndex = entries
			.map((entry) => entry.type === "custom" && entry.customType === CODEX_CONTEXT_STATE)
			.lastIndexOf(true);
		const toolIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ipython",
		);
		expect(resetIndex).toBeGreaterThan(toolIndex);
	});

	it("dispatches native encrypted calls without user tool validation or public tool hooks", async () => {
		let count = 0;
		const native = call("write_file", {
			namespace: "notes",
			encryptedFunctionArgs: ["text"],
			arguments: { path: "a", text: "CIPHER" },
		});
		const session = await createSession(() => (++count === 1 ? [native] : "done"));
		const hook = vi.fn();
		session.agent.afterToolCall = hook;
		const executionNames: string[] = [];
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") executionNames.push(event.toolName);
		});
		await session.prompt("test");
		expect(executeOpenAICodexContextTool).toHaveBeenCalledWith(
			expect.anything(),
			native,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
		expect(hook).not.toHaveBeenCalled();
		expect(executionNames).toEqual([]);
		const result = session.agent.state.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({
			content: [],
			openaiCodexOutput: [{ type: "encrypted_content", encrypted_content: "PRIVATE" }],
		});
	});

	it("counts newly submitted input in preflight and retains only the unsampled input after capacity reset", async () => {
		vi.mocked(discoverOpenAICodexContext).mockResolvedValueOnce({
			eligible: true,
			model: {
				slug: "gpt-5.4",
				supports_experimental_context: true,
				context_window: 1000,
				auto_compact_token_limit: 800,
				truncation_policy: { mode: "bytes", limit: 10000 },
			},
		});
		const seen: Context[] = [];
		const session = await createSession((context) => {
			seen.push({ ...context, messages: structuredClone(context.messages) });
			return "done";
		});
		await session.prompt("A".repeat(1800));
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CODEX_CONTEXT_STATE),
		).toHaveLength(1);
		await session.prompt("B".repeat(1800));
		expect(seen).toHaveLength(2);
		expect(JSON.stringify(seen[1])).not.toContain("A".repeat(1800));
		expect(JSON.stringify(seen[1])).toContain("B".repeat(1800));
		expect(JSON.stringify(session.sessionManager.buildSessionContext().messages)).toContain("B".repeat(1800));
	});

	it("does not expose stale reset tools or ingestion metadata after OAuth is disabled", async () => {
		const requests: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
		const session = await createSession((context, options) => {
			requests.push({ context, options });
			return "done";
		});
		await session.prompt("first");
		vi.spyOn(session.modelRuntime, "isUsingOAuth").mockReturnValue(false);
		await session.prompt("second");
		expect(session.codexContextActive).toBe(false);
		expect(requests[1].context.tools?.map((tool) => tool.name)).not.toContain("new_context");
		expect(requests[1].options?.metadata?.openaiCodexContext).toBeUndefined();
	});

	it("honors manual reset cancellation without changing the durable window", async () => {
		const session = await createSession(() => "done");
		await session.prompt("test");
		const before = session.sessionManager.getLeafId();
		const emit = session.extensionRunner.emit.bind(session.extensionRunner);
		vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_compact") return { cancel: true };
			return emit(event);
		});
		await expect(session.compact()).rejects.toThrow("Compaction cancelled");
		expect(session.sessionManager.getLeafId()).toBe(before);
	});

	it("runs private history reads in parallel, without ordinary tool hooks", async () => {
		let count = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(executeOpenAICodexContextTool)
			.mockImplementationOnce(async (_model, native) => {
				await gate;
				return {
					role: "toolResult",
					toolCallId: native.id,
					toolName: native.name,
					content: [],
					isError: false,
					timestamp: Date.now(),
				};
			})
			.mockImplementationOnce(async (_model, native) => {
				release?.();
				return {
					role: "toolResult",
					toolCallId: native.id,
					toolName: native.name,
					content: [],
					isError: false,
					timestamp: Date.now(),
				};
			});
		const session = await createSession(() =>
			++count === 1
				? [call("list_windows", { namespace: "history" }), call("list_items", { namespace: "history" })]
				: "done",
		);
		await session.prompt("test");
		expect(executeOpenAICodexContextTool).toHaveBeenCalledTimes(2);
	});

	it("inherits native activation for eligible OAuth child models and uses distinct thread identity", async () => {
		const parent = await createSession(() => "parent");
		await parent.prompt("start");
		vi.mocked(discoverOpenAICodexContext).mockResolvedValueOnce({
			eligible: false,
			planType: "plus",
			model: {
				slug: "gpt-5.4",
				supports_experimental_context: false,
				context_window: 100000,
				truncation_policy: { mode: "bytes", limit: 10000 },
			},
		});
		let identity: unknown;
		const child = await createSession((_context, options) => {
			identity = options?.metadata?.openaiCodexContext;
			return "child";
		});
		cleanups.push(
			registerCodexContextHost(child.sessionId, {
				agentName: "/root/child",
				sharedSessionId: parent.sessionId,
				parentThreadId: parent.sessionId,
				compactionStrategy: async () => "automatic",
				initialContext: async () => ({ messages: [] }),
			}),
		);
		await child.prompt("start child");
		expect(identity).toMatchObject({
			session_id: parent.sessionId,
			thread_id: child.sessionId,
			agent_name: "/root/child",
			window_number: 0,
		});
	});

	it("returns overflow without compact-and-retry, then resets at the next prompt preflight", async () => {
		const contexts: Context[] = [];
		const session = await createSession((context) => {
			contexts.push({ ...context, messages: structuredClone(context.messages) });
			return contexts.length === 1
				? {
						...fauxAssistantMessage(""),
						stopReason: "error",
						errorMessage: "Your input exceeds the context window of this model.",
					}
				: "recovered";
		});
		await session.prompt("old overflowing user input");
		expect(contexts).toHaveLength(1);
		expect(
			session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CODEX_CONTEXT_STATE),
		).toHaveLength(1);
		await session.prompt("new user input");
		expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1])).not.toContain("old overflowing user input");
		expect(JSON.stringify(contexts[1])).toContain("new user input");
	});

	it("does not emit private execution events or execute truncated native calls", async () => {
		let count = 0;
		const native = call("write_file", {
			namespace: "notes",
			encryptedFunctionArgs: ["text"],
			arguments: { text: "TRUNCATED_PRIVATE" },
		});
		const session = await createSession(() =>
			++count === 1 ? { ...fauxAssistantMessage(""), content: [native], stopReason: "length" } : "done",
		);
		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") events.push(event.toolName);
		});
		await session.prompt("test");
		expect(executeOpenAICodexContextTool).not.toHaveBeenCalled();
		expect(events).toEqual([]);
	});

	it("uses the surviving saved compatibility hash when resuming onto a different model configuration", async () => {
		const remote = {
			slug: "gpt-5.4",
			supports_experimental_context: true,
			context_window: 100000,
			truncation_policy: { mode: "bytes" as const, limit: 10000 },
		};
		vi.mocked(discoverOpenAICodexContext).mockResolvedValueOnce({
			eligible: true,
			model: { ...remote, comp_hash: "old" },
		});
		const first = await createSession(() => "done");
		await first.prompt("previous model input");
		first.dispose();
		vi.mocked(discoverOpenAICodexContext).mockResolvedValueOnce({
			eligible: true,
			model: { ...remote, comp_hash: "new" },
		});
		let nextContext: Context | undefined;
		let identity: unknown;
		const resumed = await createSession((context, options) => {
			nextContext = context;
			identity = options?.metadata?.openaiCodexContext;
			return "done";
		}, first.sessionManager);
		await resumed.prompt("new model input");
		expect(identity).toMatchObject({ window_number: 1 });
		expect(JSON.stringify(nextContext)).not.toContain("previous model input");
		expect(JSON.stringify(nextContext)).toContain("new model input");
	});

	it("manual compact resets a tiny session without calling a summary provider", async () => {
		const session = await createSession(() => "done");
		await session.prompt("test");
		const result = await session.compact();
		expect(result.summary).toBe("");
		expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(JSON.stringify(session.agent.state.messages)).not.toContain('"text":"done"');
	});
});

describe("Codex durable window and budget state", () => {
	it("restores the exact window and excludes all prior tails", async () => {
		const manager = SessionManager.inMemory();
		const options = {
			sessionManager: manager,
			agentName: "/root",
			messages: [] as AgentMessage[],
			backend: {},
			budget: { contextWindow: 1000, tokenLimit: 900 },
			initialContext: async () => [] as AgentMessage[],
		};
		const lifecycle = await CodexContextSession.create(options);
		manager.appendMessage({ role: "user", content: "old", timestamp: Date.now() });
		lifecycle.requestReset();
		await lifecycle.advance(lifecycle.restoreMessages());
		manager.appendMessage({ role: "user", content: "new", timestamp: Date.now() });
		const restored = await CodexContextSession.create(options);
		expect(restored.state).toEqual(lifecycle.state);
		expect(JSON.stringify(restored.restoreMessages())).not.toContain('"content":"old"');
		expect(JSON.stringify(restored.restoreMessages())).toContain('"content":"new"');
	});
	it("persists developer reminders once per window and preserves unknown remaining budget", async () => {
		const manager = SessionManager.inMemory();
		const options = {
			sessionManager: manager,
			agentName: "/root",
			messages: [] as AgentMessage[],
			backend: {},
			budget: {
				contextWindow: 1000,
				tokenLimit: 10,
				reminderThresholdTokens: 10,
				reminderMessageTemplate: "Remaining {n_remaining}",
				fallbackPrompt: "Save notes",
				fallbackBufferTokens: 20,
			},
			initialContext: async () => [] as AgentMessage[],
		};
		const lifecycle = await CodexContextSession.create(options);
		const reminder = lifecycle.prepare([]);
		expect(JSON.stringify(reminder)).toContain('"role":"developer"');
		expect(JSON.stringify(reminder)).toContain("Remaining 10");
		const restored = await CodexContextSession.create(options);
		expect(restored.prepare([])).toEqual([]);
		restored.updateBudget({});
		expect(restored.remaining([])).toBeNull();
		const tool = restored.tools(() => []).find((tool) => tool.name === "get_context_remaining")!;
		expect(await tool.execute("id", {})).toMatchObject({
			content: [{ type: "text", text: "You have unknown tokens left in this context window." }],
		});
	});

	it("rebases inherited child checkpoints to fresh window zero and records the copied fork source", async () => {
		const parent = SessionManager.inMemory();
		const options = {
			sessionManager: parent,
			agentName: "/root",
			messages: [] as AgentMessage[],
			backend: {},
			budget: { contextWindow: 1000, tokenLimit: 900 },
			initialContext: async () => [] as AgentMessage[],
		};
		const lifecycle = await CodexContextSession.create(options);
		lifecycle.requestReset();
		await lifecycle.advance(lifecycle.restoreMessages());
		const parentId = parent.getSessionId();
		const parentWindow = lifecycle.state.windowId;
		parent.createBranchedSession(parent.getLeafId()!);
		const child = await CodexContextSession.create({ ...options, agentName: "/root/child" });
		expect(child.state.windowNumber).toBe(0);
		expect(child.state.firstWindowId).toBe(child.state.windowId);
		expect(child.state.windowId).not.toBe(parentWindow);
		expect(child.state.previousWindowId).toBeUndefined();
		expect(child.state.forkedFromThreadId).toBe(parentId);
	});

	it("writes the initial window checkpoint before any assistant response", async () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-initial-checkpoint-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const manager = SessionManager.create(dir, dir);
		const lifecycle = await CodexContextSession.create({
			sessionManager: manager,
			agentName: "/root",
			messages: [],
			backend: {},
			budget: {},
			initialContext: async () => [],
		});
		expect(existsSync(manager.getSessionFile()!)).toBe(true);
		expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain(lifecycle.state.windowId);
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.buildSessionContext().messages).toEqual(manager.buildSessionContext().messages);
	});

	it("separates raw-window 90% auto-limit from effective hard-cap headroom", () => {
		const remote = {
			slug: "test",
			supports_experimental_context: true,
			context_window: 1000,
			effective_context_window_percent: 95,
			truncation_policy: { mode: "bytes" as const, limit: 10000 },
		};
		expect(resolveCodexContextBudget(remote, 0)).toMatchObject({ contextWindow: 950, tokenLimit: 900 });
		expect(resolveCodexContextBudget({ ...remote, auto_compact_token_limit: 950 }, 0)).toMatchObject({
			tokenLimit: 900,
		});
		expect(
			resolveCodexContextBudget({ ...remote, context_window: undefined, max_context_window: 2000 }, 0),
		).toMatchObject({ contextWindow: 1900, tokenLimit: 1800 });
	});

	it("honors a newer ordinary compaction when native mode is reactivated", async () => {
		const manager = SessionManager.inMemory();
		const options = {
			sessionManager: manager,
			agentName: "/root",
			messages: [] as AgentMessage[],
			backend: {},
			budget: {},
			initialContext: async () => [] as AgentMessage[],
		};
		await CodexContextSession.create(options);
		manager.appendMessage({ role: "user", content: "discarded before ordinary summary", timestamp: Date.now() });
		const kept = manager.appendMessage({ role: "user", content: "kept after summary", timestamp: Date.now() });
		manager.appendCompaction("explicit semantic summary", kept, 100);
		const resumed = await CodexContextSession.create(options);
		expect(resumed.restoreMessages()).toEqual(manager.buildSessionContext().messages);
		expect(JSON.stringify(resumed.restoreMessages())).not.toContain("discarded before ordinary summary");
		expect(JSON.stringify(resumed.restoreMessages())).toContain("explicit semantic summary");
	});
	it("forces rollover when encrypted history output alone crosses the scoped budget", async () => {
		const manager = SessionManager.inMemory();
		const lifecycle = await CodexContextSession.create({
			sessionManager: manager,
			agentName: "/root",
			messages: [],
			backend: {},
			budget: { contextWindow: 10000, tokenLimit: 100 },
			initialContext: async () => [],
		});
		lifecycle.prepare([
			{
				role: "toolResult",
				toolCallId: "native",
				toolName: "read_item",
				content: [],
				openaiCodexOutput: [{ type: "encrypted_content", encrypted_content: "a".repeat(5000) }],
				isError: false,
				timestamp: Date.now(),
			},
		]);
		expect(lifecycle.pendingReset).toBe(true);
	});
});
