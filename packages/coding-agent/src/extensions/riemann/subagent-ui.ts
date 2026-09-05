import {
	getKeybindings,
	isKeyRelease,
	isKeyRepeat,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../../riemann/agents/supervisor.ts";
import type { RiemannRuntime } from "../../riemann/runtime.ts";
import {
	compactLine,
	formatFleetElapsed,
	isActiveSubagent,
	latestAssistantText,
	renderSubagentFleet,
	rightAlign,
	subagentBackHint,
	subagentIdentityLine,
	subagentReleaseFooterRows,
	subagentReleaseLines,
	wrapSubagentHints,
} from "./subagent-display.ts";
import { runSubagentView, type SubagentViewState } from "./subagent-view.ts";

const FLEET_WIDGET_KEY = "riemann-subagents:fleet";
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
	private previews = new Map<string, string>();
	private active = false;
	private selectedIndex = 0;
	private viewerOpen = false;
	private viewingAgentId: string | undefined;
	private hubOpen = false;
	private readonly hubState: SubagentHubState = {};
	private readonly viewStates = new Map<string, SubagentViewState>();
	private disposed = false;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private tickTimer: NodeJS.Timeout | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;

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
				selectedAgentId = await showSubagentsHub(context, this.runtime, this.hubState);
				if (selectedAgentId) {
					const state = this.viewStates.get(selectedAgentId) ?? {};
					this.viewStates.set(selectedAgentId, state);
					await runSubagentView(context, this.runtime, selectedAgentId, state);
				}
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
		this.tui = undefined;
	}

	private refresh(updatePreviews = true): void {
		if (this.disposed || this.context.mode !== "tui") return;
		const selectedAgentId = this.agents[this.selectedIndex]?.id;
		const now = Date.now();
		this.agents = this.runtime.listSubagentsForUi().filter((agent) => this.isFleetVisible(agent, now));
		if (updatePreviews)
			this.previews = new Map(this.agents.map((agent) => [agent.id, compactLine(latestAssistantText(agent) ?? "")]));
		const preservedIndex = selectedAgentId ? this.agents.findIndex((agent) => agent.id === selectedAgentId) : -1;
		this.selectedIndex =
			preservedIndex >= 0 ? preservedIndex : Math.max(0, Math.min(this.agents.length - 1, this.selectedIndex));
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
						renderSubagentFleet(
							this.agents,
							theme,
							Date.now(),
							width,
							this.selectedIndex,
							this.active,
							this.previews,
						),
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
		// Built-in TUI implementations expose this query on TuiBase. Inspect the
		// editor contract rather than instanceof, so extension editors remain usable.
		const focused: unknown =
			this.tui && "getFocusedComponent" in this.tui && typeof this.tui.getFocusedComponent === "function"
				? this.tui.getFocusedComponent()
				: undefined;
		if (
			this.tui?.hasOverlay() ||
			typeof focused !== "object" ||
			focused === null ||
			!("getText" in focused) ||
			typeof focused.getText !== "function" ||
			!("setText" in focused) ||
			typeof focused.setText !== "function"
		) {
			if (this.active) this.deactivate();
			return undefined;
		}
		const keybindings = getKeybindings();
		if (!this.active) {
			if (this.context.ui.getEditorText().length > 0) return undefined;
			if (keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "tui.editor.cursorLeft")) {
				this.active = true;
				this.selectedIndex = 0;
				this.tui?.requestRender();
				return { consume: true };
			}

			return undefined;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.agents.length - 1, this.selectedIndex + 1);
			this.tui?.requestRender();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.select.up")) {
			if (this.selectedIndex === 0) this.deactivate();
			else {
				this.selectedIndex -= 1;
				this.tui?.requestRender();
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.deactivate();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
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
		const agent = this.agents[this.selectedIndex];
		if (!agent) return;
		this.viewerOpen = true;
		this.viewingAgentId = agent.id;
		const state = this.viewStates.get(agent.id) ?? {};
		this.viewStates.set(agent.id, state);
		void runSubagentView(this.context, this.runtime, agent.id, state).then(
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
		this.selectedIndex = index < 0 ? 0 : index;
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
			this.refresh(false);
		}, nextDelay);
		this.tickTimer.unref?.();
	}
}

export function installSubagentUi(runtime: RiemannRuntime, context: ExtensionContext): SubagentUiController {
	return new RiemannSubagentUiController(runtime, context);
}

export interface SubagentHubState {
	selectedAgentId?: string;
}

export async function showSubagentsHub(
	context: ExtensionCommandContext,
	runtime: RiemannRuntime,
	state: SubagentHubState = {},
): Promise<string | undefined> {
	return context.ui.custom<string | undefined>(
		(tui, theme, keybindings, done) => {
			let agents = runtime.listSubagentsForUi();
			const rememberedIndex = agents.findIndex((agent) => agent.id === state.selectedAgentId);
			let selectedIndex = rememberedIndex < 0 ? Math.max(0, agents.length - 1) : rememberedIndex;
			let releaseScroll = 0;
			let lastWidth = 80;
			let stopArmedId: string | undefined;
			let stoppingId: string | undefined;
			let releaseArmedId: string | undefined;
			let releasingId: string | undefined;
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
					state.selectedAgentId = agents[selectedIndex]?.id;
					closed = true;
					unsubscribe();
					clearInterval(timer);
					clearTimeout(renderTimer);
				},
				invalidate: refresh,
				handleInput: (data: string) => {
					if (isKeyRelease(data)) return;
					if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.agents.close")) {
						if (isKeyRepeat(data)) return;
						if (releaseArmedId || stopArmedId) {
							releaseArmedId = undefined;
							stopArmedId = undefined;
							tui.requestRender();
							return;
						}
						closed = true;
						done(undefined);
						return;
					}
					if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "app.agents.previous")) {
						if (releaseArmedId) {
							releaseScroll = Math.max(0, releaseScroll - 1);
							tui.requestRender();
							return;
						}
						selectedIndex = Math.max(0, selectedIndex - 1);
						stopArmedId = undefined;
						releaseArmedId = undefined;
						tui.requestRender();
						return;
					}
					if (keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "app.agents.next")) {
						if (releaseArmedId) {
							const agent = agents[selectedIndex];
							if (agent)
								releaseScroll = Math.min(
									Math.max(
										0,
										subagentReleaseLines(agent, lastWidth - 4).length -
											Math.max(
												0,
												Math.floor(tui.terminal.rows * 0.7) -
													3 -
													subagentReleaseFooterRows(lastWidth - 4, Math.floor(tui.terminal.rows * 0.7)),
											),
									),
									releaseScroll + 1,
								);
							tui.requestRender();
							return;
						}
						selectedIndex = Math.min(Math.max(0, agents.length - 1), selectedIndex + 1);
						stopArmedId = undefined;
						releaseArmedId = undefined;
						tui.requestRender();
						return;
					}
					const agent = agents[selectedIndex];
					if (keybindings.matches(data, "tui.select.confirm") && agent && !releaseArmedId && !stopArmedId) {
						closed = true;
						done(agent.id);
						return;
					}
					if (
						keybindings.matches(data, "app.agents.stop") &&
						agent &&
						isActiveSubagent(agent) &&
						stoppingId === undefined
					) {
						if (isKeyRepeat(data)) return;
						releaseArmedId = undefined;
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
						return;
					}
					if (
						keybindings.matches(data, "app.agents.release") &&
						agent &&
						!isActiveSubagent(agent) &&
						!agent.live &&
						releasingId === undefined
					) {
						if (isKeyRepeat(data)) return;
						stopArmedId = undefined;
						if (releaseArmedId !== agent.id) {
							releaseArmedId = agent.id;
							releaseScroll = 0;
							tui.requestRender();
							return;
						}
						const reviewRows = Math.max(
							0,
							Math.floor(tui.terminal.rows * 0.7) -
								3 -
								subagentReleaseFooterRows(lastWidth - 4, Math.floor(tui.terminal.rows * 0.7)),
						);
						if (
							reviewRows === 0 ||
							releaseScroll + reviewRows < subagentReleaseLines(agent, lastWidth - 4).length
						)
							return;
						releaseArmedId = undefined;
						releasingId = agent.id;
						void runtime
							.releaseSubagentFromUi(agent.id)
							.catch((error: unknown) =>
								context.ui.notify(error instanceof Error ? error.message : String(error), "error"),
							)
							.finally(() => {
								releasingId = undefined;
								refresh();
							});
					}
				},
				render: (width: number) => {
					lastWidth = width;
					return renderHub(
						agents,
						selectedIndex,
						stopArmedId,
						stoppingId,
						releaseArmedId,
						releasingId,
						releaseScroll,
						width,
						tui,
						theme,
					);
				},
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
	releaseArmedId: string | undefined,
	releasingId: string | undefined,
	releaseScroll: number,
	width: number,
	tui: TUI,
	theme: Theme,
): string[] {
	const height = Math.max(1, Math.floor(tui.terminal.rows * 0.7));
	const innerWidth = Math.max(1, width - 4);
	const close = subagentBackHint(false, innerWidth);
	if (width < 6 || height < 4) return [truncateToWidth(close, width, "")];
	const row = (content: string) =>
		`${theme.fg("border", "│")} ${truncateToWidth(content, innerWidth, "", true)} ${theme.fg("border", "│")}`;
	const selected = agents[selectedIndex];
	const armed = selected !== undefined && releaseArmedId === selected.id;
	const footerRows = armed ? subagentReleaseFooterRows(innerWidth, height) : height >= 12 ? 2 : 1;
	const bodyRows = Math.max(0, height - 3 - footerRows);
	const body: string[] = [];
	let title = `Agents Hub · ${agents.filter(isActiveSubagent).length} active · ${agents.length} total`;
	let hints = [
		close,
		`${keyText("tui.select.confirm")} view`,
		`${keyText("tui.select.up")}/${keyText("tui.select.down")}/${keyText("app.agents.previous")}/${keyText("app.agents.next")} select`,
	];
	if (armed) {
		title = `${selected.name} · release`;
		const warning = subagentReleaseLines(selected, innerWidth);
		const start = Math.min(releaseScroll, Math.max(0, warning.length - bodyRows));
		body.push(...warning.slice(start, start + bodyRows));
		hints = [
			subagentBackHint(true),
			bodyRows === 0
				? "resize to review"
				: start + bodyRows >= warning.length
					? `${keyText("app.agents.release")} confirm`
					: `${keyText("tui.select.down")} more`,
		];
	} else if (!selected) {
		body.push("No Subagents in this run.");
	} else {
		const detailRows = bodyRows >= 6 ? 3 : 0;
		const count = Math.min(8, Math.max(1, bodyRows - detailRows));
		const start = Math.max(0, selectedIndex - count + 1);
		for (let index = start; index < Math.min(agents.length, start + count); index++) {
			const agent = agents[index]!;
			const left = subagentIdentityLine(agent, theme, innerWidth, index === selectedIndex);
			const elapsed = theme.fg("dim", formatFleetElapsed(agent));
			const content =
				visibleWidth(left) + visibleWidth(elapsed) + 2 <= innerWidth ? rightAlign(left, elapsed, innerWidth) : left;
			body.push(index === selectedIndex ? theme.bg("selectedBg", content) : content);
		}
		if (agents.length > count) title = `Agents Hub · ${selectedIndex + 1}/${agents.length}`;
		if (detailRows) {
			body.push(theme.fg("dim", `${selected.model} · ${selected.workspace}`));
			body.push(...wrapTextWithAnsi(selected.task, innerWidth).slice(0, 1));
			const output = selected.error ?? latestAssistantText(selected);
			if (output) body.push(theme.fg(selected.error ? "error" : "muted", compactLine(output, innerWidth)));
		}
		if (stopArmedId === selected.id) hints = [subagentBackHint(true), `${keyText("app.agents.stop")} again to STOP`];
		else if (stoppingId === selected.id) hints = [close, "stopping…"];
		else if (releasingId === selected.id) hints = [close, "releasing…"];
		else if (isActiveSubagent(selected)) hints.splice(2, 0, `${keyText("app.agents.stop")} stop`);
		else if (!selected.live) hints.splice(2, 0, `${keyText("app.agents.release")} release`);
	}
	return [
		theme.fg("border", `╭${"─".repeat(width - 2)}╮`),
		row(theme.fg("accent", theme.bold(title))),
		...body.slice(0, bodyRows).map(row),
		...wrapSubagentHints(hints, innerWidth, footerRows).map((hint) => row(theme.fg("dim", hint))),
		theme.fg("border", `╰${"─".repeat(width - 2)}╯`),
	];
}
