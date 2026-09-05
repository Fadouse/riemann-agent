import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { IPythonActivity } from "../../../riemann/ipython.ts";
import { highlightCode, theme } from "../theme/theme.ts";
import { IPythonActivityComponent } from "./ipython-activity.ts";
import { keyText } from "./keybinding-hints.ts";

export interface IPythonCellContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface IPythonCellState {
	code: string;
	content?: readonly IPythonCellContentBlock[];
	details?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	executionStarted?: boolean;
	argsComplete?: boolean;
	hidden?: boolean;
	activities?: readonly IPythonActivity[];
}

interface IPythonDetails {
	status?: string;
	durationMs?: number;
	errorName?: string;
}

const OUTPUT_INDENT = "  ";
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

function closeOpenSgr(line: string): string {
	let foregroundOpen = false;
	let backgroundOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const parameters = match[1] === "" ? [0] : (match[1]?.split(";").map(Number) ?? [0]);
		for (let index = 0; index < parameters.length; index++) {
			const code = parameters[index] ?? 0;
			if (code === 0) {
				foregroundOpen = false;
				backgroundOpen = false;
			} else if (code === 39) {
				foregroundOpen = false;
			} else if (code === 49) {
				backgroundOpen = false;
			} else if (code === 38 || code === 48) {
				if (code === 38) foregroundOpen = true;
				else backgroundOpen = true;
				const mode = parameters[index + 1];
				index += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				foregroundOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				backgroundOpen = true;
			}
		}
	}
	return foregroundOpen || backgroundOpen ? `${line}\x1b[0m` : line;
}

function readDetails(value: unknown): IPythonDetails {
	if (!value || typeof value !== "object") return {};
	const record = value as Record<string, unknown>;
	return {
		status: typeof record.status === "string" ? record.status : undefined,
		durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
		errorName: typeof record.errorName === "string" ? record.errorName : undefined,
	};
}

function textFromBlocks(blocks: readonly IPythonCellContentBlock[] | undefined): string {
	return (blocks ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
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

type StatusKind = "error" | "aborted" | "running" | "queued" | "done";

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
	private cachedState?: IPythonCellState;
	private cachedThemeFg?: string;
	private cachedLines?: string[];
	private cachedTheme?: typeof theme;
	private cachedCodeSummary?: { text: string; firstLine: string; lines: number };
	private cachedOutputSummary?: { parts: string[]; lines: number };
	private cachedPreview?: { text: string; theme: typeof theme; line: string };

	constructor(state: IPythonCellState) {
		this.state = state;
	}

	update(state: IPythonCellState): void {
		if (
			this.state.code === state.code &&
			this.state.content === state.content &&
			this.state.details === state.details &&
			this.state.isPartial === state.isPartial &&
			this.state.isError === state.isError &&
			this.state.expanded === state.expanded &&
			this.state.executionStarted === state.executionStarted &&
			this.state.argsComplete === state.argsComplete &&
			this.state.hidden === state.hidden &&
			this.state.activities === state.activities
		) {
			return;
		}
		this.state = state;
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
		this.cachedPreview = undefined;
		for (const component of this.activityComponents.values()) component.invalidate();
	}

	render(width: number): string[] {
		if (this.state.hidden) {
			this.activityComponents.clear();
			this.invalidate();
			this.cachedCodeSummary = undefined;
			this.cachedOutputSummary = undefined;
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
		)
			return this.cachedLines;
		const details = readDetails(this.state.details);
		const lines = [truncateToWidth(` ${this.summaryLine(details)}`, safeWidth, "")];
		if (this.state.expanded) this.renderCode(lines, safeWidth);
		this.renderActivities(lines, safeWidth);
		if (this.state.expanded) this.renderOutput(lines, safeWidth, details, true);
		this.cachedWidth = safeWidth;
		this.cachedState = this.state;
		this.cachedThemeFg = themeFg;
		this.cachedTheme = theme;
		this.cachedLines = lines;
		return lines;
	}

	private summaryLine(details: IPythonDetails): string {
		const parts = [`${this.marker(details)} ${theme.fg("muted", "python")}`];
		if (this.state.executionStarted && this.statusKind(details) === "running") {
			const interruptKey = keyText("app.interrupt");
			if (interruptKey) parts.push(theme.fg("muted", `${interruptKey} to interrupt`));
		}
		if (this.cachedCodeSummary?.text !== this.state.code) {
			const summary = summarizeLines(this.state.code);
			this.cachedCodeSummary = { text: this.state.code, firstLine: summary.firstLine, lines: summary.nonEmptyLines };
		}
		const inputSummary = this.cachedCodeSummary;
		const preview = inputSummary.firstLine;
		if (preview) {
			if (this.cachedPreview?.text !== preview || this.cachedPreview.theme !== theme) {
				this.cachedPreview = {
					text: preview,
					theme,
					line: highlightCode(preview, "python")[0] ?? theme.fg("mdCodeBlock", preview),
				};
			}
			parts.push(this.cachedPreview.line);
		} else {
			this.cachedPreview = undefined;
			if (!this.state.executionStarted) parts.push(theme.fg("muted", "waiting for code"));
		}

		const counts = this.lineCounts(inputSummary.lines);
		if (counts) parts.push(theme.fg("muted", counts));
		const duration = formatDuration(details.durationMs);
		if (duration) parts.push(theme.fg("muted", duration));
		if (details.errorName && !this.state.isPartial) parts.push(theme.fg("error", details.errorName));
		else if (
			this.state.isPartial &&
			(this.state.activities?.some((activity) => activity.status === "running") ?? false)
		)
			parts.push(theme.fg("muted", "working"));
		return parts.join(theme.fg("dim", " · "));
	}

	private statusKind(details: IPythonDetails): StatusKind {
		if (this.state.isError || details.status === "error") return "error";
		if (details.status === "aborted") return "aborted";
		if (!this.state.isPartial && (details.status !== undefined || (this.state.content?.length ?? 0) > 0))
			return "done";
		if (this.state.isPartial || this.state.executionStarted) return "running";
		return "queued";
	}

	private marker(details: IPythonDetails): string {
		switch (this.statusKind(details)) {
			case "error":
				return theme.fg("error", "✗");
			case "aborted":
				return theme.fg("warning", "✗");
			case "done":
				return theme.fg("success", "✓");
			case "running":
				return theme.fg("bashMode", "◆");
			case "queued":
				return theme.fg("muted", "◇");
		}
	}

	private lineCounts(input: number): string | undefined {
		const parts: string[] = [];
		this.state.content?.forEach((block) => {
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
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

	private renderActivities(lines: string[], width: number): void {
		const activities = this.state.activities ?? [];
		if (activities.length === 0) {
			this.activityComponents.clear();
			return;
		}
		this.addBlank(lines);
		const activeIds = new Set<string>();
		for (const activity of activities) {
			activeIds.add(activity.id);
			let component = this.activityComponents.get(activity.id);
			if (!component) {
				component = new IPythonActivityComponent(activity, this.state.expanded ?? false);
				this.activityComponents.set(activity.id, component);
			} else {
				component.update(activity, this.state.expanded ?? false);
			}
			for (const line of component.render(width)) lines.push(line);
		}
		for (const id of this.activityComponents.keys()) {
			if (!activeIds.has(id)) this.activityComponents.delete(id);
		}
	}

	private renderCode(lines: string[], width: number): boolean {
		const code = this.state.code.trimEnd();
		this.addBlank(lines);
		if (!code) {
			this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", "waiting for code"), width);
			return false;
		}

		const highlighted = highlightCode(code, "python");
		for (const [index, line] of highlighted.entries()) {
			const prefix = theme.fg("dim", index === 0 ? "› " : "  ");
			this.addWrapped(lines, prefix, line || " ", width);
		}
		return true;
	}

	private renderOutput(lines: string[], width: number, details: IPythonDetails, hasCode: boolean): void {
		const output = textFromBlocks(this.state.content).trimEnd();
		if (hasCode) this.addBlank(lines);
		if (output) {
			const color = this.statusKind(details) === "error" ? "muted" : "toolOutput";
			for (const line of output.split("\n")) {
				this.addWrapped(lines, OUTPUT_INDENT, theme.fg(color, line || " "), width);
			}
			return;
		}
		const waiting = this.state.isPartial || (this.state.executionStarted && !this.state.argsComplete);
		this.addWrapped(lines, OUTPUT_INDENT, theme.fg("muted", waiting ? "waiting for output..." : "no output"), width);
	}

	private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
		const available = Math.max(1, width - 1 - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			lines.push(truncateToWidth(` ${linePrefix}${closeOpenSgr(line)}`, width, ""));
		}
	}

	private addBlank(lines: string[]): void {
		lines.push("");
	}
}
