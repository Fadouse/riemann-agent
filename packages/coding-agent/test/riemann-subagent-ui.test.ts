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
		const lines = renderSubagentFleet(agents, theme, Date.parse("2026-08-13T12:00:12.000Z"), 80, 7, true);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("select");
		expect(rendered).toContain("○ main");
		expect(rendered).toContain("● worker-6");
		expect(rendered).toContain("Working…");
		expect(rendered).toContain("↑ 2 more");
		expect(rendered).toContain("12s · ↓ 13.1k tokens");
		expect(rendered).not.toContain("worker-0");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("renders child transcripts with the standard assistant and tool components", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "**Reviewing parser**\nprivate analysis" },
					{ type: "text", text: "Found two concrete defects." },
					{ type: "toolCall", id: "tool-1", name: "ipython", arguments: { code: "print('ok')" } },
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
				content: [{ type: "text", text: "ok" }],
				details: { status: "ok", durationMs: 5 },
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
		const collapsed = stripAnsi(viewer.render(100).join("\n"));
		expect(collapsed).toContain("Found two concrete defects.");
		expect(collapsed).toContain("python");
		expect(collapsed).toContain("print('ok')");
		expect(collapsed).not.toContain("[Assistant]");
		expect(collapsed).not.toContain("private analysis");

		viewer.handleInput("\x14");
		expect(stripAnsi(viewer.render(100).join("\n"))).toContain("private analysis");
		viewer.dispose();
	});

	test("renders concurrent settled Agents as independent minimal success rows", () => {
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
			expect(stripAnsi(component.render(80).join("\n"))).toContain("● reviewer  Working…");

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
		expect(rendered).not.toContain("x stop");
		expect(armed).toContain("again to RELEASE SLOT");
		expect(releases).toBe(1);
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
