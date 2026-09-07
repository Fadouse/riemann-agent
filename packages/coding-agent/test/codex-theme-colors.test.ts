import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	getResolvedThemeColors,
	highlightCode,
	loadThemeFromPath,
	setThemeInstance,
	Theme,
	type ThemeBg,
	type ThemeColor,
} from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-json.ts";

describe("Codex theme colors", () => {
	for (const name of ["dark", "light"]) {
		it(`${name} uses Riemann syntax and exploration accent with configurable tool colors`, () => {
			const path = fileURLToPath(new URL(`../src/modes/interactive/theme/${name}.json`, import.meta.url));
			const json = validateThemeJson(name, JSON.parse(readFileSync(path, "utf8")));
			const theme = loadThemeFromPath(path, "truecolor");
			expect(json.colors.toolTitle).toBe("");
			expect(theme.getFgAnsi("toolTitle")).toBe("\x1b[39m");
			expect(json.colors.toolOutput).toBe("");
			expect(theme.getFgAnsi("toolDiffAdded")).toBe("\x1b[38;5;2m");
			expect(theme.getFgAnsi("toolDiffRemoved")).toBe("\x1b[38;5;1m");
			expect(theme.getFgAnsi("toolDiffAddedText")).toBe(name === "dark" ? "\x1b[38;5;2m" : "\x1b[39m");
			expect(theme.getFgAnsi("toolDiffRemovedText")).toBe(name === "dark" ? "\x1b[38;5;1m" : "\x1b[39m");
			const exported = getResolvedThemeColors(name);
			expect(exported.toolDiffAddedText).toBe(name === "dark" ? "#008000" : "#000000");
			expect(exported.toolDiffRemovedText).toBe(name === "dark" ? "#800000" : "#000000");
			expect(theme.getFgAnsi("toolEntity")).toBe("\x1b[38;5;6m");
			expect(theme.getFgAnsi("toolStatusSuccess")).toBe("\x1b[38;5;2m");
			expect(theme.getFgAnsi("toolStatusError")).toBe("\x1b[38;5;1m");
			expect(theme.getFgAnsi("toolStatusWarning")).toBe("\x1b[38;5;3m");
			expect(theme.getFgAnsi("toolMetadata")).toBe("\x1b[38;5;5m");
			const expectedSyntax =
				name === "dark"
					? {
							syntaxComment: "#6A9955",
							syntaxKeyword: "#569CD6",
							syntaxFunction: "#DCDCAA",
							syntaxVariable: "#9CDCFE",
							syntaxString: "#CE9178",
							syntaxNumber: "#B5CEA8",
							syntaxType: "#4EC9B0",
							syntaxOperator: "#D4D4D4",
							syntaxPunctuation: "#D4D4D4",
							syntaxText: "",
						}
					: {
							syntaxComment: "#008000",
							syntaxKeyword: "#0000FF",
							syntaxFunction: "#795E26",
							syntaxVariable: "#001080",
							syntaxString: "#A31515",
							syntaxNumber: "#098658",
							syntaxType: "#267F99",
							syntaxOperator: "#000000",
							syntaxPunctuation: "#000000",
							syntaxText: "",
						};
			expect(Object.fromEntries(Object.entries(json.colors).filter(([key]) => key.startsWith("syntax")))).toEqual(
				expectedSyntax,
			);
			expect(theme.getFgAnsi("toolSubAction")).toBe(theme.getFgAnsi("accent"));
			expect(json.colors.toolDiffAddedBg).toBe(name === "dark" ? "#213a2b" : "#dafbe1");
			expect(json.colors.toolDiffRemovedBg).toBe(name === "dark" ? "#4a221d" : "#ffebe9");
			expect(json.colors.text).toBe("text");
			expect(json.colors.success).toBe("green");
			setThemeInstance(theme);
			const code = highlightCode("const value = 42;", "javascript").join("\n");
			expect(code).toContain(theme.fg("syntaxKeyword", "const"));
			expect(code).toContain(theme.fg("syntaxText", " value = "));
			expect(code).toContain(theme.fg("syntaxNumber", "42"));
		});
	}
});

it("optional colors validate and fall back for JSON themes and direct instances", () => {
	const json = validateThemeJson(
		"dark",
		JSON.parse(readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8")),
	);
	const optional = [
		"toolEntity",
		"toolSubAction",
		"toolStatusSuccess",
		"toolStatusError",
		"toolStatusWarning",
		"toolMetadata",
		"syntaxText",
		"toolDiffAddedText",
		"toolDiffRemovedText",
		"toolDiffAddedBg",
		"toolDiffRemovedBg",
	] as const;
	for (const key of optional) delete json.colors[key];
	expect(() => validateThemeJson("custom", json)).not.toThrow();
	const root = mkdtempSync(join(tmpdir(), "codex-theme-"));
	try {
		const path = join(root, "custom.json");
		writeFileSync(path, JSON.stringify(json));
		const loaded = loadThemeFromPath(path, "truecolor");
		const foregrounds = {} as Record<ThemeColor, string | number>;
		const backgrounds = {} as Record<ThemeBg, string | number>;
		for (const [key, value] of Object.entries(json.colors)) {
			const resolved =
				typeof value === "string" && value !== "" && !value.startsWith("#") ? json.vars![value] : value;
			if (key.endsWith("Bg")) backgrounds[key as ThemeBg] = resolved;
			else foregrounds[key as ThemeColor] = resolved;
		}
		const direct = new Theme(foregrounds, backgrounds, "truecolor");
		for (const theme of [loaded, direct]) {
			expect(theme.getFgAnsi("toolSubAction")).toBe(theme.getFgAnsi("accent"));
			expect(theme.getFgAnsi("toolDiffAddedText")).toBe(theme.getFgAnsi("toolDiffAdded"));
			expect(theme.getFgAnsi("toolDiffRemovedText")).toBe(theme.getFgAnsi("toolDiffRemoved"));
			expect(theme.getFgAnsi("syntaxText")).toBe(theme.getFgAnsi("text"));
			expect(theme.getBgAnsi("toolDiffAddedBg")).toBe(theme.getBgAnsi("toolSuccessBg"));
			expect(theme.getBgAnsi("toolDiffRemovedBg")).toBe(theme.getBgAnsi("toolErrorBg"));
		}
		json.colors.toolEntity = 256;
		expect(() => validateThemeJson("invalid", json)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
