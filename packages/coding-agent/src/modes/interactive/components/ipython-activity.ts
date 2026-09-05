import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
	IPythonActivity,
	IPythonAgentActivity,
	IPythonExploreActivity,
	IPythonFileActivity,
	IPythonMcpActivity,
	IPythonPatchActivity,
	IPythonShellActivity,
} from "../../../riemann/ipython.ts";
import { highlightCode, theme } from "../theme/theme.ts";
import { renderDiff } from "./diff.ts";
import { refreshToolMarkers, runningToolMarker } from "./tool-status-marker.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const OUTPUT_PREVIEW_LINES = 4;
const TASK_PREVIEW_LINES = 3;

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1_000).toFixed(1)}s`;
}

function marker(activity: IPythonActivity, runningMarker: string): string {
	if (activity.status === "running") return runningMarker;
	if (activity.status === "error") return theme.fg("error", "●");
	return theme.fg("success", "●");
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/** Rich OMP-style nested activity renderer for host functions called from an IPython cell. */
export class IPythonActivityComponent implements Component {
	private activity: IPythonActivity;
	private expanded: boolean;
	private cachedWidth?: number;
	private runningMarker = "";
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

	render(width: number, markerFrame?: string): string[] {
		const marker = this.activity.status === "running" ? (markerFrame ?? runningToolMarker()) : "";
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
		) {
			this.cachedLines = refreshToolMarkers(this.cachedLines, [0], this.runningMarker, marker);
			this.runningMarker = marker;
			return this.cachedLines;
		}
		this.runningMarker = marker;
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
			case "explore":
				this.renderExplore(lines, safeWidth, this.activity);
				break;
			case "mcp":
				this.renderMcp(lines, safeWidth, this.activity);
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
		if (this.expanded) {
			const commandLines = highlightCode(activity.command, "bash");
			const cwd = activity.cwd ? theme.fg("dim", `cd ${activity.cwd} && `) : "";
			for (const [index, line] of commandLines.entries()) {
				this.pushWrapped(
					lines,
					width,
					index === 0 ? `${marker(activity, this.runningMarker)} ${theme.fg("dim", "$ ")}${cwd}` : "    ",
					line,
				);
			}
		} else {
			const newline = activity.command.search(/[\r\n]/);
			const firstLine = replaceTabs(newline < 0 ? activity.command : activity.command.slice(0, newline));
			const suffix = newline < 0 ? "" : theme.fg("dim", " … [multiline]");
			const title = `${marker(activity, this.runningMarker)} ${activity.status === "running" ? "Running" : "Ran"} `;
			const available = Math.max(1, width - 1 - visibleWidth(suffix));
			const command = truncateToWidth(firstLine, Math.max(1, available - visibleWidth(title)), "…");
			const highlighted = highlightCode(command, "bash")[0] ?? command;
			lines.push(
				truncateToWidth(` ${truncateToWidth(`${title}${highlighted}`, available, "…")}${suffix}`, width, ""),
			);
		}
		const output = [activity.stdout, activity.stderr].filter(Boolean).join("\n").trimEnd();
		if (output) {
			if (this.expanded) {
				for (const line of output.split(/\r?\n/)) {
					this.pushWrapped(lines, width, "    ", theme.fg("toolOutput", replaceTabs(line)));
				}
			} else {
				this.pushPreview(lines, width, theme.fg("toolOutput", replaceTabs(output)));
			}
		}
		const failed =
			activity.status === "error" ||
			activity.timedOut ||
			Boolean(activity.error) ||
			(activity.exitCode !== undefined && activity.exitCode !== null && activity.exitCode !== 0);
		if (this.expanded || failed) {
			const stats: string[] = [];
			if (activity.status === "running") stats.push("running");
			if (failed) stats.push("failed");
			if (activity.exitCode !== undefined && activity.exitCode !== null) stats.push(`exit ${activity.exitCode}`);
			if (activity.timedOut) stats.push("timed out");
			const duration = formatDuration(activity.durationMs);
			if (duration) stats.push(duration);
			if (stats.length > 0)
				this.pushWrapped(lines, width, "    ", theme.fg(failed ? "error" : "dim", stats.join(" · ")));
		}
		if (activity.error) this.pushWrapped(lines, width, "    ", theme.fg("error", activity.error));
	}

	private renderExplore(lines: string[], width: number, activity: IPythonExploreActivity): void {
		const verb =
			activity.status === "error"
				? `${activity.operation} failed`
				: activity.status === "running"
					? { read: "Reading", list: "Listing", search: "Searching" }[activity.operation]
					: { read: "Read", list: "Listed", search: "Searched" }[activity.operation];
		const query = activity.query !== undefined ? theme.fg("dim", ` · ${activity.query}`) : "";
		this.pushWrapped(
			lines,
			width,
			"",
			`${marker(activity, this.runningMarker)} ${theme.fg("accent", verb)} ${theme.bold(activity.target)}${query}`,
		);
		if (activity.error) this.pushWrapped(lines, width, "    ", theme.fg("error", activity.error));
		if (this.expanded) {
			const duration = formatDuration(activity.durationMs);
			if (duration) this.pushWrapped(lines, width, "    ", theme.fg("dim", duration));
		}
	}

	private renderMcp(lines: string[], width: number, activity: IPythonMcpActivity): void {
		const verb = activity.status === "running" ? "Calling" : "Called";
		this.pushWrapped(
			lines,
			width,
			"",
			`${marker(activity, this.runningMarker)} ${theme.fg("accent", verb)} ${theme.bold(activity.operation)}`,
		);
		if (this.expanded && activity.input !== undefined) {
			this.pushWrapped(lines, width, "    ", theme.fg("dim", "Input:"));
			for (const line of activity.input.split(/\r?\n/))
				this.pushWrapped(lines, width, "    ", theme.fg("toolOutput", replaceTabs(line)));
		}
		if (activity.output !== undefined) {
			if (this.expanded) {
				this.pushWrapped(lines, width, "    ", theme.fg("dim", "Output:"));
				for (const line of activity.output.split(/\r?\n/))
					this.pushWrapped(lines, width, "    ", theme.fg("toolOutput", replaceTabs(line)));
			} else this.pushPreview(lines, width, theme.fg("toolOutput", replaceTabs(activity.output)));
		}
		if (activity.error || activity.status === "error") {
			this.pushWrapped(lines, width, "    ", theme.fg("error", `Error: ${activity.error ?? "MCP call failed"}`));
		}
		if (this.expanded) {
			const duration = formatDuration(activity.durationMs);
			if (duration) this.pushWrapped(lines, width, "    ", theme.fg("dim", duration));
		}
	}

	private renderAgent(lines: string[], width: number, activity: IPythonAgentActivity): void {
		const name = activity.name ?? activity.agentId ?? "agents";
		const title = `${marker(activity, this.runningMarker)} ${theme.fg("accent", activity.operation)} ${theme.bold(name)}`;
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
		const verb =
			activity.status === "error"
				? { create: "Add failed", remove: "Delete failed", materialize: "Materialize failed" }[activity.operation]
				: activity.status === "running"
					? { create: "Adding", remove: "Deleting", materialize: "Materializing" }[activity.operation]
					: { create: "Added", remove: "Deleted", materialize: "Materialized" }[activity.operation];
		this.pushWrapped(
			lines,
			width,
			"",
			`${marker(activity, this.runningMarker)} ${theme.fg("accent", verb)} ${theme.bold(activity.path)}${stats}`,
		);
		if (activity.diff) this.renderDiffLines(lines, width, activity.diff);
		if (activity.error) this.pushWrapped(lines, width, "    ", theme.fg("error", activity.error));
	}

	private renderPatch(lines: string[], width: number, activity: IPythonPatchActivity): void {
		const stats = this.changeStats(activity);
		const verb = activity.status === "error" ? "Edit failed" : activity.status === "running" ? "Editing" : "Edited";
		this.pushWrapped(
			lines,
			width,
			"",
			`${marker(activity, this.runningMarker)} ${theme.fg("accent", verb)} ${theme.bold(activity.path)}${stats}`,
		);
		if (activity.diff) this.renderDiffLines(lines, width, activity.diff);
		if (activity.error) this.pushWrapped(lines, width, "    ", theme.fg("error", activity.error));
	}

	private changeStats(activity: IPythonFileActivity | IPythonPatchActivity): string {
		const stats: string[] = [];
		if (activity.additions) stats.push(theme.fg("toolDiffAdded", `+${activity.additions}`));
		if (activity.removals) stats.push(theme.fg("toolDiffRemoved", `-${activity.removals}`));
		if (activity.diffTruncated) stats.push(theme.fg("dim", "diff truncated"));
		if (this.expanded) {
			if (activity.status === "running") stats.push(theme.fg("dim", "running"));
			const duration = formatDuration(activity.durationMs);
			if (duration) stats.push(theme.fg("dim", duration));
		}
		return stats.length > 0 ? theme.fg("dim", " · ") + stats.join(theme.fg("dim", " ")) : "";
	}

	private renderDiffLines(lines: string[], width: number, diff: string): void {
		const rendered = renderDiff(diff);
		if (this.expanded) {
			for (const line of rendered.split("\n")) this.pushWrapped(lines, width, "    ", line);
		} else this.pushPreview(lines, width, rendered);
	}

	private pushPreview(lines: string[], width: number, text: string): void {
		const outputWidth = Math.max(1, width - 5);
		const { visualLines, skippedCount } = truncateToVisualLines(text, OUTPUT_PREVIEW_LINES, outputWidth, 0, 2);
		for (const [index, line] of visualLines.entries()) {
			if (index === 2 && skippedCount > 0) {
				lines.push(truncateToWidth(`     ${theme.fg("dim", `… ${skippedCount} lines omitted`)}`, width, "…"));
			}
			lines.push(truncateToWidth(`     ${line}`, width, ""));
		}
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
