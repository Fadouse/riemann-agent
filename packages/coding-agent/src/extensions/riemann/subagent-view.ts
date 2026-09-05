import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	Input,
	isKeyRepeat,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { AssistantMessageComponent } from "../../modes/interactive/components/assistant-message.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { ToolExecutionComponent } from "../../modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../modes/interactive/components/user-message.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../../riemann/agents/supervisor.ts";
import type { RiemannRuntime } from "../../riemann/runtime.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import {
	fitSubagentHints,
	formatFleetElapsed,
	isActiveSubagent,
	subagentBackHint,
	subagentIdentityLine,
	subagentReleaseFooterRows,
	subagentReleaseLines,
	subagentStatusText,
	wrapSubagentHints,
} from "./subagent-display.ts";

const VIEWPORT_HEIGHT_PERCENT = 70;
const CLOCK_TICK_MS = 80;
const UPDATE_COALESCE_MS = 32;

function isVisuallyBlank(line: string): boolean {
	return stripAnsi(line).trim().length === 0;
}

function trimVisualBlankEdges(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isVisuallyBlank(lines[start] ?? "")) start += 1;
	while (end > start && isVisuallyBlank(lines[end - 1] ?? "")) end -= 1;
	return lines.slice(start, end);
}

interface ViewerKeys {
	cancel(data: string): boolean;
	close(data: string): boolean;
	scrollUp(data: string): boolean;
	scrollDown(data: string): boolean;
	pageUp(data: string): boolean;
	pageDown(data: string): boolean;
	home(data: string): boolean;
	end(data: string): boolean;
	message(data: string): boolean;
	stop(data: string): boolean;
	release(data: string): boolean;
	toggleThinking(data: string): boolean;
	toggleTools(data: string): boolean;
}

function createViewerKeys(keybindings: KeybindingsManager): ViewerKeys {
	return {
		cancel: (data) => keybindings.matches(data, "tui.select.cancel"),
		close: (data) => keybindings.matches(data, "app.agents.close"),
		scrollUp: (data) =>
			keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "app.agents.previous"),
		scrollDown: (data) =>
			keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "app.agents.next"),
		pageUp: (data) => keybindings.matches(data, "tui.select.pageUp"),
		pageDown: (data) => keybindings.matches(data, "tui.select.pageDown"),
		home: (data) => keybindings.matches(data, "app.agents.home"),
		end: (data) => keybindings.matches(data, "app.agents.end"),
		message: (data) => keybindings.matches(data, "app.agents.message"),
		stop: (data) => keybindings.matches(data, "app.agents.stop"),
		release: (data) => keybindings.matches(data, "app.agents.release"),
		toggleThinking: (data) => keybindings.matches(data, "app.agents.toggleThinking"),
		toggleTools: (data) => keybindings.matches(data, "app.tools.expand"),
	};
}

export async function runSubagentView(
	context: ExtensionContext,
	runtime: RiemannRuntime,
	agentId: string,
	state: SubagentViewState = {},
): Promise<void> {
	if (context.mode !== "tui") return;
	await context.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new SubagentConversationViewer({ context, runtime, agentId, tui, theme, keybindings, done, state }),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PERCENT}%` },
		},
	);
}

export interface SubagentViewState {
	scrollOffset?: number;
	autoScroll?: boolean;
	hideThinking?: boolean;
	toolsExpanded?: boolean;
	draft?: string;
}

interface SubagentConversationViewerOptions {
	context: ExtensionContext;
	runtime: RiemannRuntime;
	agentId: string;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: () => void;
	state?: SubagentViewState;
}

export class SubagentConversationViewer implements Component, Focusable {
	private readonly context: ExtensionContext;
	private readonly runtime: RiemannRuntime;
	private readonly agentId: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keys: ViewerKeys;
	private readonly done: () => void;
	private readonly unsubscribe: () => void;
	private readonly state: SubagentViewState;
	private draft = "";
	private releaseScroll = 0;
	private pendingTools: Array<{ component: ToolExecutionComponent; start: number; count: number }> = [];
	private scrollOffset = 0;
	private autoScroll = true;
	private lastInnerWidth = 1;
	private hideThinking = true;
	private stopArmed = false;
	private releaseArmed = false;
	private toolsExpanded = false;
	private sending = false;
	private stopping = false;
	private releasing = false;
	private closed = false;
	private disposed = false;
	private composer: Input | undefined;
	private clockTimer: NodeJS.Timeout | undefined;
	private updateTimer: NodeJS.Timeout | undefined;
	private contentRevision = 0;
	private contentCache:
		| { width: number; revision: number; hideThinking: boolean; toolsExpanded: boolean; lines: string[] }
		| undefined;
	private _focused = false;

	constructor(options: SubagentConversationViewerOptions) {
		this.context = options.context;
		this.runtime = options.runtime;
		this.agentId = options.agentId;
		this.tui = options.tui;
		this.theme = options.theme;
		this.keys = createViewerKeys(options.keybindings);
		this.done = options.done;
		this.state = options.state ?? {};
		this.scrollOffset = this.state.scrollOffset ?? 0;
		this.autoScroll = this.state.autoScroll ?? true;
		this.hideThinking = this.state.hideThinking ?? true;
		this.toolsExpanded = this.state.toolsExpanded ?? false;
		this.draft = this.state.draft ?? "";
		this.unsubscribe = this.runtime.subscribeSubagentUi((changedAgentId?: string) => {
			if (changedAgentId === undefined || changedAgentId === this.agentId) this.scheduleDataRender();
		});
		this.syncClock();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.composer) this.composer.focused = value;
	}

	handleInput(data: string): void {
		if (this.composer) {
			this.composer.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (this.keys.cancel(data) || this.keys.close(data)) {
			if (isKeyRepeat(data)) return;
			if (this.stopArmed || this.releaseArmed) {
				this.stopArmed = false;
				this.releaseArmed = false;
				this.tui.requestRender();
				return;
			}
			this.close();
			return;
		}
		if (this.releaseArmed && !this.keys.release(data)) {
			const agent = this.snapshot();
			if (!agent) return;
			const warning = subagentReleaseLines(agent, this.lastInnerWidth);
			const viewport = this.viewportHeight(warning.length);
			const maxScroll = Math.max(0, warning.length - viewport);
			if (this.keys.scrollUp(data)) this.releaseScroll = Math.max(0, this.releaseScroll - 1);
			else if (this.keys.scrollDown(data)) this.releaseScroll = Math.min(maxScroll, this.releaseScroll + 1);
			else if (this.keys.pageUp(data)) this.releaseScroll = Math.max(0, this.releaseScroll - viewport);
			else if (this.keys.pageDown(data)) this.releaseScroll = Math.min(maxScroll, this.releaseScroll + viewport);
			else if (this.keys.home(data)) this.releaseScroll = 0;
			else if (this.keys.end(data)) this.releaseScroll = maxScroll;
			this.tui.requestRender();
			return;
		}
		if (this.keys.toggleThinking(data)) {
			this.hideThinking = !this.hideThinking;
			this.markContentDirty();
			this.tui.requestRender();
			return;
		}
		if (this.keys.toggleTools(data)) {
			this.toolsExpanded = !this.toolsExpanded;
			this.markContentDirty();
			this.tui.requestRender();
			return;
		}
		if (this.keys.message(data)) {
			this.stopArmed = false;
			this.releaseArmed = false;
			this.openComposer();
			return;
		}
		if (this.keys.stop(data)) {
			if (isKeyRepeat(data)) return;
			if (!this.canStop()) return;
			this.releaseArmed = false;
			if (this.stopArmed) {
				this.stopArmed = false;
				void this.stop();
			} else {
				this.stopArmed = true;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keys.release(data)) {
			if (isKeyRepeat(data)) return;
			if (!this.canRelease()) return;
			this.stopArmed = false;
			if (this.releaseArmed) {
				const agent = this.snapshot();
				if (!agent) return;
				const warning = subagentReleaseLines(agent, this.lastInnerWidth);
				const viewport = this.viewportHeight(warning.length);
				if (viewport === 0 || this.releaseScroll + viewport < warning.length) return;
				this.releaseArmed = false;
				void this.release();
			} else {
				this.releaseArmed = true;
				this.releaseScroll = 0;
				this.tui.requestRender();
			}
			return;
		}
		if (this.stopArmed || this.releaseArmed) {
			this.stopArmed = false;
			this.releaseArmed = false;
			this.tui.requestRender();
		}
		const snapshot = this.snapshot();
		const contentLines = this.buildContentLines(this.lastInnerWidth, snapshot);
		const viewport = this.viewportHeight(contentLines.length);
		const maxScroll = Math.max(0, contentLines.length - viewport);
		if (this.keys.scrollUp(data)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = false;
		} else if (this.keys.scrollDown(data)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (this.keys.pageUp(data)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewport);
			this.autoScroll = false;
		} else if (this.keys.pageDown(data)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewport);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (this.keys.home(data)) {
			this.scrollOffset = 0;
			this.autoScroll = false;
		} else if (this.keys.end(data)) {
			this.scrollOffset = maxScroll;
			this.autoScroll = true;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(1, Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PERCENT) / 100));
		const close = subagentBackHint(false, Math.max(1, width - 4));
		if (width < 6 || height < (this.composer ? 5 : 4)) {
			const hint = this.composer ? `${keyText("tui.select.cancel").split("/")[0]} cancel` : close;
			return [truncateToWidth(hint, Math.max(1, width), "")];
		}
		const innerWidth = width - 4;
		this.lastInnerWidth = innerWidth;
		const snapshot = this.snapshot();
		const row = (content: string) =>
			`${this.theme.fg("border", "│")} ${truncateToWidth(content, innerWidth, "", true)} ${this.theme.fg("border", "│")}`;
		const lines = [this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`)];
		lines.push(row(snapshot ? this.header(snapshot, innerWidth) : this.theme.fg("error", "Subagent not found")));
		if (height >= 12 && !this.releaseArmed)
			lines.push(row(this.theme.fg("dim", snapshot ? `${snapshot.model} · ${snapshot.workspace}` : "")));
		const contentLines =
			this.releaseArmed && snapshot
				? subagentReleaseLines(snapshot, innerWidth)
				: this.buildContentLines(innerWidth, snapshot);
		const viewport = this.viewportHeight(contentLines.length);
		const maxScroll = Math.max(0, contentLines.length - viewport);
		if (this.autoScroll && !this.releaseArmed) this.scrollOffset = maxScroll;
		const start = Math.min(this.releaseArmed ? this.releaseScroll : this.scrollOffset, maxScroll);
		lines.push(...contentLines.slice(start, start + viewport).map(row));
		if (this.composer) {
			this.composer.focused = this.focused;
			lines.push(row(this.composer.render(innerWidth)[0] ?? ""));
			lines.push(
				row(
					this.theme.fg(
						"dim",
						fitSubagentHints(
							[
								`${keyText("tui.select.cancel").split("/")[0]} cancel`,
								this.canCompose(snapshot)
									? `${keyText("tui.select.confirm")} send`
									: "Agent no longer running; draft kept",
							],
							innerWidth,
						),
					),
				),
			);
		} else {
			for (const hint of this.footer(contentLines.length, viewport, start, innerWidth, snapshot))
				lines.push(row(hint));
		}
		lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	invalidate(): void {
		this.markContentDirty();
		this.composer?.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.closed = true;
		Object.assign(this.state, {
			scrollOffset: this.scrollOffset,
			autoScroll: this.autoScroll,
			hideThinking: this.hideThinking,
			toolsExpanded: this.toolsExpanded,
			draft: this.composer?.getValue() ?? this.draft,
		});
		this.pendingTools = [];
		this.unsubscribe();
		if (this.clockTimer) {
			clearInterval(this.clockTimer);
			this.clockTimer = undefined;
		}
		if (this.updateTimer) {
			clearTimeout(this.updateTimer);
			this.updateTimer = undefined;
		}
		if (this.composer) this.composer.focused = false;
	}

	private snapshot(): SubagentUiSnapshot | undefined {
		return this.runtime.listSubagentsForUi().find((agent) => agent.id === this.agentId);
	}

	private header(agent: SubagentUiSnapshot, width: number): string {
		const identity = subagentIdentityLine(agent, this.theme, width);
		return `${identity} · ${this.releaseArmed ? "release" : formatFleetElapsed(agent)}`;
	}

	private buildContentLines(width: number, agent: SubagentUiSnapshot | undefined): readonly string[] {
		if (!agent) return [this.theme.fg("error", "Subagent not found")];
		const cached = this.contentCache;
		if (
			cached &&
			cached.width === width &&
			cached.revision === this.contentRevision &&
			cached.hideThinking === this.hideThinking &&
			cached.toolsExpanded === this.toolsExpanded
		) {
			// Animation changes only unfinished tool rows. Keep stable Markdown and output cached.
			let shift = 0;
			for (const pending of this.pendingTools) {
				pending.start += shift;
				const rendered = trimVisualBlankEdges(pending.component.render(width));
				if (rendered.length === pending.count) {
					for (let index = 0; index < rendered.length; index++) {
						const line = rendered[index]!;
						if (cached.lines[pending.start + index] !== line) cached.lines[pending.start + index] = line;
					}
				} else {
					const tail = cached.lines.slice(pending.start + pending.count);
					cached.lines.length = pending.start;
					for (const line of rendered) cached.lines.push(line);
					for (const line of tail) cached.lines.push(line);
					shift += rendered.length - pending.count;
					pending.count = rendered.length;
				}
			}
			return cached.lines;
		}
		this.pendingTools = [];
		const messages = [...agent.messages];
		if (agent.streamingMessage && !messages.includes(agent.streamingMessage)) messages.push(agent.streamingMessage);
		const lines = this.renderTranscript(messages, width, agent);
		if (lines.length === 0 && agent.result) {
			for (const line of wrapTextWithAnsi(agent.result, width)) lines.push(line);
		} else if (lines.length === 0) {
			lines.push(this.theme.fg("dim", "(waiting for first message...)"));
		}
		if (agent.error) {
			if (lines.length > 0) lines.push("");
			for (const line of wrapTextWithAnsi(this.theme.fg("error", `Error: ${agent.error}`), width)) lines.push(line);
		}
		if (isActiveSubagent(agent)) {
			while (lines.length > 0 && isVisuallyBlank(lines.at(-1) ?? "")) lines.pop();
			if (lines.length > 0) lines.push("");
			lines.push(`${this.theme.fg("accent", "▍ ")}${this.theme.fg("dim", subagentStatusText(agent))}`);
		}
		this.contentCache = {
			width,
			revision: this.contentRevision,
			hideThinking: this.hideThinking,
			toolsExpanded: this.toolsExpanded,
			lines,
		};
		return lines;
	}

	private renderTranscript(messages: readonly unknown[], width: number, agent: SubagentUiSnapshot): string[] {
		const toolResults = new Map<string, ToolResultMessage>();
		for (const message of messages) {
			if (typeof message === "object" && message !== null && "role" in message && message.role === "toolResult") {
				const result = message as ToolResultMessage;
				toolResults.set(result.toolCallId, result);
			}
		}
		const lines: string[] = [];
		const append = (rendered: readonly string[]) => {
			const compact = trimVisualBlankEdges(rendered);
			if (compact.length === 0) return;
			if (lines.length > 0) lines.push("");
			for (const line of compact) lines.push(line);
		};
		for (const message of messages) {
			if (typeof message !== "object" || message === null || !("role" in message)) continue;
			if (message.role === "user") {
				const user = message as UserMessage;
				const text =
					typeof user.content === "string"
						? user.content
						: user.content
								.filter((content) => content.type === "text")
								.map((content) => content.text)
								.join("\n");
				append(new UserMessageComponent(text, getMarkdownTheme(), 0).render(width));
				continue;
			}
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			append(
				new AssistantMessageComponent(assistant, this.hideThinking, getMarkdownTheme(), "Thinking...", 0).render(
					width,
				),
			);
			for (const content of assistant.content) {
				if (content.type !== "toolCall") continue;
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					{ interruptHint: false, requestAnimationFrames: false },
					undefined,
					this.tui,
					agent.workspace,
				);
				tool.setArgsComplete();
				tool.markExecutionStarted();
				tool.setExpanded(this.toolsExpanded);
				const result = toolResults.get(content.id);
				if (result) {
					tool.updateResult({
						content: result.content,
						details: result.details,
						isError: result.isError,
					});
				} else if (!isActiveSubagent(agent)) {
					tool.updateResult({
						content: [{ type: "text", text: agent.error ?? "Tool execution ended without a result" }],
						isError: true,
						details: { status: agent.lastOutcome === "cancelled" ? "aborted" : "error" },
					});
				}
				const rendered = trimVisualBlankEdges(tool.render(width));
				if (!result && isActiveSubagent(agent) && rendered.length > 0) {
					this.pendingTools.push({
						component: tool,
						start: lines.length + (lines.length > 0 ? 1 : 0),
						count: rendered.length,
					});
				}
				append(rendered);
			}
		}
		return lines;
	}

	private viewportHeight(contentLineCount: number): number {
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PERCENT) / 100);
		const metadataRows = maxRows >= 12 && !this.releaseArmed ? 1 : 0;
		return Math.max(
			0,
			Math.min(maxRows - 3 - metadataRows - this.footerRows() - (this.composer ? 1 : 0), contentLineCount),
		);
	}

	private footerRows(): number {
		if (this.composer || this.stopArmed) return 1;
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PERCENT) / 100);
		if (this.releaseArmed) return subagentReleaseFooterRows(this.lastInnerWidth, maxRows);
		return maxRows >= 12 ? (this.lastInnerWidth >= 50 ? 3 : 2) : 1;
	}

	private footer(
		total: number,
		viewport: number,
		start: number,
		width: number,
		agent: SubagentUiSnapshot | undefined,
	): string[] {
		const close = subagentBackHint(this.stopArmed || this.releaseArmed, width);
		if (this.releaseArmed)
			return wrapSubagentHints(
				[
					close,
					viewport === 0
						? "resize to review"
						: start + viewport >= total
							? `${keyText("app.agents.release")} confirm`
							: `${keyText("tui.select.down")} more`,
				],
				width,
				this.footerRows(),
			).map((hint) => this.theme.fg("warning", hint));
		if (this.stopArmed)
			return [
				this.theme.fg("warning", fitSubagentHints([close, `${keyText("app.agents.stop")} again to STOP`], width)),
			];
		const percent = total <= viewport ? "100%" : `${Math.round(((start + viewport) / total) * 100)}%`;
		const actions = [close, `${percent} ${this.autoScroll ? "live" : "paused"}`];
		if (this.canCompose(agent)) actions.push(`${keyText("app.agents.message")} message`);
		if (this.canStop(agent)) actions.push(`${keyText("app.agents.stop")} stop`);
		if (this.canRelease(agent)) actions.push(`${keyText("app.agents.release")} release`);
		if (this.sending) actions.push("sending…");
		if (this.stopping) actions.push("stopping…");
		if (this.releasing) actions.push("releasing…");
		actions.push(
			`${keyText("tui.select.up")}/${keyText("tui.select.down")}/${keyText("app.agents.previous")}/${keyText("app.agents.next")} scroll`,
			`${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} page`,
			`${keyText("app.agents.toggleThinking")} thinking:${this.hideThinking ? "compact" : "full"}`,
			`${keyText("app.tools.expand")} tools:${this.toolsExpanded ? "full" : "compact"}`,
		);
		const hints = wrapSubagentHints(actions, width, this.footerRows());
		while (hints.length < this.footerRows()) hints.push("");
		return hints.map((hint) => this.theme.fg("dim", hint));
	}

	private canCompose(agent = this.snapshot()): boolean {
		const status = agent?.status;
		return !this.sending && status === "running" && agent?.live === true;
	}

	private canStop(agent = this.snapshot()): boolean {
		const status = agent?.status;
		return !this.stopping && (status === "queued" || status === "running");
	}

	private canRelease(agent = this.snapshot()): boolean {
		return agent !== undefined && !this.releasing && !agent.live && !isActiveSubagent(agent);
	}

	private openComposer(value = this.draft): void {
		if ((!this.canCompose() && !value) || this.composer) return;
		const composer = new Input();
		composer.setValue(value);
		composer.focused = this.focused;
		composer.onSubmit = (message) => {
			if (message.trim().length === 0) this.closeComposer();
			else void this.submit(message);
		};
		composer.onEscape = () => this.closeComposer();
		this.composer = composer;
		this.tui.requestRender();
	}

	private closeComposer(): void {
		if (this.composer) {
			this.draft = this.composer.getValue();
			this.composer.focused = false;
		}
		this.composer = undefined;
		this.tui.requestRender();
	}

	private async submit(message: string): Promise<void> {
		if (!this.canCompose()) return;
		this.sending = true;
		this.closeComposer();
		try {
			await this.runtime.steerSubagentFromUi(this.agentId, message);
			this.draft = "";
			this.state.draft = "";
		} catch (error) {
			this.context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			this.sending = false;
			this.draft = message;
			this.state.draft = message;
			if (!this.closed) this.openComposer(message);
		} finally {
			this.sending = false;
			if (!this.closed) this.tui.requestRender();
		}
	}

	private async stop(): Promise<void> {
		if (!this.canStop()) return;
		this.stopping = true;
		this.tui.requestRender();
		try {
			await this.runtime.stopSubagentFromUi(this.agentId);
		} catch (error) {
			this.context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.stopping = false;
			if (!this.closed) this.tui.requestRender();
		}
	}

	private async release(): Promise<void> {
		if (!this.canRelease()) return;
		this.releasing = true;
		this.tui.requestRender();
		try {
			await this.runtime.releaseSubagentFromUi(this.agentId);
			this.close();
		} catch (error) {
			this.context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.releasing = false;
			if (!this.closed) this.tui.requestRender();
		}
	}

	private markContentDirty(): void {
		this.contentRevision += 1;
		this.contentCache = undefined;
	}

	private scheduleDataRender(): void {
		this.markContentDirty();
		this.syncClock();
		if (this.updateTimer || this.closed) return;
		this.updateTimer = setTimeout(() => {
			this.updateTimer = undefined;
			if (!this.closed) this.tui.requestRender();
		}, UPDATE_COALESCE_MS);
		this.updateTimer.unref?.();
	}

	private syncClock(): void {
		const snapshot = this.snapshot();
		if (this.closed || !snapshot || !isActiveSubagent(snapshot)) {
			if (this.clockTimer) {
				clearInterval(this.clockTimer);
				this.clockTimer = undefined;
			}
			return;
		}
		if (this.clockTimer) return;
		this.clockTimer = setInterval(() => {
			if (!this.closed) this.tui.requestRender();
		}, CLOCK_TICK_MS);
		this.clockTimer.unref?.();
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.done();
	}
}
