import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { IPythonActivityComponent } from "../src/modes/interactive/components/ipython-activity.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function activity(diff: string, kind: "file" | "patch" = "patch", error?: string) {
	const common = {
		id: "preview",
		status: error ? ("error" as const) : ("ok" as const),
		path: "notes.md",
		diff,
		error,
	};
	return kind === "file"
		? { ...common, kind: "file" as const, operation: "create" as const }
		: { ...common, kind: "patch" as const, operation: "edit" as const };
}

// Screenshot regression: wrapping the removed Markdown paragraph hid the added side.
describe("IPython collapsed diff preview", () => {
	beforeAll(() => initTheme("dark"));
	for (const width of [32, 80]) {
		for (const kind of ["file", "patch"] as const) {
			test(`${kind} long replacement at ${width}`, () => {
				const source = activity(
					` 1 heading
-2 old ${"paragraph ".repeat(100)}OLD_END
+2 new ${"paragraph ".repeat(100)}NEW_END`,
					kind,
				);
				const component = new IPythonActivityComponent(source, false);
				const rows = component.render(width);
				const text = stripAnsi(rows.join("\n"));
				expect(text).toContain("-2 old");
				expect(text).toContain("+2 new");
				expect(text).toContain("…");
				expect(rows.length).toBeLessThanOrEqual(6);
				expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
				component.update(source, true);
				const expanded = component.render(width);
				const full = stripAnsi(expanded.join("\n")).replace(/\s/g, "");
				expect(full).toContain("OLD_END");
				expect(full).toContain("NEW_END");
				expect(full.match(/paragraph/g)).toHaveLength(200);
				expect(expanded.every((row) => visibleWidth(row) <= width)).toBe(true);
			});
		}
		test(`multiple removals retain first addition, not unrelated tail at ${width}`, () => {
			const diff = [
				" 1 lead",
				" 2 context",
				...Array.from({ length: 8 }, (_, i) => `-${i + 3} old${i}`),
				"+3 replacement",
				" 4 between",
				"     ...",
				"-90 unrelated-old",
				"+90 unrelated-new",
			].join("\n");
			const rows = new IPythonActivityComponent(activity(diff), false).render(width);
			const text = stripAnsi(rows.join("\n"));
			expect(text).toContain("-3 old0");
			expect(text).toContain("+3 replacement");
			expect(text).not.toContain("unrelated");
			expect(text).toContain("11 omitted (2 context)");
			expect(text).toContain("context");
			expect(rows.length).toBeLessThanOrEqual(6);
		});
		for (const sign of ["+", "-"]) {
			test(`pure ${sign} does not borrow opposite side from later hunk at ${width}`, () => {
				const diff = [
					`${sign}1 first`,
					...Array.from({ length: 8 }, (_, i) => `${sign}${i + 2} row${i}`),
					"     ...",
					`${sign === "+" ? "-" : "+"}90 unrelated`,
				].join("\n");
				const source = activity(diff);
				const component = new IPythonActivityComponent(source, false);
				const rows = component.render(width);
				expect(stripAnsi(rows.join("\n"))).not.toContain("unrelated");
				expect(stripAnsi(rows.join("\n"))).toContain(`${sign}1 first`);
				expect(rows.length).toBeLessThanOrEqual(6);
				component.update(source, true);
				expect(stripAnsi(component.render(width).join("\n"))).toContain("unrelated");
			});
		}
		test(`errors and context omission survive at ${width}`, () => {
			const diff = [" 1 a", " 2 b", " 3 c", "-4 old", "-5 old", "-6 old", "+4 new", " 5 end"].join("\n");
			const rows = new IPythonActivityComponent(activity(diff, "patch", "failed validation"), false).render(width);
			const text = stripAnsi(rows.join("\n"));
			expect(text).toContain("failed validation");
			expect(text).toContain("-4 old");
			expect(text).toContain("+4 new");
			expect(text).toContain("context");
			expect(rows.length).toBeLessThanOrEqual(6);
		});
	}
});
