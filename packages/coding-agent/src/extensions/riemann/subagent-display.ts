import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../../riemann/agents/supervisor.ts";
import type { AgentStatus } from "../../riemann/state/store.ts";
import { graphemeSafePrefix } from "../../utils/text.ts";

export const ACTIVE_SUBAGENT_STATUSES = new Set<AgentStatus>(["queued", "running"]);
export const MAX_FLEET_AGENT_ROWS = 5;

export function isActiveSubagent(agent: SubagentUiSnapshot): boolean {
	return ACTIVE_SUBAGENT_STATUSES.has(agent.status);
}

export function formatFleetElapsed(agent: SubagentUiSnapshot, now = Date.now()): string {
	const startedAt = Date.parse(agent.startedAt ?? agent.createdAt);
	const endedAt = isActiveSubagent(agent) ? now : Date.parse(agent.updatedAt);
	const durationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : 0;
	return `${Math.max(0, Math.round(durationMs / 1_000))}s`;
}

export function formatFleetTokens(count: number): string {
	let compact: string;
	if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
	else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
	else compact = String(count);
	return `↓ ${compact} tokens`;
}

export function compactLine(value: string, limit = 70): string {
	const line =
		value
			.split("\n")
			.find((candidate) => candidate.trim().length > 0)
			?.trim() ?? "";
	return line.length <= limit ? line : `${graphemeSafePrefix(line, Math.max(0, limit - 1))}…`;
}

export function rightAlign(left: string, right: string, width: number, minGap = 1): string {
	const safeWidth = Math.max(1, width);
	const maxLeft = Math.max(0, safeWidth - visibleWidth(right) - minGap);
	const clampedLeft = truncateToWidth(left, maxLeft, "").replaceAll("\x1b[0m", "");
	const gap = Math.max(minGap, safeWidth - visibleWidth(clampedLeft) - visibleWidth(right));
	return truncateToWidth(`${clampedLeft}${" ".repeat(gap)}${right}`, safeWidth, "").replaceAll("\x1b[0m", "");
}

function fleetWindow(selectedIndex: number, agentCount: number): { start: number; visible: number } {
	if (agentCount === 0) return { start: 0, visible: 0 };
	const visible = Math.min(MAX_FLEET_AGENT_ROWS, agentCount);
	const start = selectedIndex < visible ? 0 : selectedIndex - visible + 1;
	return { start, visible };
}

export function renderSubagentFleet(
	agents: readonly SubagentUiSnapshot[],
	theme: Theme,
	now = Date.now(),
	width = 80,
	selectedIndex = 0,
	selectionActive = false,
	previews?: ReadonlyMap<string, string>,
): string[] {
	if (agents.length === 0) return [];
	const safeWidth = Math.max(1, width);
	const windowIndex = Math.max(0, Math.min(agents.length - 1, selectedIndex));
	const selected = selectionActive ? windowIndex : -1;
	const { start, visible } = fleetWindow(windowIndex, agents.length);
	const lines: string[] = [];
	if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), safeWidth));
	for (let index = start; index < start + visible; index += 1) {
		const agent = agents[index];
		if (!agent) continue;
		const isSelected = index === selected;
		const name = truncateToWidth(agent.name, Math.max(1, safeWidth - 4), "…");
		const styledName = isSelected ? theme.fg("accent", theme.bold(name)) : theme.bold(name);
		const icon =
			isSelected && isActiveSubagent(agent)
				? theme.fg("accent", "●")
				: agent.status === "running"
					? theme.fg("accent", "○")
					: subagentStatusIcon(agent, theme, "●");
		const left = `  ${icon} ${styledName}`;
		const elapsed = theme.fg("dim", formatFleetElapsed(agent, now));
		// Keep the Agent name visible before adding its latest activity and timing.
		if (visibleWidth(left) + visibleWidth(elapsed) + 2 > safeWidth) {
			lines.push(truncateToWidth(left, safeWidth, ""));
			continue;
		}
		const summary = previews?.get(agent.id) ?? compactLine(latestAssistantText(agent) ?? "");
		const preview = summary ? `  ${theme.fg("muted", summary)}` : "";
		lines.push(rightAlign(`${left}${preview}`, elapsed, safeWidth));
	}
	const hiddenBelow = agents.length - (start + visible);
	if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), safeWidth));
	return lines;
}

export function subagentStatusText(agent: SubagentUiSnapshot): string {
	if (agent.status === "queued") return "queued";
	if (agent.status === "running") return "running";
	if (agent.status === "stopped") return "Stopped";
	if (agent.lastOutcome === "error") return "Error";
	if (agent.lastOutcome === "cancelled") return "Cancelled";
	if (agent.lastOutcome === "ok") return "Done";
	return "Idle";
}

export function subagentStatusIcon(agent: SubagentUiSnapshot, theme: Theme, dot: "•" | "●" = "•"): string {
	if (agent.status === "running") return theme.fg("accent", dot);
	if (agent.status === "queued") return theme.fg("dim", "○");
	if (agent.status === "stopped" || agent.lastOutcome === "cancelled") return theme.fg("dim", "■");
	if (agent.lastOutcome === "error") return theme.fg("error", dot);
	if (agent.lastOutcome === "ok") return theme.fg("success", dot);
	return theme.fg("warning", "Ⅱ");
}

export function latestAssistantText(agent: SubagentUiSnapshot): string | undefined {
	const candidates = agent.streamingMessage ? [...agent.messages, agent.streamingMessage] : agent.messages;
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			!("role" in candidate) ||
			candidate.role !== "assistant" ||
			!("content" in candidate) ||
			!Array.isArray(candidate.content)
		) {
			continue;
		}
		const text = candidate.content
			.flatMap((part) =>
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
					? [part.text]
					: [],
			)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return agent.result;
}

/** Keep essential controls intact; omit optional hints instead of cutting them in half. */
export function fitSubagentHints(hints: readonly string[], width: number): string {
	let result = "";
	for (const hint of hints) {
		const candidate = result ? `${result} · ${hint}` : hint;
		if (visibleWidth(candidate) <= width) result = candidate;
		else if (!result) return truncateToWidth(hint, Math.max(1, width), "");
	}
	return result;
}

export function subagentReleaseLines(agent: SubagentUiSnapshot, width: number): string[] {
	// The UI snapshot does not expose workspaceMode. Do not infer isolation from a path.
	return [
		"Release identity and slot. Any isolated worktree is deleted; shared files remain.",
		`Workspace: ${agent.workspace}`,
		`Transcript: ${agent.transcriptHandle ? `saved ${agent.transcriptHandle}` : "not saved"}`,
		`Patch: ${agent.patchHandle ? `saved ${agent.patchHandle}` : "none saved"}`,
	].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

/** Reserve state beside a shortened name before adding optional task or timing text. */
export function subagentIdentityLine(
	agent: SubagentUiSnapshot,
	theme: Theme,
	width: number,
	selected?: boolean,
	highlighted = selected,
): string {
	const prefix = selected === undefined ? "" : selected ? "> " : "  ";
	const fullStatus = subagentStatusText(agent);
	const status =
		visibleWidth(agent.name) + visibleWidth(fullStatus) + prefix.length + 3 <= width
			? fullStatus
			: fullStatus.split(" · ")[0]!;
	const name = truncateToWidth(agent.name, Math.max(1, width - visibleWidth(status) - prefix.length - 3), "…");
	const styledName = highlighted ? theme.fg("accent", theme.bold(name)) : theme.bold(name);
	return `${prefix}${subagentStatusIcon(agent, theme)} ${styledName} ${theme.fg("muted", status)}`;
}

export function subagentBackHint(cancel = false, width = 0): string {
	const keys = [...keyText("app.agents.close").split("/"), ...keyText("tui.select.cancel").split("/")].filter(Boolean);
	if (width >= 60) return `${[...new Set(keys)].join("/")} ${cancel ? "cancel" : "close"}`;
	const shortest = keys.reduce((best, key) => (key.length < best.length ? key : best), keys[0] ?? "");
	return `${shortest} ${cancel ? "cancel" : "close"}`;
}

export function wrapSubagentHints(hints: readonly string[], width: number, maxRows: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const hint of hints) {
		const candidate = line ? `${line} · ${hint}` : hint;
		if (visibleWidth(candidate) <= width) line = candidate;
		else {
			if (line) lines.push(line);
			if (lines.length === maxRows) return lines;
			line = truncateToWidth(hint, Math.max(1, width), "");
		}
	}
	if (line && lines.length < maxRows) lines.push(line);
	return lines;
}

export function subagentReleaseFooterRows(width: number, height: number): number {
	const actionWidth = Math.max(
		visibleWidth(`${keyText("app.agents.release")} confirm`),
		visibleWidth(`${keyText("tui.select.down")} more`),
	);
	return height >= 6 && visibleWidth(subagentBackHint(true, width)) + 3 + actionWidth > width ? 2 : 1;
}
