import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function getThinkingMarkdownTheme(baseTheme: MarkdownTheme): MarkdownTheme {
	const quiet = (text: string) => theme.fg("thinkingText", text);
	return {
		...baseTheme,
		heading: quiet,
		link: quiet,
		linkUrl: quiet,
		code: quiet,
		codeBlock: quiet,
		codeBlockBorder: quiet,
		quote: quiet,
		quoteBorder: quiet,
		hr: quiet,
		listBullet: quiet,
		highlightCode: (code: string) => code.split("\n").map((line) => quiet(line)),
	};
}

function thinkingRecap(thinking: string, fallback: string, maxWidth = 120): string {
	const lines = thinking
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const lastHeader = [...lines].reverse().find((line) => /^\*\*[^*]+\*\*:?$/.test(line) || /^#{1,6}\s+\S/.test(line));
	const source = lastHeader ?? lines[0] ?? fallback;
	const plain = source
		.replace(/^#{1,6}\s+/, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.replace(/:$/, "")
		.trim();
	return truncateToWidth(plain || fallback, Math.max(20, maxWidth));
}

class CollapsedThinkingRow implements Component {
	private readonly recap: string;
	private readonly padding: number;

	constructor(recap: string, padding: number) {
		this.recap = recap;
		this.padding = padding;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const indent = " ".repeat(this.padding);
		return [truncateToWidth(`${indent}${theme.fg("thinkingText", this.recap)}`, safeWidth, "")];
	}

	invalidate(): void {}
}

const pendingContentUpdates = new WeakMap<
	AssistantMessageComponent,
	{ message: AssistantMessage; isStreaming: boolean }
>();

/** @internal Queue a display-only update until the component renders. */
export function queueAssistantMessageComponentUpdate(
	component: AssistantMessageComponent,
	message: AssistantMessage,
	isStreaming: boolean,
): void {
	pendingContentUpdates.set(component, { message, isStreaming });
}

/** @internal Reconcile the latest queued display update immediately. */
export function flushAssistantMessageComponentUpdate(component: AssistantMessageComponent): void {
	const pending = pendingContentUpdates.get(component);
	if (!pending) return;
	pendingContentUpdates.delete(component);
	component.updateContent(pending.message, pending.isStreaming);
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		flushAssistantMessageComponentUpdate(this);
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		pendingContentUpdates.delete(this);

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const combinedThinking = thinkingBlocks.join("\n\n");
				const runIndex = thinkingRunIndex++;
				const visibilityOverride = this.thinkingVisibilityOverrides.get(runIndex);
				const hidden = visibilityOverride ?? this.hideThinkingBlock;
				let thinkingComponent: Component;
				if (!hidden) {
					thinkingComponent = new Markdown(
						combinedThinking,
						this.outputPad,
						0,
						getThinkingMarkdownTheme(this.markdownTheme),
						{ color: (text: string) => theme.fg("thinkingText", text) },
						{
							transform: createMarkdownTransform(
								"assistant-thinking",
								this.isStreaming,
								this.markdownTransformers,
							),
						},
					);
				} else if (visibilityOverride === true) {
					thinkingComponent = new Text(
						theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)),
						this.outputPad,
						0,
					);
				} else {
					thinkingComponent = new CollapsedThinkingRow(
						thinkingRecap(combinedThinking, this.hiddenThinkingLabel),
						this.outputPad,
					);
				}
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
