import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionWidgetOptions,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { renderAgentMessage, renderSubagentFleet } from "../src/extensions/riemann/subagent-display.ts";
import { installSubagentUi, showSubagentsHub } from "../src/extensions/riemann/subagent-ui.ts";
import { SubagentConversationViewer } from "../src/extensions/riemann/subagent-view.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../src/riemann/agents/supervisor.ts";
import type { RiemannRuntime } from "../src/riemann/runtime.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function snapshot(overrides: Partial<SubagentUiSnapshot> = {}): SubagentUiSnapshot {
	return {
		id: "agent-1",
		name: "reviewer",
		status: "running",
		task: "Review parser changes",
		modelRole: "reviewer",
		workspace: "/workspace",
		createdAt: "2026-08-13T12:00:00.000Z",
		updatedAt: "2026-08-13T12:00:00.000Z",
		startedAt: "2026-08-13T12:00:00.000Z",
		turnCount: 2,
		toolUses: 3,
		tokens: 13_100,
		messages: [],
		live: true,
		...overrides,
	};
}

describe("Riemann Subagent UI", () => {
	beforeAll(() => initTheme("dark"));

	test("renders the reference Fleet below the editor with bounded agent rows", () => {
		const agents = Array.from({ length: 7 }, (_, index) =>
			snapshot({ id: `agent-${index}`, name: `worker-${index}`, task: `Task ${index}` }),
		);
		const lines = renderSubagentFleet(agents, theme, Date.parse("2026-08-13T12:00:12.000Z"), 80, 7, true);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("↑↓ select · enter view · esc back");
		expect(rendered).toContain("○ main");
		expect(rendered).toContain("● worker-6");
		expect(rendered).toContain("↑ 2 more");
		expect(rendered).toContain("12s · ↓ 13.1k tokens");
		expect(rendered).not.toContain("worker-0");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("renders child messages while keeping thinking collapsed by default", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private analysis" },
				{ type: "text", text: "Found two concrete defects." },
				{ type: "toolCall", name: "ipython" },
			],
		};
		const collapsed = stripAnsi(renderAgentMessage(message, 80, true, theme).join("\n"));
		expect(collapsed).toContain("[Assistant]");
		expect(collapsed).toContain("Found two concrete defects.");
		expect(collapsed).toContain("[Tool: ipython]");
		expect(collapsed).not.toContain("private analysis");

		const expanded = stripAnsi(renderAgentMessage(message, 80, false, theme).join("\n"));
		expect(expanded).toContain("[Thinking]");
		expect(expanded).toContain("private analysis");
	});

	test("lingers settled Agents briefly, then removes the bottom Fleet while preserving active footer state", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
		let listener: (() => void) | undefined;
		let agents = [snapshot()];
		const runtime = {
			listSubagentsForUi: () => agents,
			subscribeSubagentUi: (next: () => void) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as RiemannRuntime;
		const widgetUpdates: Array<{
			key: string;
			content: string[] | ((tui: TUI, theme: Theme) => Component) | undefined;
			options?: ExtensionWidgetOptions;
		}> = [];
		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const context = {
			mode: "tui",
			ui: {
				setWidget: (
					key: string,
					content: string[] | ((tui: TUI, theme: Theme) => Component) | undefined,
					options?: ExtensionWidgetOptions,
				) => widgetUpdates.push({ key, content, options }),
				setStatus: (key: string, text: string | undefined) => statusUpdates.push({ key, text }),
				onTerminalInput: () => () => undefined,
				getEditorText: () => "",
			},
		} as unknown as ExtensionContext;
		const controller = installSubagentUi(runtime, context);
		try {
			const installed = widgetUpdates[0];
			expect(installed).toMatchObject({ key: "riemann-subagents:fleet", options: { placement: "belowEditor" } });
			if (!installed || typeof installed.content !== "function") throw new Error("Fleet widget was not installed");
			const component = installed.content({ requestRender: () => undefined } as unknown as TUI, theme);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("reviewer  Review parser changes");
			expect(statusUpdates.at(-1)).toEqual({ key: "riemann-subagents", text: "1 running agent" });

			agents = [
				snapshot({
					status: "completed",
					result: "Completed review",
					live: false,
					updatedAt: new Date().toISOString(),
				}),
			];
			listener?.();
			await vi.advanceTimersByTimeAsync(32);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("reviewer  Review parser changes");
			expect(statusUpdates.at(-1)).toEqual({ key: "riemann-subagents", text: undefined });

			await vi.advanceTimersByTimeAsync(3_967);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("reviewer  Review parser changes");
			await vi.advanceTimersByTimeAsync(1);
			expect(stripAnsi(component.render(80).join("\n"))).not.toContain("reviewer");
			expect(widgetUpdates.at(-1)).toMatchObject({ key: "riemann-subagents:fleet", content: undefined });
		} finally {
			controller.dispose();
			vi.useRealTimers();
		}
		expect(listener).toBeUndefined();
	});

	test("shows settled agents in the Hub and closes without interrupting the active cell", async () => {
		const agents = [
			snapshot({
				status: "completed",
				result: "Repository structure report",
				live: false,
			}),
		];
		const runtime = {
			listSubagentsForUi: () => agents,
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		let rendered = "";
		let aborts = 0;
		let closes = 0;
		const context = {
			mode: "tui",
			signal: new AbortController().signal,
			abort: () => {
				aborts += 1;
			},
			ui: {
				custom: async (
					factory: (
						tui: TUI,
						currentTheme: Theme,
						keybindings: KeybindingsManager,
						done: (value: string | undefined) => void,
					) => Component,
				) =>
					new Promise<string | undefined>((resolve) => {
						const tui = {
							terminal: { rows: 30 },
							requestRender: () => undefined,
						} as unknown as TUI;
						const component = factory(tui, theme, new KeybindingsManager(), (value) => {
							closes += 1;
							resolve(value);
						});
						rendered = stripAnsi(component.render(80).join("\n"));
						component.handleInput?.("\x1b[27;1:2u");
						if (closes !== 0) throw new Error("Key repeat closed the Agents Hub");
						component.handleInput?.("\x1b");
						(component as Component & { dispose?: () => void }).dispose?.();
					}),
				notify: () => undefined,
			},
		} as unknown as ExtensionCommandContext;

		await showSubagentsHub(context, runtime);
		expect(rendered).toContain("0 active · 1 total");
		expect(rendered).toContain("reviewer");
		expect(rendered).not.toContain("x stop");
		expect(aborts).toBe(0);
		expect(closes).toBe(1);
	});

	test("closes the viewer without interrupting the active cell", () => {
		const runtime = {
			listSubagentsForUi: () => [snapshot()],
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		let aborts = 0;
		let closes = 0;
		const context = {
			mode: "tui",
			signal: new AbortController().signal,
			abort: () => {
				aborts += 1;
			},
			ui: { notify: () => undefined },
		} as unknown as ExtensionContext;
		const tui = {
			terminal: { rows: 30 },
			requestRender: () => undefined,
		} as unknown as TUI;
		const viewer = new SubagentConversationViewer({
			context,
			runtime,
			agentId: "agent-1",
			tui,
			theme,
			keybindings: new KeybindingsManager(),
			done: () => {
				closes += 1;
			},
		});

		viewer.handleInput("\x1b[27;1:2u");
		expect(aborts).toBe(0);
		expect(closes).toBe(0);
		viewer.handleInput("\x1b");
		expect(aborts).toBe(0);
		expect(closes).toBe(1);
		viewer.dispose();
	});
});
