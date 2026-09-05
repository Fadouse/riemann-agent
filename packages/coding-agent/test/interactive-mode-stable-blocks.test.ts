import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { MarkdownTransformer } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/modes/interactive/components/assistant-message.ts", { spy: true });

interface RenderContext {
	isInitialized: boolean;
	footer: { invalidate(): void };
	ui: { requestRender(): void };
	chatContainer: Container;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	streamingComponent?: AssistantMessageComponent;
	streamingMessage?: AssistantMessage;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getMarkdownTransformers(): MarkdownTransformer[];
}
interface TransformerContext {
	mermaidMarkdownTransformer: MarkdownTransformer;
	session: { extensionRunner: { getMarkdownTransformers(): MarkdownTransformer[] } };
}
const prototype = InteractiveMode.prototype as unknown as {
	handleEvent(this: RenderContext, event: AgentSessionEvent): Promise<void>;
	addMessageToChat(this: RenderContext, message: AssistantMessage): void;
	getMarkdownTransformers(this: TransformerContext): MarkdownTransformer[];
};
const message: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Complete answer" }],
	api: "openai-responses",
	provider: "openai",
	model: "test-model",
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

describe("InteractiveMode stable assistant blocks opt-in", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => vi.clearAllMocks());

	test.each([
		{ path: "streaming", extensions: false },
		{ path: "streaming", extensions: true },
		{ path: "history", extensions: false },
		{ path: "history", extensions: true },
	])("$path explicitly opts in only without extension transformers ($extensions)", async ({ path, extensions }) => {
		const builtin: MarkdownTransformer = (text) => text;
		const extension: MarkdownTransformer = (text) => text;
		const transformers = extensions ? [builtin, extension] : [builtin];
		// A second lookup would observe a different chain. The flag and constructor
		// must both use the one snapshot taken for this message.
		const getMarkdownTransformers = vi
			.fn()
			.mockReturnValueOnce(transformers)
			.mockReturnValue(extensions ? [builtin] : [builtin, extension]);
		const context: RenderContext = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			chatContainer: new Container(),
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers,
		};
		if (path === "streaming") {
			await prototype.handleEvent.call(context, { type: "message_start", message } as AgentSessionEvent);
		} else {
			prototype.addMessageToChat.call(context, message);
		}
		const constructorSpy = vi.mocked(AssistantMessageComponent);
		expect(constructorSpy).toHaveBeenCalledTimes(1);
		expect(constructorSpy.mock.calls[0]).toHaveLength(7);
		expect(constructorSpy.mock.calls[0][5]).toBe(transformers);
		expect(constructorSpy.mock.calls[0][6]).toBe(!extensions);
		expect(getMarkdownTransformers).toHaveBeenCalledTimes(1);
		expect(context.chatContainer.children).toHaveLength(1);
	});

	test("keeps Mermaid first and snapshots the complete extension chain once", () => {
		const builtin: MarkdownTransformer = (text) => text;
		const first: MarkdownTransformer = (text) => text;
		const second: MarkdownTransformer = (text) => text;
		const extensions = [first, second];
		const getMarkdownTransformers = vi.fn(() => extensions);
		const result = prototype.getMarkdownTransformers.call({
			mermaidMarkdownTransformer: builtin,
			session: { extensionRunner: { getMarkdownTransformers } },
		});
		expect(result).toEqual([builtin, first, second]);
		expect(result).not.toBe(extensions);
		expect(getMarkdownTransformers).toHaveBeenCalledTimes(1);
	});
});
