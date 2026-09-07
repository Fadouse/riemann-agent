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
import { previewIPythonDiff } from "./ipython-diff-preview.ts";
import {
	appendToolCode,
	appendToolOutput,
	appendToolResult,
	TOOL_BODY_COLUMNS,
	TOOL_PREVIEW_ROWS,
	toolAction,
	toolAgentName,
	toolDim,
	toolEntity,
	toolOutput,
	toolTarget,
} from "./tool-display.ts";
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
	if (activity.status === "ok") return theme.fg("success", "•");
	if (activity.kind !== "shell" && activity.kind !== "mcp") return toolDim(toolTarget("•"));
	return theme.fg("toolStatusError", "•");
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
		const action = toolAction(activity.status === "running" ? "Running" : "Ran");
		this.pushHeader(lines, width, activity, action);
		// Parse the complete script before wrapping: clipping first loses quote,
		// substitution, and here-document context and can change highlighting.
		const highlighted = highlightCode(activity.command, "bash").join("\n");
		const cwd = this.expanded && activity.cwd ? toolDim(`cd ${activity.cwd} && `) : "";
		appendToolCode(lines, replaceTabs(cwd + highlighted), width, this.expanded);
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
			parts.push(theme.fg("toolStatusError", reason));
		}
		if (output) parts.push(toolOutput(replaceTabs(output)));
		for (const stream of ["stdout", "stderr"] as const) {
			const captured = activity[`${stream}CaptureTruncated`];
			if (!captured && !activity[`${stream}Truncated`]) continue;
			const handle = activity[`${stream}ArtifactHandle`];
			parts.push(
				toolDim(
					`[${stream} ${captured ? "capture incomplete" : "preview omitted"}${this.expanded && handle ? `; ${handle}` : ""}]`,
				),
			);
		}
		if (activity.status === "ok" && !failed && !parts.some((part) => stripAnsi(part).trim())) {
			parts.push(toolDim("(no output)"));
		}
		if (this.expanded && !failed && activity.exitCode !== undefined && activity.exitCode !== null) {
			if (parts.length > 0 && /[\r\n]$/.test(stripAnsi(parts[parts.length - 1]!))) {
				parts[parts.length - 1] += toolDim(`exit ${activity.exitCode}`);
			} else parts.push(toolDim(`exit ${activity.exitCode}`));
		}
		appendToolOutput(lines, parts.join("\n"), width, this.expanded);
	}

	private renderExplore(lines: string[], width: number, activity: IPythonExploreActivity): void {
		const path = activity.target.replace(/[\r\n\t]/g, " ");
		const detail =
			activity.operation === "search" && activity.query
				? `${toolTarget(activity.query.replace(/[\r\n\t]/g, " "))} in ${toolTarget(path)}`
				: toolTarget(path);
		this.pushHeader(lines, width, activity, `${toolAction(activity.operation)} ${detail}`);
		if (activity.error) appendToolOutput(lines, theme.fg("toolStatusError", activity.error), width, this.expanded);
	}

	private renderMcp(lines: string[], width: number, activity: IPythonMcpActivity): void {
		const verb = activity.status === "running" ? "Calling" : "Called";
		this.pushHeader(lines, width, activity, `${toolAction(verb)} ${toolEntity(activity.operation)}`);
		if (this.expanded && activity.input !== undefined) {
			appendToolCode(lines, toolDim(`Input:\n${replaceTabs(activity.input)}`), width);
		}
		const parts: string[] = [];
		if (activity.error || activity.status === "error")
			parts.push(toolOutput(`Error: ${activity.error ?? "MCP call failed"}`));
		if (activity.output !== undefined) parts.push(toolOutput(replaceTabs(activity.output)));
		appendToolOutput(lines, parts.join("\n"), width, this.expanded);
	}

	private renderAgent(lines: string[], width: number, activity: IPythonAgentActivity): void {
		if (activity.operation === "list" && activity.status !== "error" && !activity.error) return;
		const name = activity.name?.trim() || (activity.agentId ? `Agent ${activity.agentId.slice(0, 8)}` : "agents");
		const outcome = activity.agentOutcome;
		if (
			activity.operation === "wait" &&
			activity.status !== "running" &&
			outcome &&
			!(outcome === "ok" && (activity.status === "error" || activity.error))
		) {
			lines.push(truncateToWidth(` ${formatAgentCompletion(name, outcome)}`, width, "…"));
		} else {
			const modelRole = activity.modelRole ?? activity.profile;
			const metadata = [
				modelRole ? theme.fg("toolMetadata", modelRole) : undefined,
				activity.workspace ? toolDim(activity.workspace) : undefined,
			]
				.filter((value): value is string => Boolean(value))
				.join(toolDim(", "));
			const operation =
				activity.operation === "start"
					? activity.status === "running"
						? "Spawning"
						: activity.status === "error"
							? "Spawn failed"
							: "Spawned"
					: activity.status === "error"
						? `${activity.operation} failed`
						: activity.operation;
			this.pushHeader(
				lines,
				width,
				activity,
				`${toolAction(operation)} ${toolAgentName(name)}`,
				metadata || undefined,
			);
		}
		const parts: string[] = [];
		if (activity.error) parts.push(theme.fg("toolStatusError", activity.error));
		if (this.expanded && activity.agentId) parts.push(toolDim(`ID: ${activity.agentId}`));
		const body = activity.task ?? activity.message;
		if (body) parts.push(theme.fg("muted", body));
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
			`${activity.status === "error" ? theme.bold(theme.fg("toolMetadata", verb)) : toolAction(verb)} ${toolTarget(activity.path)}`,
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
			`${activity.status === "error" ? theme.bold(theme.fg("toolMetadata", verb)) : toolAction(verb)} ${toolTarget(activity.path)}`,
			this.changeStats(activity),
		);
		this.renderFileResult(lines, width, activity);
	}

	private changeStats(activity: IPythonFileActivity | IPythonPatchActivity): string | undefined {
		const stats: string[] = [];
		if (activity.additions) stats.push(theme.fg("toolDiffAdded", `+${activity.additions}`));
		if (activity.removals) stats.push(theme.fg("toolDiffRemoved", `-${activity.removals}`));
		if (activity.diffTruncated) stats.push(toolDim("diff truncated"));
		return stats.length > 0 ? stats.join(" ") : undefined;
	}

	private renderFileResult(
		lines: string[],
		width: number,
		activity: IPythonFileActivity | IPythonPatchActivity,
	): void {
		const parts: string[] = [];
		if (!this.expanded && activity.diff) {
			const bodyWidth = Math.max(1, width - TOOL_BODY_COLUMNS);
			if (activity.error)
				parts.push(
					truncateToWidth(theme.fg("toolStatusError", activity.error.replace(/[\r\n]/g, " ")), bodyWidth, "…"),
				);
			parts.push(...previewIPythonDiff(activity.diff, activity.path, bodyWidth, TOOL_PREVIEW_ROWS - parts.length));
			appendToolResult(lines, parts, width);
			return;
		}
		if (activity.error) parts.push(theme.fg("toolStatusError", activity.error));
		if (activity.diff) {
			parts.push(
				renderDiff(activity.diff, { filePath: activity.path, width: Math.max(1, width - TOOL_BODY_COLUMNS) }),
			);
		}
		appendToolOutput(lines, parts.join("\n"), width, this.expanded, true);
	}
}
