import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
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
		expect(collapsed).toContain("✓ python");
		expect(collapsed).toContain("values = [1, 2, 3]");
		expect(collapsed).toContain("↑ 2 ↓ 2 lines");
		expect(collapsed).toContain("1.3s");
		expect(collapsed).not.toContain("to expand");
		expect(collapsed).not.toContain("print(values)");
		expect(collapsed).not.toContain("complete");
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

	test("keeps long ordinary Python output hidden until expanded", () => {
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

		const collapsedLines = component.render(80);
		const collapsed = stripAnsi(collapsedLines.join("\n"));
		expect(collapsedLines).toHaveLength(1);
		expect(collapsed).toContain("✓ python");
		expect(collapsed).toContain("↓ 10 lines");
		expect(collapsed).not.toContain("search result body");

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
			details: { status: "aborted" },
			isPartial: false,
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(stripAnsi(component.render(100).join("\n"))).not.toContain("to interrupt");
	});

	test("renders shell, subagent, file, and patch activities inside the IPython cell", () => {
		const component = new IPythonCellComponent({
			code: "result = await shell.exec(script='npm test')",
			content: [{ type: "text", text: "Cell completed. No explicit output." }],
			details: { status: "ok", durationMs: 250 },
			activities: [
				{
					id: "shell-1",
					kind: "shell",
					status: "ok",
					operation: "exec",
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
		expect(collapsed).toContain("$ npm test");
		expect(collapsed).toContain("Tests 12 passed");
		expect(collapsed).toContain("spawn Reviewer");
		expect(collapsed).toContain("create src/new.ts");
		expect(collapsed).toContain("patch src/main.ts");
		expect(collapsed).toContain("+1");
		expect(collapsed).toContain("-1");

		component.update({
			code: "result = await shell.exec(script='npm test')",
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
			kind: "shell",
			status: "ok",
			operation: "exec",
			command: "cat logs/vllm.log",
			stdout: [longLine, longLine, longLine, `${longLine}tail-sentinel`].join("\n"),
			exitCode: 0,
			durationMs: 25,
		} as const;
		const component = new IPythonActivityComponent(activity, false);

		for (const width of [32, 60]) {
			const lines = component.render(width);
			const rendered = stripAnsi(lines.join("\n"));
			expect(lines).toHaveLength(14);
			expect(rendered).toContain("earlier lines");
			expect(rendered).toContain("tail-sentinel");
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}

		component.update(activity, true);
		expect(component.render(32).length).toBeGreaterThan(14);
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
		expect(rendered).toContain("✗ python");
		expect(rendered).toContain("ValueError");
		expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});
});
