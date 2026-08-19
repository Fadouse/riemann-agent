import { type Component, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionWidgetOptions,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { renderSubagentFleet } from "../src/extensions/riemann/subagent-display.ts";
import { installSubagentUi, showSubagentsHub } from "../src/extensions/riemann/subagent-ui.ts";
import { SubagentConversationViewer } from "../src/extensions/riemann/subagent-view.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../src/riemann/agents/supervisor.ts";
import type { RiemannRuntime } from "../src/riemann/runtime.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function longestBlankRun(lines: readonly string[]): number {
	let longest = 0;
	let current = 0;
	for (const line of lines) {
		if (line.trim().length === 0) {
			current += 1;
			longest = Math.max(longest, current);
		} else {
			current = 0;
		}
	}
	return longest;
}

function snapshot(overrides: Partial<SubagentUiSnapshot> = {}): SubagentUiSnapshot {
	return {
		id: "agent-1",
		name: "reviewer",
		turnId: "turn-1",
		status: "running",
		task: "Review parser changes",
		modelRole: "reviewer",
		model: "openai/gpt-test",
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
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("renders the reference Fleet below the editor with bounded agent rows", () => {
		const agents = Array.from({ length: 7 }, (_, index) =>
			snapshot({ id: `agent-${index}`, name: `worker-${index}`, task: `Task ${index}` }),
		);
		const inactiveLines = renderSubagentFleet(agents, theme, Date.parse("2026-08-13T12:00:12.000Z"), 80, 6, false);
		const inactive = stripAnsi(inactiveLines.join("\n"));
		expect(inactive).toContain("○ worker-6");
		expect(inactive).not.toContain("● worker-6");

		const lines = renderSubagentFleet(agents, theme, Date.parse("2026-08-13T12:00:12.000Z"), 80, 6, true);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("select");
		expect(rendered).toContain("● worker-6");
		expect(rendered).toContain("○ worker-2");
		expect(rendered).toContain("Task 6");
		expect(rendered).toContain("↑ 2 more");
		expect(rendered).toContain("12s · ↓ 13.1k tokens");
		expect(rendered).not.toContain("worker-0");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		expect(renderSubagentFleet([], theme)).toEqual([]);
	});

	test("renders child transcripts with the standard assistant and tool components", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "**Reviewing parser**\nprivate analysis" },
					{ type: "text", text: "Found two concrete defects." },
					{
						type: "toolCall",
						id: "tool-1",
						name: "ipython",
						arguments: { code: "values = [1, 2, 3]\nprint(values)" },
					},
				],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
				usage: {
					input: 10,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "ipython",
				content: [{ type: "text", text: "[1, 2, 3]\n\ncomplete" }],
				details: { status: "ok", durationMs: 1250 },
				isError: false,
				timestamp: Date.now(),
			},
		];
		const runtime = {
			listSubagentsForUi: () => [snapshot({ messages })],
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		const viewer = new SubagentConversationViewer({
			context: { mode: "tui", ui: { notify: () => undefined } } as unknown as ExtensionContext,
			runtime,
			agentId: "agent-1",
			tui: { terminal: { rows: 40 }, requestRender: () => undefined } as unknown as TUI,
			theme,
			keybindings: new KeybindingsManager(),
			done: () => undefined,
		});
		const collapsedLines = viewer.render(100).map((line) => stripAnsi(line));
		const collapsed = collapsedLines.join("\n");
		expect(collapsed).toContain("Found two concrete defects.");
		expect(collapsed).toContain("✓ python");
		expect(collapsed).toContain("values = [1, 2, 3]");
		expect(collapsed).toContain("↑ 2 ↓ 3 lines");
		expect(collapsed).not.toContain('"code"');
		expect(collapsed).not.toContain("print(values)");
		expect(collapsed).not.toContain("complete");
		expect(collapsed).not.toContain("[Assistant]");
		expect(collapsed).not.toContain("private analysis");
		expect(collapsedLines.length).toBeLessThan(20);
		expect(longestBlankRun(collapsedLines.slice(4, -4))).toBeLessThanOrEqual(1);

		viewer.handleInput("\x0f");
		const expandedLines = viewer.render(100).map((line) => stripAnsi(line));
		const expanded = expandedLines.join("\n");
		expect(expanded).toContain("print(values)");
		expect(expanded).toContain("complete");
		const completeIndex = expandedLines.findIndex((line) => line.includes("complete"));
		expect(completeIndex).toBeGreaterThanOrEqual(2);
		expect(expandedLines[completeIndex - 1]).toMatch(/^│\s*│$/);
		expect(expandedLines[completeIndex - 2]).toContain("[1, 2, 3]");

		viewer.handleInput("\x14");
		expect(stripAnsi(viewer.render(100).join("\n"))).toContain("private analysis");
		viewer.dispose();
	});

	test("bounds long Viewer content and preserves Home and End scrolling", () => {
		const result = Array.from({ length: 80 }, (_, index) => `result line ${index}`).join("\n");
		const runtime = {
			listSubagentsForUi: () => [
				snapshot({
					status: "idle",
					lastOutcome: "ok",
					result,
					messages: [],
					live: false,
				}),
			],
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		const viewer = new SubagentConversationViewer({
			context: { mode: "tui", ui: { notify: () => undefined } } as unknown as ExtensionContext,
			runtime,
			agentId: "agent-1",
			tui: { terminal: { rows: 40 }, requestRender: () => undefined } as unknown as TUI,
			theme,
			keybindings: new KeybindingsManager(),
			done: () => undefined,
		});
		const bottom = viewer.render(100).map((line) => stripAnsi(line));
		expect(bottom.length).toBeLessThanOrEqual(Math.floor(40 * 0.7));
		expect(bottom.join("\n")).toContain("100%");
		expect(bottom.join("\n")).toContain("result line 79");

		viewer.handleInput("\x1b[H");
		const top = viewer.render(100).map((line) => stripAnsi(line));
		expect(top.join("\n")).toContain("26%");
		expect(top.join("\n")).toContain("result line 0");

		viewer.handleInput("\x1b[F");
		expect(stripAnsi(viewer.render(100).join("\n"))).toContain("100%");
		viewer.dispose();
	});

	test("renders concurrent settled Agents as independent minimal Fleet rows", () => {
		const agents = [
			snapshot({
				id: "agent-1",
				name: "reviewer",
				status: "idle",
				lastOutcome: "ok",
				live: false,
			}),
			snapshot({
				id: "agent-2",
				name: "tester",
				status: "idle",
				lastOutcome: "ok",
				live: false,
			}),
		];
		const rendered = stripAnsi(
			renderSubagentFleet(agents, theme, Date.parse("2026-08-13T12:00:12.000Z"), 80).join("\n"),
		);
		expect(rendered).toContain("✓ reviewer");
		expect(rendered).toContain("✓ tester");
		expect(rendered).not.toContain("● reviewer");
		expect(rendered).not.toContain("Done");
		expect(rendered).not.toContain("Review parser changes");
		expect(rendered).not.toContain("tokens");
	});

	test("lingers settled Agents briefly, then removes the bottom Fleet", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
		let listener: (() => void) | undefined;
		let agents = [snapshot()];
		const runtime = {
			agent: { name: "Main" },
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
		const context = {
			mode: "tui",
			model: { provider: "openai", id: "gpt-test" },
			isIdle: () => true,
			ui: {
				setWidget: (
					key: string,
					content: string[] | ((tui: TUI, theme: Theme) => Component) | undefined,
					options?: ExtensionWidgetOptions,
				) => widgetUpdates.push({ key, content, options }),
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
			expect(stripAnsi(component.render(80).join("\n"))).toContain("○ reviewer  Review parser changes");

			agents = [
				snapshot({
					status: "idle",
					lastOutcome: "ok",
					result: "Completed review",
					updatedAt: new Date().toISOString(),
				}),
			];
			listener?.();
			await vi.advanceTimersByTimeAsync(32);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("✓ reviewer");

			await vi.advanceTimersByTimeAsync(3_967);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("✓ reviewer");
			await vi.advanceTimersByTimeAsync(1);
			expect(stripAnsi(component.render(80).join("\n"))).not.toContain("reviewer");
			expect(widgetUpdates.at(-1)).toMatchObject({ key: "riemann-subagents:fleet", content: undefined });
		} finally {
			controller.dispose();
			vi.useRealTimers();
		}
		expect(listener).toBeUndefined();
	});

	test("opens the selected child without rendering Main or interrupting the active cell", async () => {
		const agents = [snapshot()];
		let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
		let customCalls = 0;
		let aborts = 0;
		const widgetUpdates: Array<{
			key: string;
			content: string[] | ((tui: TUI, theme: Theme) => Component) | undefined;
			options?: ExtensionWidgetOptions;
		}> = [];
		const runtime = {
			listSubagentsForUi: () => agents,
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		const context = {
			mode: "tui",
			abort: () => {
				aborts += 1;
			},
			ui: {
				setWidget: (
					key: string,
					content: string[] | ((tui: TUI, theme: Theme) => Component) | undefined,
					options?: ExtensionWidgetOptions,
				) => widgetUpdates.push({ key, content, options }),
				onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
					input = handler;
					return () => {
						input = undefined;
					};
				},
				getEditorText: () => "",
				notify: () => undefined,
				custom: async () => {
					customCalls += 1;
					return undefined;
				},
			},
		} as unknown as ExtensionContext;
		const controller = installSubagentUi(runtime, context);
		try {
			const installed = widgetUpdates[0];
			if (!installed || typeof installed.content !== "function") throw new Error("Fleet widget was not installed");
			const component = installed.content({ requestRender: () => undefined } as unknown as TUI, theme);
			const inactive = stripAnsi(component.render(80).join("\n"));
			expect(inactive).toContain("○ reviewer");
			expect(inactive).not.toContain("main");

			input?.("\x1b[B");
			expect(stripAnsi(component.render(80).join("\n"))).toContain("● reviewer");
			input?.("\r");
			await Promise.resolve();
			await Promise.resolve();
			expect(customCalls).toBe(1);
			expect(aborts).toBe(0);
		} finally {
			controller.dispose();
		}
		expect(input).toBeUndefined();
	});

	test("requires confirmation to release a settled Hub slot and closes without interrupting the active cell", async () => {
		const agents = [
			snapshot({
				status: "idle",
				lastOutcome: "ok",
				result: "Repository structure report",
				live: false,
			}),
		];
		let releases = 0;
		const runtime = {
			listSubagentsForUi: () => agents,
			subscribeSubagentUi: () => () => undefined,
			releaseSubagentFromUi: async () => {
				releases += 1;
			},
		} as unknown as RiemannRuntime;
		let rendered = "";
		let armed = "";
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
						component.handleInput?.("r");
						component.handleInput?.("\x1b[114;1:2u");
						if (releases !== 0) throw new Error("Key repeat released the Agent");
						armed = stripAnsi(component.render(80).join("\n"));
						if (releases !== 0) throw new Error("First release key press released the Agent");
						component.handleInput?.("r");
						component.handleInput?.("\x1b");
						(component as Component & { dispose?: () => void }).dispose?.();
					}),
				notify: () => undefined,
			},
		} as unknown as ExtensionCommandContext;

		await showSubagentsHub(context, runtime);
		expect(rendered).toContain("0 active · 1 total");
		expect(rendered).toContain("reviewer");
		expect(rendered).not.toContain("Main");
		expect(rendered).not.toContain("x stop");
		expect(armed).toContain("again to RELEASE SLOT");
		expect(releases).toBe(1);
		expect(aborts).toBe(0);
		expect(closes).toBe(1);
	});

	test("reads one Viewer snapshot per render and ignores unrelated Agent updates", async () => {
		vi.useFakeTimers();
		let listCalls = 0;
		let listener: ((agentId?: string) => void) | undefined;
		const requestRender = vi.fn();
		const runtime = {
			listSubagentsForUi: () => {
				listCalls += 1;
				return [snapshot()];
			},
			subscribeSubagentUi: (next: (agentId?: string) => void) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as RiemannRuntime;
		const viewer = new SubagentConversationViewer({
			context: { mode: "tui", ui: { notify: () => undefined } } as unknown as ExtensionContext,
			runtime,
			agentId: "agent-1",
			tui: { terminal: { rows: 40 }, requestRender } as unknown as TUI,
			theme,
			keybindings: new KeybindingsManager(),
			done: () => undefined,
		});
		try {
			listCalls = 0;
			viewer.render(100);
			expect(listCalls).toBe(1);

			listCalls = 0;
			requestRender.mockClear();
			listener?.("agent-2");
			await vi.advanceTimersByTimeAsync(32);
			expect(listCalls).toBe(0);
			expect(requestRender).not.toHaveBeenCalled();

			listener?.("agent-1");
			await vi.advanceTimersByTimeAsync(32);
			expect(requestRender).toHaveBeenCalledTimes(1);
		} finally {
			viewer.dispose();
			requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(200);
			vi.useRealTimers();
		}
		expect(listener).toBeUndefined();
		expect(requestRender).not.toHaveBeenCalled();
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
