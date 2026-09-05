import { describe, expect, test, vi } from "vitest";
import { IPythonActivityComponent } from "../src/modes/interactive/components/ipython-activity.ts";
import { IPythonCellComponent, type IPythonCellState } from "../src/modes/interactive/components/ipython-cell.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

initTheme("dark");

describe("IPython cell derived state", () => {
	test("does not split complete source/output again for status-only updates", () => {
		const state: IPythonCellState = {
			code: "value = 1\n".repeat(20_000),
			content: [{ type: "text", text: "output\n".repeat(100_000) }],
			details: { status: "ok", durationMs: 1 },
			expanded: false,
		};
		const component = new IPythonCellComponent(state);
		component.render(100);
		const split = vi.spyOn(String.prototype, "split");
		try {
			component.update({ ...state, details: { status: "ok", durationMs: 2 } });
			const lines = component.render(100);
			expect(stripAnsi(lines.join("\n"))).toContain("↑ 20000 ↓ 100000 lines");
			expect(split.mock.contexts.some((text) => String(text).length > 100_000)).toBe(false);
		} finally {
			split.mockRestore();
		}
	});

	test("preserves blank-line, block separator, mutation and trim counting semantics", () => {
		const cases: IPythonCellState[] = [
			{
				code: "\r\n \n  value = 1  \r\n\nprint(value)\n",
				content: [
					{ type: "text", text: " \n" },
					{ type: "image", text: "ignored" },
					{ type: "text", text: "a\n" },
					{ type: "text", text: "\nb  " },
				],
			},
			{ code: "\u00a0\ufeff\n", content: [{ type: "text", text: "\u00a0\ufeff" }] },
			{ code: "a\rb", content: [{ type: "text", text: "a\r\nb\r" }] },
		];
		for (const original of cases) {
			const state = { ...original, details: { status: "ok" } };
			const component = new IPythonCellComponent(state);
			for (let iteration = 0; iteration < 2; iteration++) {
				const input = state.code.split(/\r?\n/).filter((line) => line.trim()).length;
				const text = (state.content ?? [])
					.filter((block) => block.type === "text" && typeof block.text === "string")
					.map((block) => block.text)
					.join("\n")
					.trim();
				const output = text ? text.split("\n").length : 0;
				const rendered = stripAnsi(component.render(120).join("\n"));
				if (input) expect(rendered).toContain(`↑ ${input}`);
				if (output) expect(rendered).toContain(`↓ ${output}`);
				else expect(rendered).not.toContain("↓");
				if (state.content?.[0]) state.content[0].text = "new\noutput\n";
				state.code += "\nmore";
				component.invalidate();
			}
		}
	});

	test("keeps sparse content arrays compatible with the original text projection", () => {
		const content = new Array<{ type: string; text?: string }>(3);
		content[2] = { type: "text", text: "one\ntwo" };
		const component = new IPythonCellComponent({ code: "print(1)", content, details: { status: "ok" } });
		expect(stripAnsi(component.render(100).join("\n"))).toContain("↑ 1 ↓ 2 lines");
	});

	test("drops hidden render caches and reconstructs complete activities when shown again", () => {
		const state: IPythonCellState = {
			code: "print(1)",
			details: { status: "ok" },
			expanded: true,
			activities: [
				{ id: "shell", kind: "shell", operation: "run", status: "ok", command: "printf output", stdout: "output" },
			],
		};
		const component = new IPythonCellComponent(state);
		const first = component.render(80);
		const internals = component as unknown as { activityComponents: Map<string, IPythonActivityComponent> };
		expect(internals.activityComponents.size).toBe(1);
		component.update({ ...state, hidden: true });
		expect(component.render(80)).toEqual([]);
		expect(internals.activityComponents.size).toBe(0);
		component.update(state);
		expect(component.render(80)).toEqual(first);
	});

	test("appends full activity output without a spread argument-count ceiling", () => {
		const state: IPythonCellState = {
			code: "print(results)",
			details: { status: "ok" },
			expanded: true,
			activities: [{ id: "shell", kind: "shell", operation: "run", status: "ok", command: "output" }],
		};
		const render = vi
			.spyOn(IPythonActivityComponent.prototype, "render")
			.mockReturnValue(Array.from({ length: 150_000 }, (_, i) => `row ${i}`));
		try {
			const lines = new IPythonCellComponent(state).render(80);
			expect(lines).toContain("row 149999");
			expect(lines.filter((line) => line.startsWith("row "))).toHaveLength(150_000);
		} finally {
			render.mockRestore();
		}
	});
});
