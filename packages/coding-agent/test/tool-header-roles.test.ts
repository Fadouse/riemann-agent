import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { IPythonActivityComponent } from "../src/modes/interactive/components/ipython-activity.ts";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.ts";
import { formatAgentCompletion } from "../src/modes/interactive/components/tool-status-marker.ts";
import { highlightCode, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import type { IPythonActivity } from "../src/riemann/ipython.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("tool header roles", () => {
	beforeAll(() => initTheme("dark"));

	test.each(["start", "info", "wait", "steer", "stop", "release"])(
		"capitalizes %s and uses Cyan for the agent name",
		(operation) => {
			const header = new IPythonActivityComponent(
				{ id: "a", kind: "agent", operation, status: "ok", name: "reviewer" },
				false,
			).render(80)[0]!;
			const label = operation === "start" ? "Spawned" : operation[0]!.toUpperCase() + operation.slice(1);
			expect(stripAnsi(header)).toBe(` ● ${label} reviewer`);
			expect(header).toContain(theme.fg("toolTitle", label));
			expect(header).toContain("\x1b[38;5;6mreviewer\x1b[39m");
		},
	);

	test.each(["ok", "error", "cancelled"] as const)("uses the same roles for %s completion notices", (outcome) => {
		const label = { ok: "Completed", error: "Failed", cancelled: "Cancelled" }[outcome];
		const notice = formatAgentCompletion("reviewer", outcome);
		expect(stripAnsi(notice)).toContain(`${label} reviewer`);
		expect(notice).toContain(theme.bold(theme.fg("toolTitle", label)));
		expect(notice).toContain(
			theme.fg(
				outcome === "ok" ? "success" : outcome === "error" ? "toolStatusError" : "toolStatusWarning",
				outcome === "cancelled" ? "■" : "●",
			),
		);
		expect(notice).toContain("\x1b[38;5;6mreviewer\x1b[39m");
	});

	test.each([
		{ id: "m", kind: "mcp", operation: "ida.decompile", status: "ok" },
		{ id: "f", kind: "file", operation: "create", status: "ok", path: "src/main.ts" },
		{ id: "p", kind: "patch", operation: "edit", status: "ok", path: "src/main.ts" },
	] satisfies IPythonActivity[])("uses terminal foreground for $kind targets in both views", (activity) => {
		const target = activity.kind === "mcp" ? activity.operation : activity.path;
		for (const expanded of [false, true]) {
			const header = new IPythonActivityComponent(activity, expanded).render(80)[0]!;
			expect(header).toContain(
				activity.kind === "mcp" ? `\x1b[38;5;6m${target}\x1b[39m` : `\x1b[39m${target}\x1b[39m`,
			);
			for (const command of ["git status --short", 'echo "$HOME" && printf "%s" 42']) {
				const shell = new IPythonActivityComponent(
					{ id: "s", kind: "shell", operation: "run", status: "ok", command },
					expanded,
				)
					.render(100)
					.join("\n");
				const highlighted = highlightCode(command, "bash").join("\n");
				expect(shell).toContain(highlighted);
				if (command.startsWith("echo")) expect(highlighted).not.toBe(stripAnsi(highlighted));
			}
		}
	});

	test("capitalizes only first-level exploration actions and leaves grouped children alone", () => {
		const activities: IPythonActivity[] = (["read", "search", "list"] as const).map((operation) => ({
			id: operation,
			kind: "explore",
			operation,
			status: "ok",
			target: "src",
			query: "agentId",
		}));
		const cell = new IPythonCellComponent({ code: "", isPartial: false, activities });
		const grouped = cell.render(80).join("\n");
		expect(stripAnsi(grouped)).toContain("Explored");
		expect(grouped).toContain(theme.bold("\x1b[39mExplored\x1b[39m"));
		for (const activity of activities) {
			expect(stripAnsi(grouped)).toContain(activity.operation);
			for (const status of ["ok", "error"] as const) {
				const header = new IPythonActivityComponent({ ...activity, status }, true).render(80)[0]!;
				const verb = activity.operation[0]!.toUpperCase() + activity.operation.slice(1);
				expect(header).toContain(theme.fg("toolTitle", verb));
				expect(header).toContain("\x1b[39msrc\x1b[39m");
			}
		}
		expect(grouped).toContain("\x1b[39msrc\x1b[39m");
		expect(grouped).toContain(theme.fg("accent", "search"));
	});

	test("uses short missing-name fallbacks without losing the full ID in expanded details", () => {
		const agentId = "e1e5a33f50d341cab92ea9bb08c4e325";
		for (const name of [undefined, "", "   "]) {
			const activity = { id: "a", kind: "agent", operation: "wait", status: "ok", agentId, name } as const;
			const collapsed = new IPythonActivityComponent(activity, false).render(80);
			expect(stripAnsi(collapsed.join("\n"))).toContain("Wait Agent e1e5a33f");
			expect(collapsed.join("\n")).not.toContain(agentId);
			const expanded = new IPythonActivityComponent(activity, true).render(80);
			expect(expanded.slice(1).join("\n")).toContain(agentId);
			expect(
				new IPythonActivityComponent(activity, false).render(12).every((line) => visibleWidth(line) <= 12),
			).toBe(true);
		}
	});
	test("dims output without losing ANSI colors or turning RGB channels into resets", () => {
		const output = "first \x1b[31mred\x1b[0m after\x1b[1mbold\x1b[22m tail";
		const shell = new IPythonActivityComponent(
			{ id: "s", kind: "shell", operation: "run", status: "ok", command: "echo", stdout: output },
			false,
		)
			.render(120)
			.join("\n");
		expect(shell).toContain("\x1b[2m");
		expect(shell).toContain("\x1b[31mred");
		expect(shell).toContain("\x1b[0m\x1b[2m after");
		expect(shell).toContain("\x1b[22m\x1b[2m tail");
		const rgbOutput = "\x1b[38;2;0;22;0mRGB\x1b[39m plain";
		const rgb = new IPythonActivityComponent(
			{ id: "rgb", kind: "shell", operation: "run", status: "ok", command: "echo", stdout: rgbOutput },
			false,
		)
			.render(120)
			.join("\n");
		expect(rgb).toContain("\x1b[38;2;0;22;0mRGB");
	});

	test("renders agent tasks in muted gray and weakens MCP errors and metadata", () => {
		const agent = new IPythonActivityComponent(
			{
				id: "a",
				kind: "agent",
				operation: "start",
				status: "ok",
				name: "reviewer",
				task: "Review changes",
				profile: "review",
				durationMs: 1200,
			},
			false,
		).render(120);
		expect(agent[0]).toContain("\x1b[38;5;5mreview\x1b[39m");
		expect(agent[1]).toContain(theme.fg("muted", "Review changes"));
		const error = new IPythonActivityComponent(
			{ id: "m", kind: "mcp", operation: "ida.decompile", status: "error", error: "Not found" },
			false,
		).render(120);
		expect(error[0]).toContain("\x1b[38;5;1m●");
		expect(error[1]).toContain("\x1b[2m");
		expect(error[1]).not.toContain(theme.getFgAnsi("error"));
	});
	test.each(["dark", "light"])(
		"preserves green solid success markers in %s, including grouped exploration and deletion",
		(name) => {
			initTheme(name);
			try {
				const activities: IPythonActivity[] = [
					{ id: "r", kind: "explore", operation: "read", status: "ok", target: "src/main.ts" },
					{ id: "d", kind: "file", operation: "remove", status: "ok", path: "old.txt" },
					{ id: "p", kind: "patch", operation: "edit", status: "ok", path: "src/main.ts" },
					{ id: "s", kind: "shell", operation: "run", status: "ok", command: "git status --short" },
					{ id: "a", kind: "agent", operation: "start", status: "ok", name: "reviewer" },
					{ id: "m", kind: "mcp", operation: "ida.decompile", status: "ok" },
				];
				const prefix = ` ${theme.fg("success", "●")} `;
				for (const activity of activities) {
					for (const expanded of [false, true])
						expect(new IPythonActivityComponent(activity, expanded).render(100)[0]).toContain(prefix);
				}
				const grouped = new IPythonCellComponent({
					code: "",
					isPartial: false,
					activities: [activities[0]!],
				}).render(100)[0];
				expect(grouped).toContain(prefix);
				const mcpGroup = new IPythonCellComponent({
					code: "",
					isPartial: false,
					activities: [activities[5]!, { ...activities[5]!, id: "m2" }],
				}).render(100)[0];
				expect(mcpGroup).toContain(prefix);
				expect(formatAgentCompletion("reviewer", "ok")).toContain(theme.fg("success", "●"));
				expect(new IPythonCellComponent({ code: "pass", isPartial: false }).render(100)[0]).toContain(prefix);
			} finally {
				initTheme("dark");
			}
		},
	);
	test.each([
		["running", "Spawning"],
		["ok", "Spawned"],
		["error", "Spawn failed"],
	] as const)("renders %s agent creation as %s with gray prompts", (status, label) => {
		for (const expanded of [false, true]) {
			const created = new IPythonActivityComponent(
				{
					id: "a",
					kind: "agent",
					operation: "start",
					status,
					name: "reviewer",
					task: "Review changes",
					startedAt: 0,
				},
				expanded,
			).render(120);
			expect(stripAnsi(created[0])).toContain(`${label} reviewer`);
			expect(created[1]).toContain(theme.fg("muted", "Review changes"));
			const steered = new IPythonActivityComponent(
				{
					id: "s",
					kind: "agent",
					operation: "steer",
					status,
					name: "reviewer",
					message: "Focus on the preview",
					startedAt: 0,
				},
				expanded,
			).render(120);
			expect(steered[1]).toContain(theme.fg("muted", "Focus on the preview"));
		}
	});
});
