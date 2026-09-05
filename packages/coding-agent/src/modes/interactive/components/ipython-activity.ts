import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
	IPythonActivity,
	IPythonAgentActivity,
	IPythonFileActivity,
	IPythonPatchActivity,
	IPythonShellActivity,
} from "../../../riemann/ipython.ts";
import { highlightCode, theme } from "../theme/theme.ts";
import { renderDiff } from "./diff.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const OUTPUT_PREVIEW_LINES = 12;
const TASK_PREVIEW_LINES = 3;

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1_000).toFixed(1)}s`;
}

function marker(activity: IPythonActivity): string {
	if (activity.status === "running") return theme.fg("bashMode", "◆");
	if (activity.status === "error") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function nonEmptyLines(text: string | undefined): string[] {
	return (text ?? "")
		.trimEnd()
		.split(/\r?\n/)
		.filter((line, index, values) => line.length > 0 || index < values.length - 1);
}

/** Rich OMP-style nested activity renderer for host functions called from an IPython cell. */
export class IPythonActivityComponent implements Component {
	private activity: IPythonActivity;
	private expanded: boolean;
	private cachedWidth?: number;
	private cachedActivity?: Readonly<Record<string, string | number | boolean | null | undefined>>;
	private cachedFieldCount = 0;
	private cachedExpanded?: boolean;
	private cachedThemeFg?: string;
	private cachedTheme?: typeof theme;
	private cachedLines?: string[];

	constructor(activity: IPythonActivity, expanded: boolean) {
		this.activity = activity;
		this.expanded = expanded;
	}

	update(activity: IPythonActivity, expanded: boolean): void {
		// Trackers may copy unchanged activities. Let render compare the scalar
		// snapshot rather than discarding cached output merely on identity change.
		this.activity = activity;
		this.expanded = expanded;
	}

	invalidate(): void {
		this.cachedThemeFg = undefined;
		this.cachedTheme = undefined;
		this.cachedWidth = undefined;
		this.cachedActivity = undefined;
		this.cachedExpanded = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		// Activity fields are scalar values (including potentially large output
		// strings). Snapshot the fields instead of serializing their contents.
		// Comparing values, not object identity, also detects in-place mutations.
		const activity = this.activity as IPythonActivity & Record<string, string | number | boolean | null | undefined>;
		let sameFields = this.cachedActivity !== undefined;
		let fieldCount = 0;
		for (const key in activity) {
			if (!Object.hasOwn(activity, key)) continue;
			fieldCount++;
			if (this.cachedActivity?.[key] !== activity[key]) sameFields = false;
		}
		const themeFg = theme.getFgAnsi("text");
		if (
			this.cachedLines &&
			this.cachedWidth === safeWidth &&
			this.cachedExpanded === this.expanded &&
			this.cachedThemeFg === themeFg &&
			this.cachedTheme === theme &&
			sameFields &&
			this.cachedFieldCount === fieldCount
		)
			return this.cachedLines;
		const lines: string[] = [];
		switch (this.activity.kind) {
			case "shell":
				this.renderShell(lines, safeWidth, this.activity);
				break;
			case "agent":
				this.renderAgent(lines, safeWidth, this.activity);
				break;
			case "file":
				this.renderFile(lines, safeWidth, this.activity);
				break;
			case "patch":
				this.renderPatch(lines, safeWidth, this.activity);
				break;
		}
		this.cachedWidth = safeWidth;
		this.cachedActivity = { ...this.activity };
		this.cachedFieldCount = fieldCount;
		this.cachedExpanded = this.expanded;
		this.cachedThemeFg = themeFg;
		this.cachedTheme = theme;
		this.cachedLines = lines;
		return lines;
	}

	private renderShell(lines: string[], width: number, activity: IPythonShellActivity): void {
		const commandLines = highlightCode(activity.command, "bash");
		const cwd = activity.cwd ? theme.fg("dim", `cd ${activity.cwd} && `) : "";
		for (const [index, line] of commandLines.entries()) {
			this.pushWrapped(
				lines,
				width,
				index === 0 ? `${marker(activity)} ${theme.fg("dim", "$ ")}${cwd}` : "    ",
				line,
			);
		}
		const output = [activity.stdout, activity.stderr].filter(Boolean).join("\n");
		const outputLines = nonEmptyLines(output);
		if (outputLines.length > 0) {
			if (this.expanded) {
				for (const line of outputLines) {
					this.pushWrapped(lines, width, "    ", theme.fg("toolOutput", replaceTabs(line)));
				}
			} else {
				const outputWidth = Math.max(1, width - 1 - visibleWidth("    "));
				const styledOutput = outputLines.map((line) => theme.fg("toolOutput", replaceTabs(line))).join("\n");
				const { visualLines, skippedCount } = truncateToVisualLines(
					styledOutput,
					OUTPUT_PREVIEW_LINES - 1,
					outputWidth,
				);
				if (skippedCount > 0) {
					lines.push(truncateToWidth(`     ${theme.fg("dim", `… ${skippedCount} earlier lines`)}`, width, ""));
				}
				for (const line of visualLines) lines.push(truncateToWidth(`     ${line}`, width, ""));
			}
		}
		const stats: string[] = [];
		if (activity.status === "running") stats.push("running");
		if (activity.exitCode !== undefined && activity.exitCode !== null) stats.push(`exit ${activity.exitCode}`);
		if (activity.timedOut) stats.push("timed out");
		const duration = formatDuration(activity.durationMs);
		if (duration) stats.push(duration);
		if (stats.length > 0) this.pushWrapped(lines, width, "    ", theme.fg("dim", stats.join(" · ")));
		if (activity.error && !activity.timedOut && activity.exitCode === undefined) {
			this.pushWrapped(lines, width, "    ", theme.fg("error", activity.error));
		}
	}

	private renderAgent(lines: string[], width: number, activity: IPythonAgentActivity): void {
		const name = activity.name ?? activity.agentId ?? "agents";
		const title = `${marker(activity)} ${theme.fg("accent", activity.operation)} ${theme.bold(name)}`;
		const metadata = [activity.agentStatus, activity.modelRole ?? activity.profile, activity.workspace]
			.filter((value): value is string => Boolean(value))
			.join(" · ");
		this.pushWrapped(lines, width, "", metadata ? `${title}${theme.fg("dim", ` · ${metadata}`)}` : title);
		const body = activity.task ?? activity.message;
		if (body) {
			const bodyLines = body.trim().split(/\r?\n/);
			const shown = this.expanded ? bodyLines : bodyLines.slice(0, TASK_PREVIEW_LINES);
			for (const line of shown) this.pushWrapped(lines, width, "    ", theme.fg("toolOutput", replaceTabs(line)));
			if (!this.expanded && bodyLines.length > shown.length) {
				this.pushWrapped(lines, width, "    ", theme.fg("dim", `… ${bodyLines.length - shown.length} more lines`));
			}
		}
		if (activity.error) this.pushWrapped(lines, width, "    ", theme.fg("error", activity.error));
	}

	private renderFile(lines: string[], width: number, activity: IPythonFileActivity): void {
		const stats = this.changeStats(activity);
		this.pushWrapped(
			lines,
			width,
			"",
			`${marker(activity)} ${theme.fg("accent", activity.operation)} ${theme.bold(activity.path)}${stats}`,
		);
		if (activity.diff && this.expanded) this.renderDiffLines(lines, width, activity.diff);
		if (activity.error) this.pushWrapped(lines, width, "    ", theme.fg("error", activity.error));
	}

	private renderPatch(lines: string[], width: number, activity: IPythonPatchActivity): void {
		const stats = this.changeStats(activity);
		this.pushWrapped(
			lines,
			width,
			"",
			`${marker(activity)} ${theme.fg("accent", "patch")} ${theme.bold(activity.path)}${stats}`,
		);
		if (activity.diff) {
			const diffLines = activity.diff.split("\n");
			const shown = this.expanded ? diffLines : diffLines.slice(0, OUTPUT_PREVIEW_LINES);
			this.renderDiffLines(lines, width, shown.join("\n"));
			if (!this.expanded && diffLines.length > shown.length) {
				this.pushWrapped(
					lines,
					width,
					"    ",
					theme.fg("dim", `… ${diffLines.length - shown.length} more diff lines`),
				);
			}
		}
		if (activity.error) this.pushWrapped(lines, width, "    ", theme.fg("error", activity.error));
	}

	private changeStats(activity: IPythonFileActivity | IPythonPatchActivity): string {
		const stats: string[] = [];
		if (activity.additions) stats.push(theme.fg("toolDiffAdded", `+${activity.additions}`));
		if (activity.removals) stats.push(theme.fg("toolDiffRemoved", `-${activity.removals}`));
		if (activity.status === "running") stats.push(theme.fg("dim", "running"));
		if (activity.diffTruncated) stats.push(theme.fg("dim", "diff truncated"));
		const duration = formatDuration(activity.durationMs);
		if (duration) stats.push(theme.fg("dim", duration));
		return stats.length > 0 ? theme.fg("dim", " · ") + stats.join(theme.fg("dim", " ")) : "";
	}

	private renderDiffLines(lines: string[], width: number, diff: string): void {
		for (const line of renderDiff(diff).split("\n")) this.pushWrapped(lines, width, "    ", line);
	}

	private pushWrapped(lines: string[], width: number, prefix: string, text: string): void {
		const available = Math.max(1, width - 1 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			lines.push(truncateToWidth(` ${linePrefix}${line}`, width, ""));
		}
	}
}
