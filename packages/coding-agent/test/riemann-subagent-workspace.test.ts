import { type Component, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { installSubagentUi, showSubagentsHub } from "../src/extensions/riemann/subagent-ui.ts";
import { SubagentConversationViewer, type SubagentViewState } from "../src/extensions/riemann/subagent-view.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../src/riemann/agents/supervisor.ts";
import type { RiemannRuntime } from "../src/riemann/runtime.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function agent(overrides: Partial<SubagentUiSnapshot> = {}): SubagentUiSnapshot {
	return {
		id: "a",
		name: "reviewer",
		turnId: "turn",
		status: "running",
		task: "Review parser",
		modelRole: "inherit",
		model: "test/model",
		workspace: "/workspace",
		createdAt: "2026-09-05T12:00:00Z",
		updatedAt: "2026-09-05T12:00:12Z",
		turnCount: 2,
		toolUses: 1,
		tokens: 13100,
		messages: [],
		live: true,
		...overrides,
	};
}
function fixture(snapshot: SubagentUiSnapshot, rows = 24, state: SubagentViewState = {}) {
	const notify = vi.fn();
	const steer = vi.fn(async (): Promise<void> => undefined);
	const requestRender = vi.fn();
	const release = vi.fn(async () => undefined);
	const runtime = {
		listSubagentsForUi: () => [snapshot],
		subscribeSubagentUi: () => () => undefined,
		steerSubagentFromUi: steer,
		releaseSubagentFromUi: release,
	} as unknown as RiemannRuntime;
	const viewer = new SubagentConversationViewer({
		context: { mode: "tui", ui: { notify } } as unknown as ExtensionContext,
		runtime,
		agentId: "a",
		tui: { terminal: { rows }, requestRender } as unknown as TUI,
		theme,
		keybindings: new KeybindingsManager(),
		done: () => undefined,
		state,
	});
	return { viewer, notify, steer, release, requestRender };
}
function text(component: Component, width = 72): string {
	return stripAnsi(component.render(width).join("\n"));
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
describe("Subagent workspace regressions", () => {
	test("Fleet leaves Up history and foreign-overlay input alone", () => {
		let overlay = false;
		let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
		const tui = {
			hasOverlay: () => overlay,
			getFocusedComponent: () => ({ getText: () => "", setText: () => undefined }),
			requestRender: () => undefined,
		} as unknown as TUI;
		const runtime = {
			listSubagentsForUi: () => [agent()],
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		const context = {
			mode: "tui",
			ui: {
				getEditorText: () => "",
				setWidget: (_key: string, factory: ((tui: TUI, currentTheme: typeof theme) => Component) | undefined) =>
					factory?.(tui, theme),
				onTerminalInput: (handler: typeof input) => {
					input = handler;
					return () => undefined;
				},
			},
		} as unknown as ExtensionContext;
		const controller = installSubagentUi(runtime, context);
		try {
			expect(input?.("\x1b[A")).toBeUndefined();
			overlay = true;
			expect(input?.("\x1b[B")).toBeUndefined();
			expect(input?.("\x1b[D")).toBeUndefined();
			overlay = false;
			expect(input?.("\x1b[B")).toEqual({ consume: true });
		} finally {
			controller.dispose();
		}
	});
	test("failed steering restores the draft for retry", async () => {
		const { viewer, steer, notify } = fixture(agent());
		steer.mockRejectedValue(new Error("rejected"));
		try {
			viewer.handleInput("m");
			viewer.handleInput("Keep this draft");
			viewer.handleInput("\r");
			await Promise.resolve();
			await Promise.resolve();
			expect(notify).toHaveBeenCalled();
			expect(text(viewer, 100)).toContain("Keep this draft");
		} finally {
			viewer.dispose();
		}
	});
	test("idle agents cannot steer or stop and settlement errors remain visible with a transcript", () => {
		const { viewer } = fixture(
			agent({
				status: "idle",
				live: false,
				lastOutcome: "error",
				error: "Patch capture failed",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "Review completed" }], stopReason: "stop" },
				],
			}),
		);
		try {
			expect(text(viewer, 100)).toContain("Patch capture failed");
			expect(text(viewer, 100)).not.toContain("message");
			expect(text(viewer, 100)).not.toContain("x stop");
			viewer.handleInput("m");
			expect(text(viewer, 100)).not.toContain("send");
		} finally {
			viewer.dispose();
		}
	});
	test("Viewer suppresses the main-cell interrupt hint", () => {
		const { viewer } = fixture(
			agent({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "t",
								name: "ipython",
								arguments: { code: "await shell.run(script='wait')" },
							},
						],
						stopReason: "toolUse",
					},
				],
			}),
		);
		try {
			expect(text(viewer, 100)).not.toContain("escape to interrupt");
		} finally {
			viewer.dispose();
		}
	});
	test("Viewer restores scroll position and expansion preferences after Hub round trips", () => {
		const state: SubagentViewState = {};
		const snapshot = agent({
			status: "idle",
			live: false,
			result: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"),
		});
		const first = fixture(snapshot, 30, state).viewer;
		first.render(80);
		first.handleInput("\x1b[H");
		first.handleInput("\x1b[B");
		first.handleInput("\x14");
		const before = text(first, 80);
		first.dispose();
		expect(state.hideThinking).toBe(false);
		expect(state.scrollOffset).toBe(1);
		const second = fixture(snapshot, 30, state).viewer;
		try {
			expect(text(second, 80)).toBe(before);
		} finally {
			second.dispose();
		}
	});
	test("animation frames rerender only unfinished tools, not Markdown or settled tools", () => {
		vi.useFakeTimers();
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Stable answer" },
					{ type: "toolCall", id: "done", name: "ipython", arguments: { code: "print(1)" } },
					{ type: "toolCall", id: "active", name: "ipython", arguments: { code: "print(2)" } },
				],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "done",
				toolName: "ipython",
				content: [{ type: "text", text: "1" }],
				isError: false,
				details: { status: "ok" },
			},
		];
		const markdown = vi.spyOn(AssistantMessageComponent.prototype, "render");
		const tool = vi.spyOn(ToolExecutionComponent.prototype, "render");
		const { viewer, requestRender } = fixture(agent({ messages }));
		try {
			viewer.render(100);
			markdown.mockClear();
			tool.mockClear();
			vi.advanceTimersByTime(80);
			expect(requestRender).toHaveBeenCalled();
			viewer.render(100);
			expect(markdown).not.toHaveBeenCalled();
			expect(tool).toHaveBeenCalledTimes(1);
			viewer.dispose();
			requestRender.mockClear();
			vi.advanceTimersByTime(800);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			viewer.dispose();
			markdown.mockRestore();
			tool.mockRestore();
			vi.useRealTimers();
		}
	});
	test("Hub keeps selection and explains release consequences and saved artifacts", async () => {
		const state = { selectedAgentId: "a" };
		const agents = [
			agent({
				status: "idle",
				live: false,
				lastOutcome: "ok",
				transcriptHandle: "artifact://transcript",
				patchHandle: "artifact://patch",
			}),
			agent({ id: "b", name: "tester", status: "idle", live: false }),
		];
		const runtime = {
			listSubagentsForUi: () => agents,
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		const context = {
			mode: "tui",
			ui: {
				custom: async (
					factory: (
						tui: TUI,
						currentTheme: typeof theme,
						keybindings: KeybindingsManager,
						done: (value: string | undefined) => void,
					) => Component & { dispose(): void },
				) => {
					const component = factory(
						{ terminal: { rows: 30 }, requestRender: () => undefined } as unknown as TUI,
						theme,
						new KeybindingsManager(),
						() => undefined,
					);
					try {
						component.handleInput?.("r");
						const rendered = text(component, 80);
						expect(rendered).toMatch(/worktree.*delet/i);
						expect(rendered).toContain("artifact://transcript");
						expect(rendered).toContain("artifact://patch");
					} finally {
						component.dispose();
					}
					return undefined;
				},
			},
		} as unknown as ExtensionCommandContext;
		await showSubagentsHub(context, runtime, state);
	});
	test("short Hub review stays bounded and cannot release before consequences are read", async () => {
		const snapshot = agent({
			status: "idle",
			live: false,
			lastOutcome: "ok",
			workspace: "/isolated/long/path",
			transcriptHandle: "artifact://saved-transcript",
			patchHandle: "artifact://saved-patch",
		});
		const release = vi.fn(async () => undefined);
		const runtime = {
			listSubagentsForUi: () => [snapshot],
			subscribeSubagentUi: () => () => undefined,
			releaseSubagentFromUi: release,
		} as unknown as RiemannRuntime;
		const context = {
			mode: "tui",
			ui: {
				custom: async (
					factory: (
						tui: TUI,
						currentTheme: typeof theme,
						keybindings: KeybindingsManager,
						done: (value: string | undefined) => void,
					) => Component & { dispose(): void },
				) => {
					const component = factory(
						{ terminal: { rows: 12 }, requestRender: () => undefined } as unknown as TUI,
						theme,
						new KeybindingsManager(),
						() => undefined,
					);
					try {
						component.render(36);
						component.handleInput?.("r");
						component.handleInput?.("r");
						expect(release).not.toHaveBeenCalled();
						for (let i = 0; i < 40; i++) {
							const lines = component.render(36);
							expect(lines.length).toBeLessThanOrEqual(8);
							expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
							expect(stripAnsi(lines.join("\n"))).toContain("q cancel");
							component.handleInput?.("\x1b[B");
						}
						expect(text(component, 36)).toContain("r confirm");
						component.handleInput?.("r");
						expect(release).toHaveBeenCalledTimes(1);
					} finally {
						component.dispose();
					}
					return undefined;
				},
			},
		} as unknown as ExtensionCommandContext;
		await showSubagentsHub(context, runtime);
	});
	test("short Viewer release review preserves cancel and requires reaching the end", () => {
		const { viewer, release } = fixture(
			agent({ status: "idle", live: false, lastOutcome: "ok", transcriptHandle: "artifact://transcript" }),
			12,
		);
		try {
			viewer.render(36);
			viewer.handleInput("r");
			viewer.handleInput("r");
			expect(release).not.toHaveBeenCalled();
			expect(text(viewer, 36)).toContain("q cancel");
			viewer.handleInput("\x1b[F");
			expect(text(viewer, 36)).toContain("r confirm");
			viewer.handleInput("q");
			expect(text(viewer, 36)).toContain("q close");
			expect(release).not.toHaveBeenCalled();
		} finally {
			viewer.dispose();
		}
	});
	test("draft remains recoverable if the turn settles during a failed send", async () => {
		const snapshot = agent();
		const { viewer, steer } = fixture(snapshot);
		steer.mockImplementation(async () => {
			snapshot.status = "idle";
			snapshot.live = false;
			throw new Error("settled");
		});
		try {
			viewer.handleInput("m");
			viewer.handleInput("Recover after settlement");
			viewer.handleInput("\r");
			await Promise.resolve();
			await Promise.resolve();
			expect(text(viewer, 100)).toContain("Recover after settlement");
			expect(text(viewer, 100)).toContain("draft kept");
			viewer.handleInput("\r");
			expect(steer).toHaveBeenCalledTimes(1);
		} finally {
			viewer.dispose();
		}
	});
	test("a successful send that finishes after close clears the remembered draft", async () => {
		const state: SubagentViewState = {};
		let finish: () => void = () => undefined;
		const { viewer, steer } = fixture(agent(), 24, state);
		steer.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		viewer.handleInput("m");
		viewer.handleInput("Send once");
		viewer.handleInput("\r");
		viewer.handleInput("q");
		finish();
		await Promise.resolve();
		await Promise.resolve();
		expect(state.draft).toBe("");
		viewer.dispose();
	});
	test("pending output growth has no argument-count limit and keeps the transcript tail", () => {
		let expanded = false;
		const render = vi
			.spyOn(ToolExecutionComponent.prototype, "render")
			.mockImplementation(() =>
				expanded ? Array.from({ length: 150_000 }, (_, index) => `output ${index}`) : ["initial output"],
			);
		const { viewer } = fixture(
			agent({
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "active", name: "ipython", arguments: { code: "print(1)" } }],
						stopReason: "toolUse",
					},
				],
			}),
		);
		try {
			viewer.render(100);
			expanded = true;
			const rendered = text(viewer, 100);
			expect(rendered).toContain("output 149999");
			expect(rendered).toContain("running");
		} finally {
			viewer.dispose();
			render.mockRestore();
		}
	});
	test("zero-content-height release review cannot be confirmed without showing consequences", () => {
		const { viewer, release } = fixture(agent({ status: "idle", live: false }), 6);
		try {
			viewer.render(36);
			viewer.handleInput("r");
			viewer.handleInput("\x1b[F");
			viewer.handleInput("r");
			expect(release).not.toHaveBeenCalled();
		} finally {
			viewer.dispose();
		}
	});
	test("inline selectors own direction keys and cancel even without an overlay", () => {
		let focus: unknown = { getText: () => "", setText: () => undefined };
		let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
		const tui = {
			hasOverlay: () => false,
			getFocusedComponent: () => focus,
			requestRender: () => undefined,
		} as unknown as TUI;
		const runtime = {
			listSubagentsForUi: () => [agent()],
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		const context = {
			mode: "tui",
			ui: {
				getEditorText: () => "",
				setWidget: (_key: string, factory: ((tui: TUI, currentTheme: typeof theme) => Component) | undefined) =>
					factory?.(tui, theme),
				onTerminalInput: (handler: typeof input) => {
					input = handler;
					return () => undefined;
				},
			},
		} as unknown as ExtensionContext;
		const controller = installSubagentUi(runtime, context);
		try {
			expect(input?.("\x1b[B")).toEqual({ consume: true });
			focus = { render: () => ["model selector"], handleInput: () => undefined };
			expect(input?.("\x1b[B")).toBeUndefined();
			expect(input?.("\x1b[D")).toBeUndefined();
			expect(input?.("\x1b")).toBeUndefined();
			focus = { getText: () => "", setText: () => undefined };
			expect(input?.("\x1b[A")).toBeUndefined();
			expect(input?.("\x1b[D")).toEqual({ consume: true });
		} finally {
			controller.dispose();
		}
	});
});
