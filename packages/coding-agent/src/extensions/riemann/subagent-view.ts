import {
	type Component,
	type Focusable,
	Input,
	isKeyRepeat,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../../riemann/agents/supervisor.ts";
import type { RiemannRuntime } from "../../riemann/runtime.ts";
import {
	formatFleetElapsed,
	formatFleetTokens,
	isActiveSubagent,
	renderAgentMessage,
	subagentStatusIcon,
	subagentStatusText,
} from "./subagent-display.ts";

const VIEWPORT_HEIGHT_PERCENT = 70;
const MIN_VIEWPORT_ROWS = 3;
const CLOCK_TICK_MS = 200;
const UPDATE_COALESCE_MS = 32;

interface ViewerKeys {
	cancel(data: string): boolean;
	scrollUp(data: string): boolean;
	scrollDown(data: string): boolean;
	pageUp(data: string): boolean;
	pageDown(data: string): boolean;
}

function createViewerKeys(keybindings: KeybindingsManager): ViewerKeys {
	return {
		cancel: (data) => keybindings.matches(data, "tui.select.cancel"),
		scrollUp: (data) => keybindings.matches(data, "tui.select.up") || matchesKey(data, "k"),
		scrollDown: (data) => keybindings.matches(data, "tui.select.down") || matchesKey(data, "j"),
		pageUp: (data) => keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, "shift+up"),
		pageDown: (data) => keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "shift+down"),
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
	private sending = false;
	private stopping = false;
	private closed = false;
	private composer: Input | undefined;
	private clockTimer: NodeJS.Timeout | undefined;
	private updateTimer: NodeJS.Timeout | undefined;
	private contentRevision = 0;
	private contentCache:
		| { width: number; revision: number; hideThinking: boolean; lines: readonly string[] }
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
		this.unsubscribe = this.runtime.subscribeSubagentUi(() => this.scheduleDataRender());
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
		if (this.keys.cancel(data)) {
			if (isKeyRepeat(data)) return;
			this.close();
			return;
		}
		if (matchesKey(data, "q")) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			this.hideThinking = !this.hideThinking;
			this.markContentDirty();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.stopArmed = false;
			void this.stop();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, "m")) {
			this.stopArmed = false;
			this.openComposer();
			return;
		}
		if (matchesKey(data, "x")) {
			if (!this.canStop()) return;
			if (this.stopArmed) {
				this.stopArmed = false;
				void this.stop();
			} else {
				this.stopArmed = true;
				this.tui.requestRender();
			}
			return;
		}
		if (this.stopArmed) {
			this.stopArmed = false;
			this.tui.requestRender();
		}
		const snapshot = this.snapshot();
		const contentLines = this.buildContentLines(this.lastInnerWidth, snapshot);
		const viewport = this.viewportHeight();
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
		} else if (matchesKey(data, Key.home)) {
			this.scrollOffset = 0;
			this.autoScroll = false;
		} else if (matchesKey(data, Key.end)) {
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
		if (this.composer && !this.canCompose()) {
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
			lines.push(row(this.theme.fg("dim", `  ↳ ${snapshot.modelRole} · ${snapshot.workspace}`)));
			lines.push(middle);
		}
		const contentLines = this.buildContentLines(innerWidth, snapshot);
		const viewport = this.viewportHeight();
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
			const right = this.theme.fg("dim", "Enter send · Esc cancel");
			const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(right));
			lines.push(row(`${left}${" ".repeat(gap)}${right}`));
		} else {
			lines.push(row(this.footer(contentLines.length, viewport, start, innerWidth)));
		}
		lines.push(bottom);
		return lines;
	}

	invalidate(): void {
		this.markContentDirty();
		this.composer?.invalidate();
	}

	dispose(): void {
		this.closed = true;
		this.unsubscribe();
		if (this.clockTimer) clearInterval(this.clockTimer);
		if (this.updateTimer) clearTimeout(this.updateTimer);
		this.clockTimer = undefined;
		this.updateTimer = undefined;
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
			cached.hideThinking === this.hideThinking
		) {
			return cached.lines;
		}
		const messages = [...agent.messages];
		if (agent.streamingMessage && !messages.includes(agent.streamingMessage)) messages.push(agent.streamingMessage);
		const lines: string[] = [];
		for (const [index, message] of messages.entries()) {
			if (index > 0) lines.push(this.theme.fg("dim", "───"));
			lines.push(...renderAgentMessage(message, width, this.hideThinking, this.theme));
		}
		if (lines.length === 0 && agent.result) {
			lines.push(this.theme.bold("[Assistant]"), ...agent.result.split("\n"));
		} else if (lines.length === 0 && agent.error) {
			lines.push(this.theme.fg("error", `[Error] ${agent.error}`));
		} else if (lines.length === 0) {
			lines.push(this.theme.fg("dim", "(waiting for first message...)"));
		}
		if (isActiveSubagent(agent)) {
			lines.push("", `${this.theme.fg("accent", "▍ ")}${this.theme.fg("dim", subagentStatusText(agent))}`);
		}
		this.contentCache = { width, revision: this.contentRevision, hideThinking: this.hideThinking, lines };
		return lines;
	}

	private viewportHeight(): number {
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PERCENT) / 100);
		return Math.max(MIN_VIEWPORT_ROWS, maxRows - (this.composer ? 8 : 7));
	}

	private footer(total: number, viewport: number, start: number, width: number): string {
		const actions: string[] = [];
		if (this.canCompose()) actions.push(this.theme.fg("dim", "Enter steer"));
		if (this.canStop()) {
			actions.push(this.stopArmed ? this.theme.fg("error", "x again to STOP") : this.theme.fg("dim", "x stop"));
		}
		actions.push(this.theme.fg("dim", "^T thinking"));
		const percent = total <= viewport ? "100%" : `${Math.round(((start + viewport) / total) * 100)}%`;
		const left = [this.theme.fg("dim", `${total} lines · ${percent}`), ...actions].join(this.theme.fg("dim", " · "));
		const right = this.theme.fg("dim", "↑↓ scroll · PgUp/PgDn · Esc close");
		if (visibleWidth(left) + visibleWidth(right) + 1 > width) return truncateToWidth(right, width, "");
		return `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`;
	}

	private canCompose(): boolean {
		const status = this.snapshot()?.status;
		return !this.sending && (status === "running" || status === "idle");
	}

	private canStop(): boolean {
		const status = this.snapshot()?.status;
		return !this.stopping && (status === "queued" || status === "running" || status === "idle");
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
			if (this.clockTimer) clearInterval(this.clockTimer);
			this.clockTimer = undefined;
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
		this.closed = true;
		this.done();
	}
}
