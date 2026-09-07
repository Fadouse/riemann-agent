import { beforeEach, describe, expect, test } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { highlightCode, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe.each(["dark", "light"])("%s diff colors", (name) => {
	beforeEach(() => initTheme(name));

	test("tints changed rows, separates signs and dim default gutters, and closes backgrounds", () => {
		const input = "-12 old text\n+12 new text\n 13 context\n     ...";
		const rows = renderDiff(input).split("\n");
		expect(stripAnsi(rows.join("\n"))).toBe(input);
		for (const [index, sign, color] of [
			[0, "-", "toolDiffRemoved"],
			[1, "+", "toolDiffAdded"],
		] as const) {
			expect(rows[index]).toMatch(/\x1b\[48;/);
			expect(rows[index]).toContain(theme.fg(color, sign));
			expect(rows[index]).toContain("\x1b[2m");
			expect(rows[index]).toContain("\x1b[39m12 ");
			expect(rows[index].endsWith("\x1b[49m")).toBe(true);
		}
		expect(rows[2]).not.toMatch(/\x1b\[48;/);
		expect(rows[3]).not.toMatch(/\x1b\[48;/);
	});

	test("retains syntax colors, dimming deleted syntax but not additions or context", () => {
		const code = 'const value = "hello";';
		const highlighted = highlightCode(code, "typescript")[0];
		expect(highlighted).not.toBe(code);
		for (const prefix of ["-", "+", " "]) {
			const row = renderDiff(`${prefix}1 ${code}`, { filePath: "example.ts" });
			expect(row.replace(/\x1b\[(?:2|22)m/g, "")).toContain(highlighted);
			const body = row.slice(row.indexOf("1 ") + 2);
			if (prefix === "-") expect(body).toContain("\x1b[2m");
			else expect(body).not.toContain("\x1b[2m");
		}
	});

	test("plain deletions use theme body colors without DIM, including unknown extensions", () => {
		for (const filePath of [undefined, "notes.txt"]) {
			const row = renderDiff("-1 removed text", { filePath });
			expect(row).toContain(
				name === "light" ? "\x1b[39mremoved text\x1b[39m" : theme.fg("toolDiffRemoved", "removed text"),
			);
			expect(row.slice(row.indexOf("removed text"))).not.toContain("\x1b[22m");
		}
	});

	test("preserves inline changed-word distinction with syntax and indentation", () => {
		const input = '-1 \tconst value = "old";\n+1 \tconst value = "new";';
		const rows = renderDiff(input, { filePath: "example.ts" }).split("\n");
		expect(stripAnsi(rows.join("\n"))).toBe(input.replaceAll("\t", "   "));
		for (const row of rows) {
			expect(row).toContain(theme.getFgAnsi("syntaxKeyword"));
			expect(row).not.toMatch(/\x1b\[(?:7|27)m/);
			expect(row).toContain("\x1b[1;4m");
			expect(row).toContain("\x1b[22;24m");
			expect(row).not.toContain("\x1b[1;4m   ");
		}
	});

	test("places word emphasis at source offsets when spacing and Unicode change", () => {
		const input = '-1 const 名 = "😀 old";\n+1 const  名 = "😀 new";';
		const rows = renderDiff(input, { filePath: "example.ts" }).split("\n");
		expect(stripAnsi(rows.join("\n"))).toBe(input);
		expect(rows[0]).toContain("\x1b[1;4mold\x1b[22;24m");
		expect(rows[1]).toContain("\x1b[1;4mnew\x1b[22;24m");
	});

	test("retains multi-line replacements and standalone additions", () => {
		const input = "- 1 before\n- 2 removed\n+ 1 after\n+ 2 added\n  3 same\n+ 4 extra";
		expect(stripAnsi(renderDiff(input))).toBe(input);
		expect(renderDiff(input)).not.toContain("\x1b[7m");
	});
	test("fills short changed rows with their background without padding context", () => {
		const rows = renderDiff("+1 hi\n 2 next", { width: 20 }).split("\n");
		expect(stripAnsi(rows[0])).toBe("+1 hi".padEnd(20));
		expect(rows[0]).toMatch(/ {15}\x1b\[49m$/);
		expect(stripAnsi(rows[1])).toBe(" 2 next");
	});
});
