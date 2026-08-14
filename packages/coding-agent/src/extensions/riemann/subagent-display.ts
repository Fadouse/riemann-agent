import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../../riemann/agents/supervisor.ts";
import type { AgentStatus } from "../../riemann/state/store.ts";

export const ACTIVE_SUBAGENT_STATUSES = new Set<AgentStatus>(["queued", "running", "idle"]);
export const MAX_FLEET_AGENT_ROWS = 5;

const TOOL_OUTPUT_LIMIT = 500;

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
	const hint = selectionActive ? "↑↓ select · enter view · esc back" : "esc to interrupt · ← for agents · ↓ to manage";
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
	if (agent.status === "completed") return "Done";
	if (agent.status === "failed") return `Error: ${agent.error ?? "unknown"}`;
	if (agent.status === "stopped") return "Stopped";
	if (agent.status === "parked") return "Parked";
	if (agent.status === "queued") return "queued";
	if (agent.currentTool) return `${agent.currentTool}…`;
	return "Working…";
}

export function subagentStatusIcon(agent: SubagentUiSnapshot, theme: Theme): string {
	if (agent.status === "running" || agent.status === "idle") return theme.fg("accent", "●");
	if (agent.status === "completed") return theme.fg("success", "✓");
	if (agent.status === "failed") return theme.fg("error", "✗");
	if (agent.status === "parked") return theme.fg("warning", "Ⅱ");
	if (agent.status === "stopped") return theme.fg("dim", "■");
	return theme.fg("dim", "○");
}

export function latestAssistantText(agent: SubagentUiSnapshot): string | undefined {
	const candidates = agent.streamingMessage ? [...agent.messages, agent.streamingMessage] : agent.messages;
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (!isRecord(candidate) || candidate.role !== "assistant" || !Array.isArray(candidate.content)) continue;
		const text = candidate.content
			.flatMap((part) =>
				isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
			)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return agent.result;
}

export function renderAgentMessage(value: unknown, width: number, hideThinking: boolean, theme: Theme): string[] {
	if (!isRecord(value)) return [theme.fg("dim", "[unrecognized message]")];
	const role = typeof value.role === "string" ? value.role : "message";
	if (role === "user") {
		return [theme.fg("accent", "[User]"), ...wrapTextWithAnsi(extractText(value.content).trim(), width)];
	}
	if (role === "assistant") {
		const lines = [theme.bold("[Assistant]")];
		const content = Array.isArray(value.content) ? value.content : [];
		for (const part of content) {
			if (!isRecord(part)) continue;
			if (part.type === "text" && typeof part.text === "string") {
				lines.push(...wrapTextWithAnsi(part.text.trim(), width));
			} else if (part.type === "thinking" && !hideThinking) {
				lines.push(theme.fg("dim", "[Thinking]"));
				if (typeof part.thinking === "string") {
					lines.push(...wrapTextWithAnsi(part.thinking.trim(), width).map((line) => theme.fg("dim", line)));
				}
			} else if (part.type === "redactedThinking" && !hideThinking) {
				lines.push(theme.fg("dim", "[Redacted thinking]"));
			} else if (part.type === "toolCall") {
				lines.push(theme.fg("muted", `  [Tool: ${String(part.name ?? part.toolName ?? "unknown")}]`));
			}
		}
		return lines;
	}
	if (role === "toolResult") {
		const text = truncateToolOutput(extractText(value.content));
		return [
			theme.fg("dim", "[Result]"),
			...wrapTextWithAnsi(text.trim(), width).map((line) => theme.fg("dim", line)),
		];
	}
	if (role === "bashExecution") {
		const command = typeof value.command === "string" ? value.command : "";
		const output = truncateToolOutput(typeof value.output === "string" ? value.output : "");
		return [
			theme.fg("muted", `  $ ${command}`),
			...wrapTextWithAnsi(output.trim(), width).map((line) => theme.fg("dim", line)),
		];
	}
	const generic = truncateToolOutput(extractText(value.content) || "[content omitted]");
	return [theme.fg("dim", `[${role}]`), ...wrapTextWithAnsi(generic.trim(), width)];
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is Record<string, unknown> => isRecord(part) && part.type !== "image")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

function truncateToolOutput(value: string): string {
	if (visibleWidth(value) <= TOOL_OUTPUT_LIMIT) return value;
	return `${truncateToWidth(value, TOOL_OUTPUT_LIMIT, "")}... (truncated)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
