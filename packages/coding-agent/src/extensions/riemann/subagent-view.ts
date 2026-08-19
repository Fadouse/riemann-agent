import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	Input,
	isKeyRepeat,
	type TUI,
	truncateToWidth,
	visibleWidth,
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
	formatFleetElapsed,
	formatFleetTokens,
	isActiveSubagent,
	subagentStatusIcon,
	subagentStatusText,
} from "./subagent-display.ts";

const VIEWPORT_HEIGHT_PERCENT = 70;
const MIN_VIEWPORT_ROWS = 3;
const CLOCK_TICK_MS = 200;
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
): Promise<void> {
	if (context.mode !== "tui") return;
	await context.ui.custom<void>(
		(tui, theme, keybindings, done) =>
			new SubagentConversationViewer({ context, runtime, agentId, tui, theme, keybindings, done }),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PERCENT}%` },
		},
	);
}

interface SubagentConversationViewerOptions {
	context: ExtensionContext;
	runtime: RiemannRuntime;
	agentId: string;
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: () => void;
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
		| { width: number; revision: number; hideThinking: boolean; toolsExpanded: boolean; lines: readonly string[] }
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
			this.close();
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
				this.releaseArmed = false;
				void this.release();
			} else {
				this.releaseArmed = true;
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
		if (width < 6) return [];
		const innerWidth = width - 4;
		this.lastInnerWidth = innerWidth;
		const snapshot = this.snapshot();
		if (this.composer && !this.canCompose(snapshot)) {
			this.composer.focused = false;
			this.composer = undefined;
		}
		const pad = (value: string) => `${value}${" ".repeat(Math.max(0, innerWidth - visibleWidth(value)))}`;
		const row = (content: string) =>
			`${this.theme.fg("border", "│")} ${truncateToWidth(pad(content), innerWidth, "...", true)} ${this.theme.fg("border", "│")}`;
		const top = this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`);
		const bottom = this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
		const middle = row(this.theme.fg("dim", "─".repeat(innerWidth)));
		const lines = [top];
		if (!snapshot) {
			lines.push(row(this.theme.fg("error", "Subagent not found")), middle);
		} else {
			lines.push(row(this.header(snapshot)));
			lines.push(row(this.theme.fg("dim", `  ↳ ${snapshot.model} · ${snapshot.workspace}`)));
			lines.push(middle);
		}
		const contentLines = this.buildContentLines(innerWidth, snapshot);
		const viewport = this.viewportHeight(contentLines.length);
		const maxScroll = Math.max(0, contentLines.length - viewport);
		if (this.autoScroll) this.scrollOffset = maxScroll;
		const start = Math.min(this.scrollOffset, maxScroll);
		const visible = contentLines.slice(start, start + viewport);
		for (let index = 0; index < viewport; index += 1) lines.push(row(visible[index] ?? ""));
		lines.push(middle);
		if (this.composer) {
			this.composer.focused = this.focused;
			lines.push(row(this.composer.render(innerWidth)[0] ?? ""));
			const left = this.theme.fg("accent", this.sending ? "… sending" : "✎ message");
			const right = this.theme.fg(
				"dim",
				`${keyText("tui.select.confirm")} send · ${keyText("tui.select.cancel")} cancel`,
			);
			const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right));
			lines.push(row(`${left}${" ".repeat(gap)}${right}`));
		} else {
			lines.push(row(this.footer(contentLines.length, viewport, start, innerWidth, snapshot)));
		}
		lines.push(bottom);
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

	private header(agent: SubagentUiSnapshot): string {
		const stats = [
			agent.turnCount > 0 ? `↻${agent.turnCount}` : "",
			agent.toolUses > 0 ? `${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}` : "",
			formatFleetElapsed(agent),
			agent.tokens > 0 ? formatFleetTokens(agent.tokens) : "",
		]
			.filter(Boolean)
			.join(" · ");
		return `${subagentStatusIcon(agent, this.theme)} ${this.theme.bold(agent.name)}  ${this.theme.fg("muted", agent.task)} ${this.theme.fg("dim", `· ${stats}`)}`;
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
			return cached.lines;
		}
		const messages = [...agent.messages];
		if (agent.streamingMessage && !messages.includes(agent.streamingMessage)) messages.push(agent.streamingMessage);
		const lines = this.renderTranscript(messages, width, agent.workspace);
		if (lines.length === 0 && agent.result) {
			lines.push(...agent.result.split("\n"));
		} else if (lines.length === 0 && agent.error) {
			lines.push(this.theme.fg("error", agent.error));
		} else if (lines.length === 0) {
			lines.push(this.theme.fg("dim", "(waiting for first message...)"));
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

	private renderTranscript(messages: readonly unknown[], width: number, cwd: string): string[] {
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
			lines.push(...compact);
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
					{},
					undefined,
					this.tui,
					cwd,
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
				}
				append(tool.render(width));
			}
		}
		return lines;
	}

	private viewportHeight(contentLineCount: number): number {
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PERCENT) / 100);
		const available = Math.max(MIN_VIEWPORT_ROWS, maxRows - (this.composer ? 8 : 7));
		return Math.max(MIN_VIEWPORT_ROWS, Math.min(available, contentLineCount));
	}

	private footer(
		total: number,
		viewport: number,
		start: number,
		width: number,
		agent: SubagentUiSnapshot | undefined,
	): string {
		const actions: string[] = [];
		if (this.canCompose(agent)) actions.push(`${keyText("app.agents.message")} message`);
		if (this.canStop(agent)) {
			actions.push(
				this.stopArmed
					? this.theme.fg("error", `${keyText("app.agents.stop")} again to STOP`)
					: `${keyText("app.agents.stop")} stop`,
			);
		}
		if (this.canRelease(agent)) {
			actions.push(
				this.releaseArmed
					? this.theme.fg("error", `${keyText("app.agents.release")} again to RELEASE SLOT`)
					: `${keyText("app.agents.release")} release`,
			);
		}
		actions.push(
			`${keyText("app.agents.toggleThinking")} thinking:${this.hideThinking ? "compact" : "full"}`,
			`${keyText("app.tools.expand")} tools:${this.toolsExpanded ? "full" : "compact"}`,
		);
		const percent = total <= viewport ? "100%" : `${Math.round(((start + viewport) / total) * 100)}%`;
		const left = this.theme.fg("dim", `${total} lines · ${percent} · ${actions.join(" · ")}`);
		const right = this.theme.fg(
			"dim",
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} scroll · ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} page · ${keyText("tui.select.cancel")} close`,
		);
		if (visibleWidth(left) + visibleWidth(right) + 1 > width) return truncateToWidth(left, width, "");
		return `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
	}

	private canCompose(agent = this.snapshot()): boolean {
		const status = agent?.status;
		return !this.sending && (status === "running" || status === "idle");
	}

	private canStop(agent = this.snapshot()): boolean {
		const status = agent?.status;
		return !this.stopping && (status === "queued" || status === "running" || status === "idle");
	}

	private canRelease(agent = this.snapshot()): boolean {
		return agent !== undefined && !this.releasing && !isActiveSubagent(agent);
	}

	private openComposer(value = ""): void {
		if (!this.canCompose() || this.composer) return;
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
		if (this.composer) this.composer.focused = false;
		this.composer = undefined;
		this.tui.requestRender();
	}

	private async submit(message: string): Promise<void> {
		if (!this.canCompose()) return;
		this.sending = true;
		this.closeComposer();
		try {
			await this.runtime.steerSubagentFromUi(this.agentId, message);
		} catch (error) {
			this.context.ui.notify(error instanceof Error ? error.message : String(error), "error");
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
