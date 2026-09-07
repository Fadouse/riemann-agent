import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { IPythonActivityComponent } from "../src/modes/interactive/components/ipython-activity.ts";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function createIPythonDefinition(): ToolDefinition {
	return {
		name: "ipython",
		label: "IPython",
		description: "execute a cell",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

describe("Riemann IPython transcript", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("animates only running marker colors without rebuilding tool bodies", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"ipython",
				"animated-cell",
				{ code: "await shell.run(script='sleep 10')" },
				{},
				undefined,
				{ requestRender } as unknown as TUI,
				process.cwd(),
			);
			component.markExecutionStarted();
			component.setArgsComplete();
			component.setExpanded(true);
			const activities = [
				{
					id: "running",
					kind: "shell",
					status: "running",
					operation: "run",
					command: "sleep 10",
					stdout: "unchanged output",
				},
				{ id: "done", kind: "file", status: "ok", operation: "create", path: "done.ts" },
			] as const;
			component.updateResult(
				{
					content: [{ type: "text", text: "partial output" }],
					details: { status: "running", activities },
					isError: false,
				},
				true,
			);
			const first = [...component.render(100)];
			requestRender.mockClear();
			const activityRender = vi.spyOn(IPythonActivityComponent.prototype, "render");
			await vi.advanceTimersByTimeAsync(880);
			const next = [...component.render(100)];
			expect(requestRender).toHaveBeenCalled();
			expect(stripAnsi(next.join("\n"))).toBe(stripAnsi(first.join("\n")));
			expect(next).not.toEqual(first);
			expect(activityRender).not.toHaveBeenCalled();
			activityRender.mockRestore();

			// A settled cell must also freeze any stale running child activity.
			component.updateResult({
				content: [{ type: "text", text: "done" }],
				details: { status: "ok", activities },
				isError: false,
			});
			const settled = [...component.render(100)];
			await vi.advanceTimersByTimeAsync(2400);
			requestRender.mockClear();
			expect(component.render(100)).toEqual(settled);
			await vi.advanceTimersByTimeAsync(2400);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	test.each(["error", "aborted", "cancelled", "timeout"])("stops marker animation after %s", async (status) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const component = new IPythonCellComponent({ code: "await work()", executionStarted: true, isPartial: true });
			const running = [...component.render(80)];
			await vi.advanceTimersByTimeAsync(880);
			expect(component.render(80)).not.toEqual(running);
			component.update({ code: "await work()", executionStarted: true, isPartial: false, details: { status } });
			const settled = [...component.render(80)];
			await vi.advanceTimersByTimeAsync(1200);
			expect(component.render(80)).toEqual(settled);
		} finally {
			vi.useRealTimers();
		}
	});

	test("animates queued marker colors without changing source metadata or showing running controls", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const component = new IPythonCellComponent({ code: "value = 1\nawait work(value)", isPartial: true });
			const queued = [...component.render(80)];
			const text = stripAnsi(queued.join("\n"));
			expect(text).toContain("Python");
			expect(text).toContain("2 lines");
			expect(text).not.toContain("to interrupt");
			expect(text).not.toContain("await work");
			await vi.advanceTimersByTimeAsync(880);
			const next = [...component.render(80)];
			expect(next).not.toEqual(queued);
			expect(stripAnsi(next.join("\n"))).toBe(text);

			component.update({ code: "value = 1\nawait work(value)", isPartial: true, executionStarted: true });
			const running = stripAnsi(component.render(80).join("\n"));
			expect(running).toContain("escape to interrupt");
			expect(running).not.toContain("2 lines");
		} finally {
			vi.useRealTimers();
		}
	});

	test("lets embedded viewers own the animation clock", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"ipython",
				"embedded",
				{ code: "await work()" },
				{ interruptHint: false, requestAnimationFrames: false },
				undefined,
				{ requestRender } as unknown as TUI,
				process.cwd(),
			);
			component.markExecutionStarted();
			requestRender.mockClear();
			const first = [...component.render(80)];
			await vi.advanceTimersByTimeAsync(880);
			expect(component.render(80)).not.toEqual(first);
			expect(requestRender).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("settles an empty final tool result without renewing animation frames", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"ipython",
				"empty",
				{ code: "pass" },
				{},
				undefined,
				{ requestRender } as unknown as TUI,
				process.cwd(),
			);
			component.markExecutionStarted();
			component.setArgsComplete();
			component.render(80);
			component.updateResult({ content: [], isError: false });
			for (let i = 0; i < 3; i++) {
				await vi.advanceTimersByTimeAsync(80);
				component.render(80);
			}
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("uses a compact backgroundless summary and expands code plus output", () => {
		const args = { code: "values = [1, 2, 3]\nprint(values)" };
		const result = {
			content: [{ type: "text", text: "[1, 2, 3]\ncomplete" }],
			details: { status: "ok", durationMs: 1250 },
			isError: false,
		};
		const component = new ToolExecutionComponent(
			"ipython",
			"cell-1",
			args,
			{},
			createIPythonDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult(result, false);
		const definitionless = new ToolExecutionComponent(
			"ipython",
			"cell-without-definition",
			args,
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		definitionless.markExecutionStarted();
		definitionless.setArgsComplete();
		definitionless.updateResult(result, false);

		const collapsedLines = component.render(80);
		expect(definitionless.render(80)).toEqual(collapsedLines);
		const collapsed = stripAnsi(collapsedLines.join("\n"));
		expect(collapsed).toContain("1.3s");
		expect(collapsed).not.toContain("to expand");
		expect(collapsed).not.toContain("print(values)");
		expect(collapsedLines.join("\n")).not.toMatch(/\x1b\[(?:4\d|48[;:])/);

		component.setExpanded(true);
		const expandedLines = component.render(80);
		const expanded = stripAnsi(expandedLines.join("\n"));
		expect(expanded).not.toContain("to collapse");
		expect(expanded).toContain("print(values)");
		expect(expanded).toContain("[1, 2, 3]");
		expect(expanded).toContain("complete");
		expect(expandedLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
	});

	test("keeps complete ordinary Python output available when expanded", () => {
		const longOutput = Array.from(
			{ length: 10 },
			(_, index) =>
				`${index} ${"A very long search result body that would wrap across several terminal rows ".repeat(4)}`,
		).join("\n");
		const component = new IPythonCellComponent({
			code: "print(results)",
			content: [{ type: "text", text: longOutput }],
			details: { status: "ok", durationMs: 8 },
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});

		component.render(80);

		component.update({
			code: "print(results)",
			content: [{ type: "text", text: longOutput }],
			details: { status: "ok", durationMs: 8 },
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		expect(stripAnsi(component.render(80).join("\n"))).toContain("search result body");
	});
	test("shows the configured interrupt key while a cell is running", () => {
		const component = new IPythonCellComponent({
			code: "await asyncio.sleep(60)",
			details: { status: "running" },
			isPartial: true,
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(stripAnsi(component.render(100).join("\n"))).toContain("escape to interrupt");

		component.update({
			code: "await asyncio.sleep(60)",
			details: { status: "cancelled" },
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(stripAnsi(component.render(100).join("\n"))).not.toContain("to interrupt");
	});

	test("renders shell, subagent, file, and patch activities inside the IPython cell", () => {
		const component = new IPythonCellComponent({
			code: "result = await shell.run(script='npm test')",
			content: [{ type: "text", text: "Cell completed. No explicit output." }],
			details: { status: "ok", durationMs: 250 },
			activities: [
				{
					id: "shell-1",
					kind: "shell",
					status: "ok",
					operation: "run",
					command: "npm test",
					stdout: "Tests 12 passed",
					exitCode: 0,
					durationMs: 120,
				},
				{
					id: "agent-1",
					kind: "agent",
					status: "ok",
					operation: "spawn",
					name: "Reviewer",
					task: "Review the changed parser",
					agentStatus: "running",
				},
				{
					id: "file-1",
					kind: "file",
					status: "ok",
					operation: "create",
					path: "src/new.ts",
					diff: "+1 export const value = 1;",
					additions: 1,
				},
				{
					id: "patch-1",
					kind: "patch",
					status: "ok",
					operation: "edit",
					path: "src/main.ts",
					diff: "-1 const value = 1;\\n+1 const value = 2;",
					additions: 1,
					removals: 1,
				},
			],
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		const collapsed = stripAnsi(component.render(90).join("\\n"));
		expect(collapsed).toContain("npm test");
		expect(collapsed).toContain("Tests 12 passed");
		expect(collapsed).toContain("spawn Reviewer");
		expect(collapsed).toContain("src/new.ts");
		expect(collapsed).toContain("src/main.ts");
		expect(collapsed).toContain("+1");
		expect(collapsed).toContain("-1");

		component.update({
			code: "result = await shell.run(script='npm test')",
			content: [{ type: "text", text: "Cell completed. No explicit output." }],
			details: { status: "ok", durationMs: 250 },
			activities: [
				{
					id: "patch-1",
					kind: "patch",
					status: "ok",
					operation: "edit",
					path: "src/main.ts",
					diff: "-1 const value = 1;\\n+1 const value = 2;",
					additions: 1,
					removals: 1,
				},
			],
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		const expanded = stripAnsi(component.render(90).join("\\n"));
		expect(expanded).toContain("-1 const value = 1;");
		expect(expanded).toContain("+1 const value = 2;");
	});

	test("caps wrapped shell output by visual rows while collapsed", () => {
		const longLine = "wrapped-output ".repeat(20);
		const activity = {
			id: "shell-wrapped",
			stdoutTruncated: true,
			stdoutCaptureTruncated: true,
			stdoutArtifactHandle: "artifact://stdout",
			kind: "shell",
			status: "ok",
			operation: "run",
			command: "cat logs/vllm.log",
			stdout: [longLine, longLine, longLine, `${longLine}tail-sentinel`].join("\n"),
			exitCode: 0,
			durationMs: 25,
		} as const;
		const component = new IPythonActivityComponent(activity, false);

		for (const width of [32, 60]) {
			const lines = component.render(width);
			const rendered = stripAnsi(lines.join("\n"));
			expect(rendered).toContain("tail-sentinel");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}

		const collapsedLength = component.render(32).length;
		component.update(activity, true);
		expect(component.render(32).length).toBeGreaterThan(collapsedLength);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("stdout capture incomplete");
		expect(expanded).toContain("artifact://stdout");
	});

	test("checks an activity render cache without serializing full output", () => {
		const activity = {
			id: "large",
			kind: "shell",
			status: "ok",
			operation: "run",
			command: "print logs",
			stdout: "line\n".repeat(20_000),
		} as const;
		const component = new IPythonActivityComponent(activity, false);
		const first = component.render(80);
		const stringify = vi.spyOn(JSON, "stringify");
		try {
			expect(component.render(80)).toBe(first);
			expect(stringify).not.toHaveBeenCalled();
		} finally {
			stringify.mockRestore();
		}
	});

	test("compares cached activity fields without allocating entry tuples", () => {
		const activity = {
			id: "fields",
			kind: "shell",
			status: "ok",
			operation: "run",
			command: "true",
			stdout: "output",
		} as const;
		const component = new IPythonActivityComponent(activity, false);
		const first = component.render(80);
		const entries = vi.spyOn(Object, "entries");
		try {
			expect(component.render(80)).toBe(first);
			expect(entries.mock.calls.some(([value]) => value === activity)).toBe(false);
		} finally {
			entries.mockRestore();
		}
	});

	test("reuses rendered output when a tracker returns an equal copied activity", () => {
		const activity = {
			id: "copied",
			kind: "shell",
			status: "ok",
			operation: "run",
			command: "print logs",
			stdout: "first",
		} as const;
		const component = new IPythonActivityComponent(activity, false);
		const first = component.render(80);
		component.update({ ...activity }, false);
		expect(component.render(80)).toBe(first);
		component.update({ ...activity, stdout: "changed" }, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("changed");
	});

	test("detects in-place activity mutations and removed fields without update", () => {
		const activity: {
			id: string;
			kind: "shell";
			status: "ok" | "error";
			operation: string;
			command: string;
			stdout?: string;
			error?: string;
		} = {
			id: "mutable",
			kind: "shell",
			status: "ok",
			operation: "run",
			command: "print logs",
			stdout: "first",
		};
		const component = new IPythonActivityComponent(activity, true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("first");
		activity.stdout = "second";
		expect(stripAnsi(component.render(80).join("\n"))).toContain("second");
		delete activity.stdout;
		activity.status = "error";
		activity.error = "failed";
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).not.toContain("second");
		expect(output).toContain("failed");
	});

	test("keeps narrow error output inside the viewport", () => {
		const component = new IPythonCellComponent({
			code: "raise ValueError('a long failure message')",
			content: [{ type: "text", text: "ValueError: a long failure message that must wrap" }],
			details: { status: "error", durationMs: 12, errorName: "ValueError" },
			isError: true,
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		const lines = component.render(24);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("ValueError");
		expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});
});
