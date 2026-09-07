import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type {
	IPythonActivity,
	IPythonAgentActivity,
	IPythonExploreActivity,
	IPythonFileActivity,
	IPythonMcpActivity,
	IPythonPatchActivity,
	IPythonShellActivity,
} from "../../../riemann/ipython.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { highlightCode, theme } from "../theme/theme.ts";
import { renderDiff } from "./diff.ts";
import { appendToolCode, appendToolOutput, toolAction, toolPath, toolTarget } from "./tool-display.ts";
import {
	formatAgentCompletion,
	type RunningToolHeader,
	refreshToolClocks,
	refreshToolMarkers,
	renderToolHeader,
	runningToolMarker,
} from "./tool-status-marker.ts";

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
	private clockNow = 0;
	private fallbackStartedAt: number;
	private activityId: string;
	private runningHeader: RunningToolHeader | undefined;
	private cachedActivity?: Readonly<Record<string, string | number | boolean | null | undefined>>;
	private cachedFieldCount = 0;
	private cachedExpanded?: boolean;
	private cachedThemeFg?: string;
	private cachedTheme?: typeof theme;
	private cachedLines?: string[];

	constructor(activity: IPythonActivity, expanded: boolean) {
		this.activity = activity;
		this.expanded = expanded;
		this.fallbackStartedAt = Date.now();
		this.activityId = activity.id;
	}

	getRunningHeader(): RunningToolHeader | undefined {
		return this.runningHeader;
	}

	update(activity: IPythonActivity, expanded: boolean): void {
		// Trackers may copy unchanged activities. Let render compare the scalar
		// snapshot rather than discarding cached output merely on identity change.
		if (this.activityId !== activity.id) {
			this.activityId = activity.id;
			this.fallbackStartedAt = Date.now();
			this.runningHeader = undefined;
		}
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
		this.runningHeader = undefined;
	}

	render(width: number, markerFrame?: string, endedAt?: number): string[] {
		const now = endedAt ?? Date.now();
		this.clockNow = now;
		const marker = this.activity.status === "running" ? (markerFrame ?? runningToolMarker(now)) : "";
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
			if (this.runningHeader)
				this.cachedLines = refreshToolClocks(this.cachedLines, [this.runningHeader], marker, safeWidth, now);
			this.runningMarker = marker;
			return this.cachedLines;
		}
		this.runningMarker = marker;
		this.runningHeader = undefined;
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

	private pushHeader(
		lines: string[],
		width: number,
		activity: IPythonActivity,
		label: string,
		metadata?: string,
	): void {
		const running = activity.status === "running";
		const startedAt = activity.startedAt ?? this.fallbackStartedAt;
		const durationMs = running ? Math.max(0, this.clockNow - startedAt) : activity.durationMs;
		const styledLabel = label.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
		metadata = metadata?.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
		if (running) {
			this.runningHeader = {
				row: 0,
				label: styledLabel,
				startedAt,
				seconds: Math.floor((durationMs ?? 0) / 1_000),
				...(metadata ? { metadata } : {}),
			};
		}
		lines.push(
			renderToolHeader(styledLabel, marker(activity, this.runningMarker), width, durationMs, running, metadata),
		);
	}

	private renderShell(lines: string[], width: number, activity: IPythonShellActivity): void {
		const newline = activity.command.search(/[\r\n]/);
		const firstLine = replaceTabs(newline < 0 ? activity.command : activity.command.slice(0, newline));
		const multiline = newline < 0 ? "" : theme.fg("dim", " [multiline]");
		const command = truncateToWidth(firstLine, Math.max(1, width), "…");
		const highlighted = highlightCode(command, "bash")[0] ?? command;
		const action = toolAction(activity.status === "running" ? "Running" : "Ran");
		this.pushHeader(lines, width, activity, this.expanded ? action : `${action}${multiline} ${highlighted}`);
		if (this.expanded) {
			const cwd = activity.cwd ? theme.fg("dim", `cd ${activity.cwd} && `) : "";
			appendToolCode(lines, cwd + highlightCode(activity.command, "bash").join("\n"), width);
		}
		// stdout may already end with a newline. Never insert a second separator.
		let output = activity.stdout ?? "";
		if (activity.stderr) {
			const needsNewline =
				output && !/[\r\n]$/.test(stripAnsi(output)) && !/^[\r\n]/.test(stripAnsi(activity.stderr));
			output += `${needsNewline ? "\n" : ""}${activity.stderr}`;
		}
		const failed =
			activity.status === "error" ||
			activity.timedOut ||
			Boolean(activity.error) ||
			(activity.exitCode !== undefined && activity.exitCode !== null && activity.exitCode !== 0);
		const parts: string[] = [];
		if (failed) {
			const reason =
				activity.error ??
				(activity.timedOut
					? "Timed out"
					: activity.exitCode !== undefined && activity.exitCode !== null
						? `Exit ${activity.exitCode}`
						: "Command failed");
			parts.push(theme.fg("error", reason));
		}
		if (output) parts.push(theme.fg("toolOutput", replaceTabs(output)));
		for (const stream of ["stdout", "stderr"] as const) {
			const captured = activity[`${stream}CaptureTruncated`];
			if (!captured && !activity[`${stream}Truncated`]) continue;
			const handle = activity[`${stream}ArtifactHandle`];
			parts.push(
				theme.fg(
					"dim",
					`[${stream} ${captured ? "capture incomplete" : "preview omitted"}${this.expanded && handle ? `; ${handle}` : ""}]`,
				),
			);
		}
		if (this.expanded && !failed && activity.exitCode !== undefined && activity.exitCode !== null) {
			if (parts.length > 0 && /[\r\n]$/.test(stripAnsi(parts[parts.length - 1]!))) {
				parts[parts.length - 1] += theme.fg("dim", `exit ${activity.exitCode}`);
			} else parts.push(theme.fg("dim", `exit ${activity.exitCode}`));
		}
		appendToolOutput(lines, parts.join("\n"), width, this.expanded);
	}

	private renderExplore(lines: string[], width: number, activity: IPythonExploreActivity): void {
		const path = activity.target.replace(/[\r\n\t]/g, " ");
		const detail =
			activity.operation === "search" && activity.query
				? `${toolPath(activity.query.replace(/[\r\n\t]/g, " "))} in ${toolPath(path)}`
				: toolPath(path);
		this.pushHeader(lines, width, activity, `${activity.operation} ${detail}`);
		if (activity.error) appendToolOutput(lines, theme.fg("error", activity.error), width, this.expanded);
	}

	private renderMcp(lines: string[], width: number, activity: IPythonMcpActivity): void {
		const verb = activity.status === "running" ? "Calling" : "Called";
		this.pushHeader(lines, width, activity, `${toolAction(verb)} ${toolTarget(activity.operation)}`);
		if (this.expanded && activity.input !== undefined) {
			appendToolCode(lines, theme.fg("dim", `Input:\n${replaceTabs(activity.input)}`), width);
		}
		const parts: string[] = [];
		if (activity.error || activity.status === "error")
			parts.push(theme.fg("error", `Error: ${activity.error ?? "MCP call failed"}`));
		if (activity.output !== undefined) parts.push(theme.fg("toolOutput", replaceTabs(activity.output)));
		appendToolOutput(lines, parts.join("\n"), width, this.expanded);
	}

	private renderAgent(lines: string[], width: number, activity: IPythonAgentActivity): void {
		if (activity.operation === "list" && activity.status !== "error" && !activity.error) return;
		const name = activity.name ?? activity.agentId ?? "agents";
		const outcome = activity.agentOutcome;
		if (
			activity.operation === "wait" &&
			activity.status !== "running" &&
			outcome &&
			!(outcome === "ok" && (activity.status === "error" || activity.error))
		) {
			lines.push(truncateToWidth(` ${formatAgentCompletion(name, outcome)}`, width, "…"));
		} else {
			const metadata = [activity.modelRole ?? activity.profile, activity.workspace]
				.filter((value): value is string => Boolean(value))
				.join(", ");
			const operation = activity.status === "error" ? `${activity.operation} failed` : activity.operation;
			this.pushHeader(lines, width, activity, `${toolAction(operation)} ${toolTarget(name)}`, metadata || undefined);
		}
		const parts: string[] = [];
		if (activity.error) parts.push(theme.fg("error", activity.error));
		const body = activity.task ?? activity.message;
		if (body) parts.push(theme.fg("toolOutput", body));
		appendToolOutput(lines, parts.join("\n"), width, this.expanded);
	}

	private renderFile(lines: string[], width: number, activity: IPythonFileActivity): void {
		const verb =
			activity.status === "error"
				? { create: "Add failed", remove: "Delete failed", materialize: "Materialize failed" }[activity.operation]
				: activity.status === "running"
					? { create: "Adding", remove: "Deleting", materialize: "Materializing" }[activity.operation]
					: { create: "Added", remove: "Deleted", materialize: "Materialized" }[activity.operation];
		this.pushHeader(
			lines,
			width,
			activity,
			`${toolAction(verb)} ${toolPath(activity.path)}`,
			this.changeStats(activity),
		);
		this.renderFileResult(lines, width, activity);
	}

	private renderPatch(lines: string[], width: number, activity: IPythonPatchActivity): void {
		const verb = activity.status === "error" ? "Edit failed" : activity.status === "running" ? "Editing" : "Edited";
		this.pushHeader(
			lines,
			width,
			activity,
			`${toolAction(verb)} ${toolPath(activity.path)}`,
			this.changeStats(activity),
		);
		this.renderFileResult(lines, width, activity);
	}

	private changeStats(activity: IPythonFileActivity | IPythonPatchActivity): string | undefined {
		const stats: string[] = [];
		if (activity.additions) stats.push(theme.fg("toolDiffAdded", `+${activity.additions}`));
		if (activity.removals) stats.push(theme.fg("toolDiffRemoved", `-${activity.removals}`));
		if (activity.diffTruncated) stats.push("diff truncated");
		return stats.length > 0 ? stats.join(" ") : undefined;
	}

	private renderFileResult(
		lines: string[],
		width: number,
		activity: IPythonFileActivity | IPythonPatchActivity,
	): void {
		const parts: string[] = [];
		if (activity.error) parts.push(theme.fg("error", activity.error));
		if (activity.diff) {
			let diff = activity.diff;
			if (!this.expanded) {
				const rows = diff.split("\n");
				const firstChange = rows.findIndex((row) => /^[+-]\s*\d/.test(row));
				const start = Math.max(0, firstChange - 1);
				if (start > 0) parts.push(theme.fg("dim", `… ${start} context lines omitted`));
				diff = rows.slice(start).join("\n");
			}
			parts.push(renderDiff(diff));
		}
		// Keep the first changed region together instead of splicing unrelated diff tails.
		appendToolOutput(lines, parts.join("\n"), width, this.expanded, true);
	}
}
