import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { FullscreenExitOutput } from "../src/core/settings-manager.ts";
import {
	AssistantMessageComponent,
	flushAssistantMessageComponentUpdate,
	queueAssistantMessageComponentUpdate,
} from "../src/modes/interactive/components/assistant-message.ts";
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
