import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import type { FullscreenExitOutput } from "../src/core/settings-manager.ts";
import {
	AssistantMessageComponent,
	flushAssistantMessageComponentUpdate,
	queueAssistantMessageComponentUpdate,
} from "../src/modes/interactive/components/assistant-message.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type StreamingContext = {
	isInitialized: boolean;
	footer: { invalidate(): void };
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getShowTerminalProgress(): boolean;
	};
	ui: TUI;
	sessionManager: { getCwd(): string };
	session: { retryAttempt: number };
	toolOutputExpanded: boolean;
	chatContainer: Container;
	getRegisteredToolDefinition(): undefined;
	maybeShowAssistantDiagnostics(message: AssistantMessage): void;
	maybeShowCacheMissNotice(message: AssistantMessage): void;
	clearStatusIndicator(kind?: "working"): void;
};

type StopContext = {
	streamingComponent: AssistantMessageComponent | undefined;
	disposeActiveSelector(): void;
	settingsManager: { getShowTerminalProgress(): boolean };
	ui: TUI;
	clearStatusIndicator(): void;
	themeController: { disableAutoSync(): void };
	clearExtensionTerminalInputListeners(): void;
	footer: { dispose(): void };
	footerDataProvider: { dispose(): void };
	unsubscribe: (() => void) | undefined;
	isInitialized: boolean;
	stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void;
	unregisterSignalHandlers(): void;
};

type InteractiveModePrototype = {
	handleEvent(this: StreamingContext, event: AgentSessionEvent): Promise<void>;
	stop(this: StopContext, fullscreenExitOutput?: FullscreenExitOutput): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: EMPTY_USAGE,
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: Date.now(),
	};
}

function asEvent(event: object): AgentSessionEvent {
	return event as AgentSessionEvent;
}

function createStreamingContext(transform?: (markdown: string) => string): {
	context: StreamingContext;
	component: AssistantMessageComponent;
} {
	const requestRender = vi.fn();
	const ui = {
		requestRender,
		terminal: { setProgress: vi.fn() },
	} as unknown as TUI;
	const component = new AssistantMessageComponent(
		undefined,
		false,
		undefined,
		"Thinking...",
		1,
		transform ? [transform] : [],
	);
	const chatContainer = new Container();
	chatContainer.addChild(component);
	const context: StreamingContext = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		streamingComponent: component,
		streamingMessage: undefined,
		pendingTools: new Map(),
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowTerminalProgress: () => false,
		},
		ui,
		sessionManager: { getCwd: () => process.cwd() },
		session: { retryAttempt: 0 },
		toolOutputExpanded: false,
		chatContainer,
		getRegisteredToolDefinition: () => undefined,
		maybeShowAssistantDiagnostics: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		clearStatusIndicator: vi.fn(),
	};
	return { context, component };
}

function render(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("InteractiveMode assistant streaming display", () => {
	beforeAll(() => initTheme("dark"));

	test("coalesces fast token streams into the latest TUI reconciliation", async () => {
		const transformed: string[] = [];
		const { context, component } = createStreamingContext((markdown) => {
			transformed.push(markdown);
			return markdown;
		});
		const reconcile = vi.spyOn(component, "updateContent");

		for (let i = 1; i <= 100; i++) {
			await interactiveModePrototype.handleEvent.call(
				context,
				asEvent({
					type: "message_update",
					message: createAssistantMessage([{ type: "text", text: `stream state ${i}` }]),
				}),
			);
		}

		expect(reconcile).not.toHaveBeenCalled();
		expect(transformed).toEqual([]);
		expect(render(context.chatContainer)).toContain("stream state 100");
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(transformed).toEqual(["stream state 100"]);
	});

	test("does not reserialize unchanged native history on streaming redraws", async () => {
		const { context } = createStreamingContext();
		const imageUrl = `data:image/png;base64,${"A".repeat(1024 * 1024)}`;
		const serializeImage = vi.fn(() => ({ type: "input_image", image_url: imageUrl }));
		const image = { type: "input_image" as const, image_url: imageUrl, toJSON: serializeImage };
		const nativeResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "native-history",
			toolName: "read_item",
			content: [],
			openaiCodexOutput: [image],
			isError: false,
			timestamp: 0,
		};
		const previous = createAssistantMessage([]);
		previous.usage = { ...EMPTY_USAGE, input: 1000, totalTokens: 1000 };
		const messages = [previous, nativeResult];
		const model = { id: "codex-fixture", provider: "openai-codex", contextWindow: 272000 };
		const session = {
			model,
			state: { model },
			messages,
			_codexContext: {},
			sessionManager: { getBranch: () => [], getCwd: () => "/tmp", getSessionName: () => undefined },
			getContextUsage: AgentSession.prototype.getContextUsage,
		} as unknown as AgentSession;
		const readUsage = vi.spyOn(session, "getContextUsage");
		const footer = new FooterComponent(session, {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		});
		context.footer = footer;
		footer.render(120);
		for (let index = 0; index < 5; index++) {
			await interactiveModePrototype.handleEvent.call(
				context,
				asEvent({
					type: "message_update",
					message: createAssistantMessage([{ type: "text", text: `part ${index}` }]),
				}),
			);
			await interactiveModePrototype.handleEvent.call(
				context,
				asEvent({ type: "tool_execution_update", toolCallId: "pending" }),
			);
			await interactiveModePrototype.handleEvent.call(context, asEvent({ type: "bash_execution_update" }));
			render(context.chatContainer);
			footer.render(120);
		}
		expect(readUsage).toHaveBeenCalledTimes(1);
		expect(serializeImage).toHaveBeenCalledTimes(1);
		const final = createAssistantMessage([{ type: "text", text: "done" }]);
		final.usage = { ...EMPTY_USAGE, input: 2000, totalTokens: 2000 };
		messages.push(final);
		await interactiveModePrototype.handleEvent.call(context, asEvent({ type: "message_end", message: final }));
		footer.render(120);
		expect(readUsage).toHaveBeenCalledTimes(2);
		expect(readUsage.mock.results[1].value).toMatchObject({ tokens: 2000 });
	});

	test("reconciles the final message synchronously at message_end", async () => {
		const { context, component } = createStreamingContext();
		const reconcile = vi.spyOn(component, "updateContent");
		await interactiveModePrototype.handleEvent.call(
			context,
			asEvent({
				type: "message_update",
				message: createAssistantMessage([{ type: "text", text: "partial" }]),
			}),
		);
		const finalMessage = createAssistantMessage([{ type: "text", text: "complete answer" }]);

		await interactiveModePrototype.handleEvent.call(context, asEvent({ type: "message_end", message: finalMessage }));

		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(reconcile).toHaveBeenCalledWith(finalMessage, false);
		flushAssistantMessageComponentUpdate(component);
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(render(component)).toContain("complete answer");
		expect(context.streamingComponent).toBeUndefined();
		expect(context.streamingMessage).toBeUndefined();
	});

	test.each([
		{ namespace: "history", name: "search_contents" },
		{ namespace: "notes", name: "write_file" },
		{ name: "new_context" },
		{ name: "get_context_remaining" },
	])("does not create native Codex $name cards during streaming", async (call) => {
		const { context } = createStreamingContext();
		const message: AssistantMessage = {
			...createAssistantMessage([
				{ type: "text", text: "Public answer" },
				{ type: "toolCall", id: "private", ...call, arguments: { secret: "private payload" } },
			]),
			provider: "openai-codex",
			api: "openai-codex-responses",
		};
		const original = JSON.stringify(message);
		await interactiveModePrototype.handleEvent.call(context, asEvent({ type: "message_update", message }));
		expect(context.pendingTools.size).toBe(0);
		expect(render(context.chatContainer)).toContain("Public answer");
		expect(render(context.chatContainer)).not.toContain("private payload");
		await interactiveModePrototype.handleEvent.call(context, asEvent({ type: "message_end", message }));
		expect(JSON.stringify(message)).toBe(original);
	});

	test("creates tool components immediately and preserves final arguments and lifecycle", async () => {
		const { context } = createStreamingContext();
		const toolCallId = "tool-stream";
		await interactiveModePrototype.handleEvent.call(
			context,
			asEvent({
				type: "message_update",
				message: createAssistantMessage([
					{ type: "toolCall", id: toolCallId, name: "custom_tool", arguments: { path: "partial.txt" } },
				]),
			}),
		);

		const toolComponent = context.pendingTools.get(toolCallId);
		expect(toolComponent).toBeDefined();
		expect(render(toolComponent!)).toContain('"path": "partial.txt"');

		const finalMessage = createAssistantMessage(
			[{ type: "toolCall", id: toolCallId, name: "custom_tool", arguments: { path: "final.txt" } }],
			{ stopReason: "toolUse" },
		);
		await interactiveModePrototype.handleEvent.call(
			context,
			asEvent({ type: "message_update", message: finalMessage }),
		);
		await interactiveModePrototype.handleEvent.call(context, asEvent({ type: "message_end", message: finalMessage }));
		expect(render(toolComponent!)).toContain('"path": "final.txt"');
		expect(render(toolComponent!)).not.toContain("partial.txt");

		await interactiveModePrototype.handleEvent.call(
			context,
			asEvent({
				type: "tool_execution_start",
				toolCallId,
				toolName: "custom_tool",
				args: { path: "final.txt" },
			}),
		);

		await interactiveModePrototype.handleEvent.call(
			context,
			asEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "custom_tool",
				result: { content: [{ type: "text", text: "tool finished" }], details: undefined },
				isError: false,
			}),
		);
		expect(context.pendingTools.has(toolCallId)).toBe(false);
		expect(render(toolComponent!)).toContain("tool finished");
	});

	test.each([
		{
			stopReason: "aborted" as const,
			retryAttempt: 2,
			errorMessage: undefined,
			expected: "Aborted after 2 retry attempts",
		},
		{
			stopReason: "error" as const,
			retryAttempt: 0,
			errorMessage: "provider failed",
			expected: "Error: provider failed",
		},
	])("flushes $stopReason final state and clears streaming references", async (testCase) => {
		const { context, component } = createStreamingContext();
		context.session.retryAttempt = testCase.retryAttempt;
		await interactiveModePrototype.handleEvent.call(
			context,
			asEvent({
				type: "message_update",
				message: createAssistantMessage([{ type: "text", text: "partial answer" }]),
			}),
		);
		const finalMessage = createAssistantMessage([{ type: "text", text: "partial answer" }], {
			stopReason: testCase.stopReason,
			errorMessage: testCase.errorMessage,
		});

		await interactiveModePrototype.handleEvent.call(context, asEvent({ type: "message_end", message: finalMessage }));

		expect(render(component)).toContain(testCase.expected);
		expect(context.streamingComponent).toBeUndefined();
		expect(context.streamingMessage).toBeUndefined();
		expect(context.pendingTools.size).toBe(0);
	});

	test("flushes pending content before agent_end and stop cleanup", async () => {
		const agent = createStreamingContext();
		const agentReconcile = vi.spyOn(agent.component, "updateContent");
		queueAssistantMessageComponentUpdate(
			agent.component,
			createAssistantMessage([{ type: "text", text: "latest agent state" }]),
			true,
		);

		await interactiveModePrototype.handleEvent.call(
			agent.context,
			asEvent({ type: "agent_end", messages: [], willRetry: false }),
		);

		expect(agentReconcile).toHaveBeenCalledTimes(1);
		expect(agent.context.chatContainer.children).not.toContain(agent.component);
		flushAssistantMessageComponentUpdate(agent.component);
		expect(agentReconcile).toHaveBeenCalledTimes(1);

		const stopped = createStreamingContext();
		const stopReconcile = vi.spyOn(stopped.component, "updateContent");
		queueAssistantMessageComponentUpdate(
			stopped.component,
			createAssistantMessage([{ type: "text", text: "latest stop state" }]),
			true,
		);
		const unsubscribe = vi.fn();
		const stopContext: StopContext = {
			streamingComponent: stopped.component,
			disposeActiveSelector: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: stopped.context.ui,
			clearStatusIndicator: vi.fn(),
			themeController: { disableAutoSync: vi.fn() },
			clearExtensionTerminalInputListeners: vi.fn(),
			footer: { dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
			unsubscribe,
			isInitialized: false,
			stopInteractiveTui: vi.fn(),
			unregisterSignalHandlers: vi.fn(),
		};

		interactiveModePrototype.stop.call(stopContext, "transcript");

		expect(stopReconcile).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		flushAssistantMessageComponentUpdate(stopped.component);
		expect(stopReconcile).toHaveBeenCalledTimes(1);
	});
});
