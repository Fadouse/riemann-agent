import type { Component } from "@earendil-works/pi-tui";
import type { IPythonActivity, IPythonExploreActivity, IPythonMcpActivity } from "../../../riemann/ipython.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { highlightCode, theme } from "../theme/theme.ts";
import { IPythonActivityComponent } from "./ipython-activity.ts";
import { keyText } from "./keybinding-hints.ts";
import {
	appendToolCode,
	appendToolOutput,
	appendToolResult,
	previewToolOutput,
	toolAction,
	toolDim,
	toolEntity,
	toolOutput,
	toolPath,
} from "./tool-display.ts";
import {
	type RunningToolHeader,
	refreshToolClocks,
	refreshToolMarkers,
	renderToolHeader,
	runningToolMarker,
} from "./tool-status-marker.ts";

export interface IPythonCellContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface IPythonCellState {
	code: string;
	wait?: boolean;
	content?: readonly IPythonCellContentBlock[];
	details?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	executionStarted?: boolean;
	startedAt?: number;
	argsComplete?: boolean;
	hidden?: boolean;
	interruptHint?: boolean;
	activities?: readonly IPythonActivity[];
}

interface IPythonDetails {
	startedAt?: number;
	status?: string;
	durationMs?: number;
	errorName?: string;
	cellId?: string;
	moreRef?: string;
}

function readDetails(value: unknown): IPythonDetails {
	if (!value || typeof value !== "object") return {};
	const record = value as Record<string, unknown>;
	return {
		status: typeof record.status === "string" ? record.status : undefined,
		startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
		durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
		errorName: typeof record.errorName === "string" ? record.errorName : undefined,
		cellId: typeof record.cellId === "string" ? record.cellId : undefined,
		moreRef: typeof record.moreRef === "string" ? record.moreRef : undefined,
	};
}

function visiblePythonOutput(text: string, details: IPythonDetails): string {
	if (
		details.cellId &&
		(text.startsWith(`Script running with cell ID ${details.cellId}`) || text.startsWith(`Cell ${details.cellId} `))
	) {
		const newline = text.indexOf("\n");
		text = newline === -1 ? "" : text.slice(newline + 1);
	}
	text = text
		.replace(/^Unknown or already collected Python cell: \S+$/m, "Python cell is unavailable or already collected.")
		.replace(
			/^Collect cell \S+ with ipython_wait before starting another cell$/m,
			"Collect the previous Python execution before starting another.",
		)
		.replace(/^Python cell \S+ already has an active wait$/m, "Python execution already has an active wait.");
	return details.moreRef ? text.replaceAll(`[more=${details.moreRef}]`, "") : text;
}

interface LineSummary {
	firstLine: string;
	nonEmptyLines: number;
	firstNonEmpty: number;
	lastNonEmpty: number;
	breaks: number;
}

function summarizeLines(text: string): LineSummary {
	const summary: LineSummary = { firstLine: "", nonEmptyLines: 0, firstNonEmpty: -1, lastNonEmpty: -1, breaks: 0 };
	let start = 0;
	while (true) {
		const newline = text.indexOf("\n", start);
		const line = text.slice(start, newline === -1 ? text.length : newline).trim();
		if (line) {
			if (summary.firstNonEmpty === -1) {
				summary.firstLine = line;
				summary.firstNonEmpty = summary.breaks;
			}
			summary.nonEmptyLines++;
			summary.lastNonEmpty = summary.breaks;
		}
		if (newline === -1) return summary;
		start = newline + 1;
		summary.breaks++;
	}
}

type StatusKind = "error" | "aborted" | "running" | "queued" | "yielded" | "done";

/** Safely extract the cell source while tool-call arguments are still streaming. */
export function getIPythonCodeFromArgs(args: unknown): string {
	if (!args || typeof args !== "object" || !("code" in args)) return "";
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : "";
}

/** Compact, backgroundless IPython transcript inspired by Prime Agent's cell renderer. */
export class IPythonCellComponent implements Component {
	private state: IPythonCellState;
	private activityComponents = new Map<string, IPythonActivityComponent>();
	private cachedWidth?: number;
	private animatedRows: number[] = [];
	private headerClocks: RunningToolHeader[] = [];
	private startedAt?: number;
	private endedAt?: number;
	private cachedRunningMarker = "";
	private cachedState?: IPythonCellState;
	private cachedThemeFg?: string;
	private cachedLines?: string[];
	private cachedTheme?: typeof theme;
	private cachedCodeSummary?: { text: string; firstLine: string; lines: number; sourceLines: number };
	private cachedOutputSummary?: { parts: string[]; lines: number };
	private compactOutputCache?: {
		parts: string[];
		width: number;
		errorName?: string;
		failed: boolean;
		theme: typeof theme;
		lines: string[];
	};

	constructor(state: IPythonCellState) {
		this.state = state;
		if (state.executionStarted) this.startedAt = state.startedAt ?? Date.now();
	}

	update(state: IPythonCellState): void {
		if (
			this.state.code === state.code &&
			this.state.wait === state.wait &&
			this.state.content === state.content &&
			this.state.details === state.details &&
			this.state.isPartial === state.isPartial &&
			this.state.isError === state.isError &&
			this.state.expanded === state.expanded &&
			this.state.executionStarted === state.executionStarted &&
			this.state.startedAt === state.startedAt &&
			this.state.argsComplete === state.argsComplete &&
			this.state.hidden === state.hidden &&
			this.state.interruptHint === state.interruptHint &&
			this.state.activities === state.activities
		) {
			return;
		}
		this.state = state;
		if (state.executionStarted) this.startedAt ??= state.startedAt ?? Date.now();
		this.cachedWidth = undefined;
		this.cachedState = undefined;
		this.cachedThemeFg = undefined;
		this.cachedLines = undefined;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedState = undefined;
		this.cachedThemeFg = undefined;
		this.cachedTheme = undefined;
		this.cachedLines = undefined;
		for (const component of this.activityComponents.values()) component.invalidate();
	}

	render(width: number): string[] {
		if (this.state.hidden) {
			this.activityComponents.clear();
			this.animatedRows = [];
			this.headerClocks = [];
			this.invalidate();
			this.cachedCodeSummary = undefined;
			this.cachedOutputSummary = undefined;
			this.compactOutputCache = undefined;
			return [];
		}
		const safeWidth = Math.max(1, width);
		const themeFg = theme.getFgAnsi("text");
		if (
			this.cachedLines &&
			this.cachedWidth === safeWidth &&
			this.cachedState === this.state &&
			this.cachedThemeFg === themeFg &&
			this.cachedTheme === theme
		) {
			if (this.animatedRows.length === 0) return this.cachedLines;
			const marker = runningToolMarker();
			this.cachedLines = refreshToolMarkers(this.cachedLines, this.animatedRows, this.cachedRunningMarker, marker);
			this.cachedLines = refreshToolClocks(this.cachedLines, this.headerClocks, marker, safeWidth);
			this.cachedRunningMarker = marker;
			return this.cachedLines;
		}
		const details = readDetails(this.state.details);
		const status = this.statusKind(details);
		const running = status === "running";
		const queued = status === "queued";
		const animated = running || queued;
		const now = Date.now();
		const startedAt = details.startedAt ?? this.state.startedAt ?? this.startedAt;
		if (!running && this.statusKind(details) !== "queued" && startedAt !== undefined)
			this.endedAt ??= details.durationMs === undefined ? now : startedAt + details.durationMs;
		const durationMs = running
			? now - (startedAt ?? now)
			: (details.durationMs ??
				(startedAt === undefined || this.endedAt === undefined ? undefined : this.endedAt - startedAt));
		const marker = animated ? runningToolMarker(now) : toolDim("•");
		this.cachedRunningMarker = marker;
		const failed = this.statusKind(details) === "error" || this.statusKind(details) === "aborted";
		const hasRunningActivity =
			this.state.activities?.some(
				(activity) =>
					activity.status === "running" && !(activity.kind === "agent" && activity.operation === "list"),
			) ?? false;
		// A completed host call does not mean the surrounding Python computation has ended.
		const showWrapper =
			this.state.expanded ||
			details.moreRef !== undefined ||
			status === "yielded" ||
			failed ||
			(this.state.activities?.length ?? 0) === 0 ||
			(running && !hasRunningActivity);
		this.animatedRows = animated && showWrapper ? [0] : [];
		this.headerClocks = [];
		const label = this.summaryLabel(details);
		const interruptKey =
			running && this.state.interruptHint !== false && this.state.executionStarted ? keyText("app.interrupt") : "";
		const sourceLines = queued ? this.codeSummary().sourceLines : undefined;
		const metadata =
			sourceLines !== undefined
				? `${sourceLines} ${sourceLines === 1 ? "line" : "lines"}`
				: interruptKey
					? `${interruptKey} to interrupt`
					: undefined;
		const styledMetadata = metadata ? toolDim(metadata) : undefined;
		const lines: string[] = showWrapper
			? [renderToolHeader(label, this.marker(details), safeWidth, durationMs, running, styledMetadata)]
			: [];
		if (running && showWrapper)
			this.headerClocks.push({
				row: 0,
				label,
				metadata: styledMetadata,
				startedAt: startedAt ?? now,
				seconds: Math.floor(Math.max(0, durationMs ?? 0) / 1_000),
			});
		if (this.state.expanded) {
			this.renderCode(lines, safeWidth);
			this.renderOutput(lines, safeWidth, details);
		} else if (showWrapper) this.renderCompactOutput(lines, safeWidth, details, failed);
		this.renderActivities(lines, safeWidth, running);
		const markerPrefix = ` ${marker.slice(0, -"\x1b[39m".length)}`;
		this.animatedRows = this.animatedRows.filter((row) => lines[row]?.startsWith(markerPrefix));
		this.headerClocks = this.headerClocks.filter((header) => this.animatedRows.includes(header.row));
		this.cachedWidth = safeWidth;
		this.cachedState = this.state;
		this.cachedThemeFg = themeFg;
		this.cachedTheme = theme;
		this.cachedLines = lines;
		return lines;
	}

	hasRunningAnimation(): boolean {
		return this.animatedRows.length > 0;
	}

	private summaryLabel(details: IPythonDetails): string {
		const parts = [toolAction(this.state.wait ? "Python wait" : "Python")];
		if (details.moreRef) parts.push(toolDim(`[more ${details.moreRef}]`));
		if (this.statusKind(details) === "yielded") {
			parts.push(toolDim("Yielded"));
			return parts.join(" ");
		}
		if (!this.state.expanded) {
			const status = this.statusKind(details);
			if (details.status === "timeout") parts.push(theme.fg("toolStatusError", "Timed out"));
			else if (status === "aborted") parts.push(theme.fg("toolStatusWarning", "Cancelled"));
			else if (status === "error") parts.push(theme.fg("toolStatusError", details.errorName ?? "Error"));
			return parts.join(" ");
		}
		const inputSummary = this.codeSummary();

		const counts = this.lineCounts(inputSummary.lines);
		if (counts) parts.push(toolDim(counts));
		if (details.errorName && !this.state.isPartial) parts.push(theme.fg("toolStatusError", details.errorName));
		else if (
			this.state.isPartial &&
			(this.state.activities?.some((activity) => activity.status === "running") ?? false)
		)
			parts.push(toolDim("working"));
		return parts.join(" ");
	}

	private statusKind(details: IPythonDetails): StatusKind {
		if (this.state.isError || details.status === "error" || details.status === "timeout") return "error";
		if (details.status === "aborted" || details.status === "cancelled") return "aborted";
		if (details.status === "running" && this.state.isPartial === false) return "yielded";
		if (
			this.state.isPartial === false ||
			(!this.state.isPartial && (details.status !== undefined || (this.state.content?.length ?? 0) > 0))
		)
			return "done";
		if (this.state.executionStarted) return "running";
		return "queued";
	}

	private marker(details: IPythonDetails): string {
		switch (this.statusKind(details)) {
			case "error":
				return theme.fg("toolStatusError", "•");
			case "aborted":
				return theme.fg("toolStatusWarning", "•");
			case "yielded":
				return toolDim("•");
			case "done":
				return theme.fg("success", "•");
			case "running":
			case "queued":
				return this.cachedRunningMarker;
		}
	}

	private codeSummary(): NonNullable<IPythonCellComponent["cachedCodeSummary"]> {
		if (this.cachedCodeSummary?.text !== this.state.code) {
			const summary = summarizeLines(this.state.code);
			this.cachedCodeSummary = {
				text: this.state.code,
				firstLine: summary.firstLine,
				lines: summary.nonEmptyLines,
				sourceLines: summary.breaks + (this.state.code.length > 0 && !this.state.code.endsWith("\n") ? 1 : 0),
			};
		}
		return this.cachedCodeSummary;
	}

	private lineCounts(input: number): string | undefined {
		const parts: string[] = [];
		const details = readDetails(this.state.details);
		this.state.content?.forEach((block) => {
			if (block.type === "text" && typeof block.text === "string")
				parts.push(visiblePythonOutput(block.text, details));
		});
		if (
			!this.cachedOutputSummary ||
			this.cachedOutputSummary.parts.length !== parts.length ||
			parts.some((text, index) => text !== this.cachedOutputSummary?.parts[index])
		) {
			let first = -1;
			let last = -1;
			let offset = 0;
			for (const text of parts) {
				const summary = summarizeLines(text);
				if (first === -1 && summary.firstNonEmpty !== -1) first = offset + summary.firstNonEmpty;
				if (summary.lastNonEmpty !== -1) last = offset + summary.lastNonEmpty;
				offset += summary.breaks + 1; // The separator inserted between text blocks.
			}
			this.cachedOutputSummary = { parts, lines: first === -1 ? 0 : last - first + 1 };
		}
		const output = this.cachedOutputSummary.lines;
		const segments: string[] = [];
		if (input > 0) segments.push(`↑ ${input}`);
		if (output > 0) segments.push(`↓ ${output}`);
		return segments.length > 0 ? `${segments.join(" ")} lines` : undefined;
	}

	private renderCompactOutput(lines: string[], width: number, details: IPythonDetails, failed: boolean): void {
		const parts: string[] = [];
		for (const block of this.state.content ?? []) {
			if (block?.type === "text" && typeof block.text === "string")
				parts.push(visiblePythonOutput(block.text, details));
		}
		const cached = this.compactOutputCache;
		if (
			!cached ||
			cached.width !== width ||
			cached.failed !== failed ||
			cached.theme !== theme ||
			cached.errorName !== details.errorName ||
			cached.parts.length !== parts.length ||
			parts.some((part, index) => part !== cached.parts[index])
		) {
			let output = parts.join("\n");
			// Python tracebacks end in the actual exception; show its reason, not stack frames.
			if (failed) output = stripAnsi(output);
			if (failed && details.errorName) {
				const index = output.lastIndexOf(`${details.errorName}:`);
				if (index >= 0) output = output.slice(index);
			}
			this.compactOutputCache = {
				parts,
				width,
				failed,
				errorName: details.errorName,
				theme,
				lines: previewToolOutput(output, width),
			};
		}
		appendToolResult(
			lines,
			this.compactOutputCache!.lines.map((line) => (failed ? theme.fg("toolStatusError", line) : toolOutput(line))),
			width,
		);
	}

	private renderActivities(lines: string[], width: number, running: boolean): void {
		const activities = this.state.activities ?? [];
		if (activities.length === 0) {
			this.activityComponents.clear();
			return;
		}
		const activeIds = new Set<string>();
		for (let index = 0; index < activities.length; index++) {
			const activity = activities[index]!;
			if (
				activity.kind === "agent" &&
				activity.operation === "list" &&
				activity.status !== "error" &&
				!activity.error
			)
				continue;
			// This assembler alone owns spacing between logical tool blocks.
			if (lines.length > 0 && stripAnsi(lines[lines.length - 1]!).trim()) lines.push("");
			if (!this.state.expanded && activity.kind === "explore" && activity.status !== "error") {
				const group = [activity];
				while (index + 1 < activities.length) {
					const next = activities[index + 1]!;
					if (next.kind !== "explore" || next.status === "error") break;
					group.push(next);
					index++;
				}
				this.renderExploration(lines, width, group, running);
				continue;
			}
			if (!this.state.expanded && activity.kind === "mcp" && activity.status !== "error") {
				const group = [activity];
				while (index + 1 < activities.length) {
					const next = activities[index + 1]!;
					if (next.kind !== "mcp" || next.status === "error" || next.operation !== activity.operation) break;
					group.push(next);
					index++;
				}
				if (group.length > 1) {
					this.renderMcpGroup(lines, width, group, running);
					continue;
				}
			}
			activeIds.add(activity.id);
			let component = this.activityComponents.get(activity.id);
			if (!component) {
				component = new IPythonActivityComponent(activity, this.state.expanded ?? false);
				this.activityComponents.set(activity.id, component);
			} else {
				component.update(activity, this.state.expanded ?? false);
			}
			if (running && activity.status === "running") this.animatedRows.push(lines.length);
			const row = lines.length;
			for (const line of component.render(width, this.cachedRunningMarker, running ? undefined : this.endedAt))
				lines.push(line);
			const header = component.getRunningHeader();
			if (running && header) this.headerClocks.push({ ...header, row: row + header.row });
		}
		for (const id of this.activityComponents.keys()) {
			if (!activeIds.has(id)) this.activityComponents.delete(id);
		}
	}

	private renderExploration(
		lines: string[],
		width: number,
		group: readonly IPythonExploreActivity[],
		running: boolean,
	): void {
		const active = group.some((activity) => activity.status === "running");
		if (active && running) this.animatedRows.push(lines.length);
		this.pushGroupHeader(lines, width, toolAction(active ? "Exploring" : "Explored"), group, active && running);
		const rows: string[] = [];
		for (let index = 0; index < group.length; ) {
			if (rows.length === 4) {
				rows.push(toolDim(`… ${group.length - index} more operations`));
				break;
			}
			const activity = group[index]!;
			let detail: string;
			let verb: string;
			if (activity.operation === "read") {
				verb = "read";
				const names: string[] = [];
				let count = 0;
				while (index < group.length && group[index]!.operation === "read") {
					if (names.length < 3) names.push(group[index]!.target);
					count++;
					index++;
				}
				detail = toolPath(
					`${names.join(", ")}${count > names.length ? `, … +${count - names.length} files` : ""}`.replace(
						/[\r\n\t]/g,
						" ",
					),
				);
			} else if (activity.operation === "list") {
				verb = "list";
				detail = toolPath(activity.target.replace(/[\r\n\t]/g, " "));
				index++;
			} else {
				verb = "search";
				detail = `${toolPath((activity.query ?? "").replace(/[\r\n\t]/g, " "))}${toolDim(" in ")}${toolPath(activity.target.replace(/[\r\n\t]/g, " "))}`;
				index++;
			}
			rows.push(`${theme.fg("toolSubAction", verb)} ${detail}`);
		}
		appendToolOutput(lines, rows.join("\n"), width, false, true);
	}

	private renderMcpGroup(
		lines: string[],
		width: number,
		group: readonly IPythonMcpActivity[],
		running: boolean,
	): void {
		const active = group.some((activity) => activity.status === "running");
		if (active && running) this.animatedRows.push(lines.length);
		this.pushGroupHeader(
			lines,
			width,
			`${toolAction(active ? "Calling" : "Called")} ${toolEntity(group[0]!.operation)}`,
			group,
			active && running,
			toolDim(`${group.length} calls`),
		);
		const latest = group[group.length - 1]!;
		if (latest.output) appendToolOutput(lines, toolOutput(latest.output), width);
	}

	private pushGroupHeader(
		lines: string[],
		width: number,
		text: string,
		group: readonly IPythonActivity[],
		running: boolean,
		metadata?: string,
	): void {
		let start = Infinity;
		let end = -Infinity;
		for (const activity of group) {
			if (activity.startedAt !== undefined) {
				start = Math.min(start, activity.startedAt);
				if (activity.durationMs !== undefined) end = Math.max(end, activity.startedAt + activity.durationMs);
			}
		}
		const now = Date.now();
		const startedAt = Number.isFinite(start) ? start : (this.startedAt ?? now);
		const durationMs = running
			? now - startedAt
			: Number.isFinite(start) && Number.isFinite(end)
				? end - start
				: undefined;
		const label = text;
		const row = lines.length;
		lines.push(
			renderToolHeader(
				label,
				running ? this.cachedRunningMarker : theme.fg("success", "•"),
				width,
				durationMs,
				running,
				metadata,
			),
		);
		if (running)
			this.headerClocks.push({
				row,
				label,
				metadata,
				startedAt,
				seconds: Math.floor(Math.max(0, durationMs ?? 0) / 1_000),
			});
	}

	private renderCode(lines: string[], width: number): void {
		if (!this.state.code) return;
		appendToolCode(lines, highlightCode(this.state.code, "python").join("\n"), width);
	}

	private renderOutput(lines: string[], width: number, details: IPythonDetails): void {
		const output = (this.state.content ?? [])
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => visiblePythonOutput(block.text ?? "", details))
			.join("\n");
		if (!output) return;
		const rendered = this.statusKind(details) === "error" ? theme.fg("toolStatusError", output) : toolOutput(output);
		appendToolOutput(lines, rendered, width, true);
	}
}
