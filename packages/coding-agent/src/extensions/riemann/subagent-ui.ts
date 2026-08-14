import {
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../../riemann/agents/supervisor.ts";
import type { RiemannRuntime } from "../../riemann/runtime.ts";
import {
	compactLine,
	formatFleetElapsed,
	formatFleetTokens,
	isActiveSubagent,
	latestAssistantText,
	renderSubagentFleet,
	rightAlign,
	subagentStatusIcon,
	subagentStatusText,
} from "./subagent-display.ts";
import { runSubagentView } from "./subagent-view.ts";

const FLEET_WIDGET_KEY = "riemann-subagents:fleet";
const FLEET_STATUS_KEY = "riemann-subagents";
const UPDATE_COALESCE_MS = 32;
const MIN_TIMER_DELAY_MS = 1;
const FINISHED_LINGER_MS = 4_000;

export interface SubagentUiController {
	showHub(context: ExtensionCommandContext): Promise<void>;
	dispose(): void;
}

export class RiemannSubagentUiController implements SubagentUiController {
	private readonly runtime: RiemannRuntime;
	private readonly context: ExtensionContext;
	private readonly unsubscribeRuntime: () => void;
	private agents: readonly SubagentUiSnapshot[] = [];
	private active = false;
	private selectedIndex = 0;
	private viewerOpen = false;
	private viewingAgentId: string | undefined;
	private hubOpen = false;
	private disposed = false;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private tickTimer: NodeJS.Timeout | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;
	private lastStatus: string | undefined;

	constructor(runtime: RiemannRuntime, context: ExtensionContext) {
		this.runtime = runtime;
		this.context = context;
		this.unsubscribeRuntime = runtime.subscribeSubagentUi(() => this.scheduleRefresh());
		this.refresh();
	}

	async showHub(context: ExtensionCommandContext): Promise<void> {
		if (context.mode !== "tui") {
			context.ui.notify("The Agents Hub is available in interactive mode", "warning");
			return;
		}
		this.hubOpen = true;
		this.active = false;
		this.selectedIndex = 0;
		this.tui?.requestRender();
		try {
			let selectedAgentId: string | undefined;
			do {
				selectedAgentId = await showSubagentsHub(context, this.runtime);
				if (selectedAgentId) await runSubagentView(context, this.runtime, selectedAgentId);
			} while (selectedAgentId);
		} finally {
			this.hubOpen = false;
			this.refresh();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeRuntime();
		if (this.tickTimer) clearTimeout(this.tickTimer);
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.tickTimer = undefined;
		this.refreshTimer = undefined;
		this.inputUnsubscribe?.();
		this.inputUnsubscribe = undefined;
		if (this.widgetRegistered) this.context.ui.setWidget(FLEET_WIDGET_KEY, undefined);
		if (this.lastStatus !== undefined) this.context.ui.setStatus(FLEET_STATUS_KEY, undefined);
		this.lastStatus = undefined;
		this.tui = undefined;
	}

	private refresh(): void {
		if (this.disposed || this.context.mode !== "tui") return;
		const now = Date.now();
		this.agents = this.runtime.listSubagentsForUi().filter((agent) => this.isFleetVisible(agent, now));
		const running = this.agents.filter((agent) => agent.status === "running" || agent.status === "idle").length;
		const queued = this.agents.filter((agent) => agent.status === "queued").length;
		const status = activeStatusSummary(running, queued);
		if (status !== this.lastStatus) {
			this.context.ui.setStatus(FLEET_STATUS_KEY, status);
			this.lastStatus = status;
		}
		this.selectedIndex = Math.max(0, Math.min(this.agents.length, this.selectedIndex));
		if (this.agents.length === 0) {
			this.active = false;
			this.selectedIndex = 0;
			this.unregisterWidget();
			return;
		}
		this.registerWidget();
		this.tui?.requestRender();
		this.scheduleTick(now);
	}

	private registerWidget(): void {
		if (this.widgetRegistered) return;
		this.context.ui.setWidget(
			FLEET_WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) =>
						renderSubagentFleet(this.agents, theme, Date.now(), width, this.selectedIndex, this.active),
					invalidate: () => tui.requestRender(),
					dispose: () => {
						if (this.tui !== tui) return;
						this.tui = undefined;
						this.widgetRegistered = false;
						this.inputUnsubscribe?.();
						this.inputUnsubscribe = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
		this.widgetRegistered = true;
		this.attachInput();
	}

	private unregisterWidget(): void {
		if (this.tickTimer) clearTimeout(this.tickTimer);
		this.tickTimer = undefined;
		this.inputUnsubscribe?.();
		this.inputUnsubscribe = undefined;
		if (this.widgetRegistered) this.context.ui.setWidget(FLEET_WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private attachInput(): void {
		if (this.inputUnsubscribe) return;
		this.inputUnsubscribe = this.context.ui.onTerminalInput((data) => this.handleInput(data));
	}

	private handleInput(data: string): { consume?: boolean } | undefined {
		if (this.disposed || this.viewerOpen || this.hubOpen || isKeyRelease(data) || this.agents.length === 0) {
			return undefined;
		}
		if (!this.active) {
			if (this.context.ui.getEditorText().length > 0) return undefined;
			if (matchesKey(data, Key.down) || matchesKey(data, Key.left)) {
				this.active = true;
				this.selectedIndex = 0;
				this.tui?.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, Key.up)) {
				this.active = true;
				this.selectedIndex = this.agents.length;
				this.tui?.requestRender();
				return { consume: true };
			}
			return undefined;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.agents.length, this.selectedIndex + 1);
			this.tui?.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, Key.up)) {
			if (this.selectedIndex === 0) this.deactivate();
			else {
				this.selectedIndex -= 1;
				this.tui?.requestRender();
			}
			return { consume: true };
		}
		if (matchesKey(data, Key.escape)) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			this.openSelected();
			return { consume: true };
		}
		this.deactivate();
		return undefined;
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.tui?.requestRender();
	}

	private openSelected(): void {
		if (this.selectedIndex === 0) {
			this.deactivate();
			return;
		}
		const agent = this.agents[this.selectedIndex - 1];
		if (!agent) return;
		this.viewerOpen = true;
		this.viewingAgentId = agent.id;
		void runSubagentView(this.context, this.runtime, agent.id).then(
			() => this.clearViewer(agent.id),
			(error: unknown) => {
				this.context.ui.notify(error instanceof Error ? error.message : String(error), "error");
				this.clearViewer(agent.id);
			},
		);
	}

	private clearViewer(agentId: string): void {
		this.viewingAgentId = undefined;
		this.viewerOpen = false;
		const index = this.agents.findIndex((agent) => agent.id === agentId);
		this.selectedIndex = index < 0 ? 0 : index + 1;
		this.refresh();
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer || this.disposed) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.refresh();
		}, UPDATE_COALESCE_MS);
		this.refreshTimer.unref?.();
	}
	private isFleetVisible(agent: SubagentUiSnapshot, now: number): boolean {
		if (isActiveSubagent(agent) || agent.id === this.viewingAgentId) return true;
		const settledAt = Date.parse(agent.updatedAt);
		return Number.isFinite(settledAt) && now - settledAt < FINISHED_LINGER_MS;
	}

	private scheduleTick(now: number): void {
		if (this.tickTimer) clearTimeout(this.tickTimer);
		let nextDelay = Number.POSITIVE_INFINITY;
		for (const agent of this.agents) {
			if (isActiveSubagent(agent)) {
				const startedAt = Date.parse(agent.startedAt ?? agent.createdAt);
				if (!Number.isFinite(startedAt)) continue;
				const durationMs = Math.max(0, now - startedAt);
				const roundedSeconds = Math.round(durationMs / 1_000);
				const untilNextSecond = (roundedSeconds + 0.5) * 1_000 - durationMs;
				nextDelay = Math.min(nextDelay, Math.max(MIN_TIMER_DELAY_MS, Math.ceil(untilNextSecond)));
			} else if (agent.id !== this.viewingAgentId) {
				const settledAt = Date.parse(agent.updatedAt);
				const untilExpiry = settledAt + FINISHED_LINGER_MS - now;
				if (Number.isFinite(untilExpiry)) {
					nextDelay = Math.min(nextDelay, Math.max(MIN_TIMER_DELAY_MS, Math.ceil(untilExpiry)));
				}
			}
		}
		if (!Number.isFinite(nextDelay)) {
			this.tickTimer = undefined;
			return;
		}
		this.tickTimer = setTimeout(() => {
			this.tickTimer = undefined;
			this.refresh();
		}, nextDelay);
		this.tickTimer.unref?.();
	}
}

function activeStatusSummary(running: number, queued: number): string | undefined {
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (queued > 0) parts.push(`${queued} queued`);
	const total = running + queued;
	return total === 0 ? undefined : `${parts.join(", ")} agent${total === 1 ? "" : "s"}`;
}

export function installSubagentUi(runtime: RiemannRuntime, context: ExtensionContext): SubagentUiController {
	return new RiemannSubagentUiController(runtime, context);
}

export async function showSubagentsHub(
	context: ExtensionCommandContext,
	runtime: RiemannRuntime,
): Promise<string | undefined> {
	return context.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => {
			let agents = runtime.listSubagentsForUi();
			let selectedIndex = Math.max(0, agents.length - 1);
			let stopArmedId: string | undefined;
			let stoppingId: string | undefined;
			let closed = false;
			let renderTimer: NodeJS.Timeout | undefined;
			const refresh = () => {
				const selectedId = agents[selectedIndex]?.id;
				agents = runtime.listSubagentsForUi();
				const preservedIndex = selectedId ? agents.findIndex((agent) => agent.id === selectedId) : -1;
				selectedIndex =
					preservedIndex >= 0 ? preservedIndex : Math.min(selectedIndex, Math.max(0, agents.length - 1));
				if (!closed) tui.requestRender();
			};
			const timer = setInterval(() => {
				if (!closed) tui.requestRender();
			}, 200);
			timer.unref?.();
			const requestRefresh = () => {
				if (renderTimer || closed) return;
				renderTimer = setTimeout(() => {
					renderTimer = undefined;
					refresh();
				}, UPDATE_COALESCE_MS);
				renderTimer.unref?.();
			};
			const unsubscribe = runtime.subscribeSubagentUi(requestRefresh);

			return {
				dispose: () => {
					closed = true;
					unsubscribe();
					clearInterval(timer);
					if (renderTimer) clearTimeout(renderTimer);
				},
				invalidate: refresh,
				handleInput: (data: string) => {
					if (isKeyRelease(data)) return;
					if (keybindings.matches(data, "tui.select.cancel")) {
						if (isKeyRepeat(data)) return;
						closed = true;
						done(undefined);
						return;
					}
					if (matchesKey(data, "q")) {
						closed = true;
						done(undefined);
						return;
					}
					if (keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
						selectedIndex = Math.max(0, selectedIndex - 1);
						stopArmedId = undefined;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
						selectedIndex = Math.min(Math.max(0, agents.length - 1), selectedIndex + 1);
						stopArmedId = undefined;
						tui.requestRender();
						return;
					}
					const agent = agents[selectedIndex];
					if (keybindings.matches(data, "tui.select.confirm") && agent) {
						closed = true;
						done(agent.id);
						return;
					}
					if (matchesKey(data, "x") && agent && isActiveSubagent(agent) && stoppingId === undefined) {
						if (stopArmedId !== agent.id) {
							stopArmedId = agent.id;
							tui.requestRender();
							return;
						}
						stopArmedId = undefined;
						stoppingId = agent.id;
						void runtime
							.stopSubagentFromUi(agent.id)
							.catch((error: unknown) =>
								context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
							)
							.finally(() => {
								stoppingId = undefined;
								refresh();
							});
					}
				},
				render: (width: number) => renderHub(agents, selectedIndex, stopArmedId, stoppingId, width, tui, theme),
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: "70%" },
		},
	);
}

function renderHub(
	agents: readonly SubagentUiSnapshot[],
	selectedIndex: number,
	stopArmedId: string | undefined,
	stoppingId: string | undefined,
	width: number,
	tui: TUI,
	theme: Theme,
): string[] {
	const safeWidth = Math.max(20, width);
	const innerWidth = safeWidth - 4;
	const pad = (value: string) => `${value}${" ".repeat(Math.max(0, innerWidth - visibleWidth(value)))}`;
	const row = (content: string) =>
		`${theme.fg("border", "│")} ${truncateToWidth(pad(content), innerWidth, "...", true)} ${theme.fg("border", "│")}`;
	const top = theme.fg("border", `╭${"─".repeat(safeWidth - 2)}╮`);
	const bottom = theme.fg("border", `╰${"─".repeat(safeWidth - 2)}╯`);
	const middle = row(theme.fg("dim", "─".repeat(innerWidth)));
	const activeCount = agents.filter(isActiveSubagent).length;
	const lines = [
		top,
		row(
			`${theme.fg("accent", theme.bold("Agents Hub"))} ${theme.fg("dim", `· ${activeCount} active · ${agents.length} total`)}`,
		),
		middle,
	];
	if (agents.length === 0) {
		lines.push(row(""), row(theme.fg("muted", "No Subagents in this run.")), row(""), middle);
		lines.push(row(theme.fg("dim", "Esc close")), bottom);
		return lines;
	}
	const maxRows = Math.max(1, Math.min(8, Math.floor(tui.terminal.rows * 0.7 - 12)));
	const start = selectedIndex < maxRows ? 0 : selectedIndex - maxRows + 1;
	if (start > 0) lines.push(row(rightAlign("", theme.fg("dim", `↑ ${start} more`), innerWidth)));
	for (let index = start; index < Math.min(agents.length, start + maxRows); index += 1) {
		const agent = agents[index];
		if (!agent) continue;
		const selected = index === selectedIndex;
		const left = `${selected ? ">" : " "} ${subagentStatusIcon(agent, theme)} ${theme.bold(agent.name)}  ${theme.fg("muted", subagentStatusText(agent))}`;
		const right = theme.fg("dim", `${formatFleetElapsed(agent)} · ${formatFleetTokens(agent.tokens)}`);
		const content = rightAlign(left, right, innerWidth);
		lines.push(row(selected ? theme.bg("selectedBg", pad(content)) : content));
	}
	const hiddenBelow = agents.length - (start + maxRows);
	if (hiddenBelow > 0) lines.push(row(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), innerWidth)));
	const selected = agents[selectedIndex];
	if (selected) {
		lines.push(middle);
		const stats = [
			selected.modelRole,
			selected.turnCount > 0 ? `↻${selected.turnCount}` : "",
			selected.toolUses > 0 ? `${selected.toolUses} tool${selected.toolUses === 1 ? "" : "s"}` : "",
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(row(theme.fg("dim", stats)));
		for (const taskLine of wrapTextWithAnsi(selected.task, innerWidth).slice(0, 2)) lines.push(row(taskLine));
		const output = latestAssistantText(selected);
		if (output) lines.push(row(theme.fg("muted", compactLine(output, innerWidth))));
	}
	lines.push(middle);
	const canStopSelected = selected !== undefined && isActiveSubagent(selected);
	const footer =
		stopArmedId === selected?.id
			? theme.fg("error", "x again to STOP · Esc close")
			: stoppingId === selected?.id
				? theme.fg("warning", "stopping…")
				: canStopSelected
					? theme.fg("dim", "↑↓/jk select · Enter view · x stop · Esc close")
					: theme.fg("dim", "↑↓/jk select · Enter view · Esc close");
	lines.push(row(footer), bottom);
	return lines;
}
