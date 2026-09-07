import type { TUI } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

test("a yielded tool result remains visible without falsely showing completion or animating a finished request", () => {
	initTheme("dark");
	const component = new IPythonCellComponent({
		code: 'print("hello")',
		isPartial: false,
		executionStarted: true,
		details: { status: "running", cellId: "cell-123", durationMs: 10000 },
		content: [{ type: "text", text: "Script running with cell ID cell-123" }],
	});
	const rendered = component.render(100).map(stripAnsi).join("\n");
	expect(rendered).toContain("Yielded");
	expect(rendered).not.toContain("cell-123");
	expect(rendered).not.toContain("cell ID");
	expect(rendered).not.toContain("ipython_wait");
	expect(component.hasRunningAnimation()).toBe(false);
});

test.each([false, true])("exec and wait hide protocol IDs but retain output references (expanded=%s)", (expanded) => {
	initTheme("dark");
	for (const name of ["ipython", "ipython_wait"]) {
		const component = new ToolExecutionComponent(
			name,
			"tool-call",
			name === "ipython" ? { code: "print(42)" } : { cell_id: "c1234abcd" },
			{ requestAnimationFrames: false },
			undefined,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(expanded);
		for (const status of ["running", "ok", "error"]) {
			const header = status === "running" ? "running cell_id=c1234abcd; use ipython_wait; do not rerun" : status;
			component.updateResult({
				content: [{ type: "text", text: `${header}\nselected output\n[more r7]` }],
				details: { status, cellId: "c1234abcd", moreRef: "r7" },
				isError: status === "error",
			});
			const rendered = component.render(100).map(stripAnsi).join("\n");
			expect(rendered).not.toContain("c1234abcd");
			expect(rendered).not.toContain("cell_id");
			expect(rendered).not.toContain("yield_time_ms");
			expect(rendered).not.toContain("Script running");
			expect(rendered).toContain("selected output");
			expect(rendered.match(/\[more r7\]/g)).toHaveLength(1);
		}
		component.updateResult({
			content: [
				{
					type: "text",
					text: "ipython_wait [runtime_error]: Unknown or already collected Python cell: c1234abcd\n[details=r8]",
				},
			],
			isError: true,
		});
		expect(component.render(100).map(stripAnsi).join("\n")).not.toContain("c1234abcd");
	}
});
