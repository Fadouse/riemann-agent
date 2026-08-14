import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../../riemann/agents/supervisor.ts";
import type { AgentStatus } from "../../riemann/state/store.ts";

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
	return line.length <= limit ? line : `${line.slice(0, Math.max(0, limit - 1))}…`;
}

export function rightAlign(left: string, right: string, width: number, minGap = 1): string {
	const safeWidth = Math.max(1, width);
	const maxLeft = Math.max(0, safeWidth - visibleWidth(right) - minGap);
	const clampedLeft = truncateToWidth(left, maxLeft, "").replaceAll("\x1b[0m", "");
	const gap = Math.max(minGap, safeWidth - visibleWidth(clampedLeft) - visibleWidth(right));
	return truncateToWidth(`${clampedLeft}${" ".repeat(gap)}${right}`, safeWidth, "").replaceAll("\x1b[0m", "");
}

function fleetWindow(selectedIndex: number, agentCount: number): { start: number; visible: number } {
	const visible = Math.min(MAX_FLEET_AGENT_ROWS, agentCount);
	const selectedAgent = Math.max(0, selectedIndex - 1);
	const start = selectedAgent < visible ? 0 : selectedAgent - visible + 1;
	return { start, visible };
}

function fleetBullet(index: number, selectedIndex: number, theme: Theme): string {
	return index === selectedIndex ? theme.fg("accent", "●") : theme.fg("dim", "○");
}

export function renderSubagentFleet(
	agents: readonly SubagentUiSnapshot[],
	theme: Theme,
	now = Date.now(),
	width = 80,
	selectedIndex = 0,
	selectionActive = false,
): string[] {
	if (agents.length === 0) return [];
	const safeWidth = Math.max(1, width);
	const selected = selectionActive ? Math.max(0, Math.min(agents.length, selectedIndex)) : -1;
	const { start, visible } = fleetWindow(Math.max(0, selectedIndex), agents.length);
	const hint = selectionActive
		? `${keyText("tui.select.up")}/${keyText("tui.select.down")} select · ${keyText("tui.select.confirm")} view · ${keyText("tui.select.cancel")} back`
		: `${keyText("app.interrupt")} to interrupt · ${keyText("tui.editor.cursorLeft")} for agents · ${keyText("tui.select.down")} to manage`;
	const lines = [truncateToWidth(`  ${theme.fg("dim", hint)}`, safeWidth, ""), ""];
	lines.push(truncateToWidth(`  ${fleetBullet(0, selected, theme)} main`, safeWidth, ""));
	if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), safeWidth));
	for (let index = start; index < start + visible; index += 1) {
		const agent = agents[index];
		if (!agent) continue;
		const left = `  ${fleetBullet(index + 1, selected, theme)} ${theme.fg("muted", agent.name)}  ${agent.task}`;
		const right = theme.fg("dim", `${formatFleetElapsed(agent, now)} · ${formatFleetTokens(agent.tokens)}`);
		lines.push(rightAlign(left, right, safeWidth));
	}
	const hiddenBelow = agents.length - (start + visible);
	if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), safeWidth));
	return lines;
}

export function subagentStatusText(agent: SubagentUiSnapshot): string {
	if (agent.status === "queued") return "queued";
	if (agent.status === "running") return agent.currentTool ? `${agent.currentTool}…` : "Working…";
	if (agent.status === "stopped") return "Stopped";
	if (agent.lastOutcome === "error") return `Error: ${agent.error ?? "unknown"}`;
	if (agent.lastOutcome === "cancelled") return "Cancelled";
	if (agent.lastOutcome === "ok") return "Done";
	return "Idle";
}

export function subagentStatusIcon(agent: SubagentUiSnapshot, theme: Theme): string {
	if (agent.status === "running") return theme.fg("accent", "●");
	if (agent.status === "queued") return theme.fg("dim", "○");
	if (agent.status === "stopped" || agent.lastOutcome === "cancelled") return theme.fg("dim", "■");
	if (agent.lastOutcome === "error") return theme.fg("error", "✗");
	if (agent.lastOutcome === "ok") return theme.fg("success", "✓");
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
