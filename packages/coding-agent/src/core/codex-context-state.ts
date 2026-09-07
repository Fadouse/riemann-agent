import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Not a compaction entry: resetting a window never creates or replays a summary. */
export const CODEX_CONTEXT_STATE = "codex-context-window";

export interface CodexContextWindow {
	version: 1;
	sessionId: string;
	firstWindowId: string;
	previousWindowId?: string;
	windowId: string;
	windowNumber: number;
	/** Stable provider installation identity, distinct from thread and window IDs. */
	installationId: string;
	forkedFromThreadId?: string;
	threadHint?: string;
	initialMessages: AgentMessage[];
	/** Host prefix length; inherited conversation after this prefix survives child forks. */
	initialContextLength?: number;
}

export function isCodexContextWindow(value: unknown): value is CodexContextWindow {
	if (!value || typeof value !== "object") return false;
	const window = value as Partial<CodexContextWindow>;
	return (
		window.version === 1 &&
		typeof window.sessionId === "string" &&
		typeof window.firstWindowId === "string" &&
		typeof window.windowId === "string" &&
		typeof window.installationId === "string" &&
		(window.forkedFromThreadId === undefined || typeof window.forkedFromThreadId === "string") &&
		typeof window.windowNumber === "number" &&
		Number.isSafeInteger(window.windowNumber) &&
		window.windowNumber >= 0 &&
		(window.previousWindowId === undefined || typeof window.previousWindowId === "string") &&
		(window.threadHint === undefined || typeof window.threadHint === "string") &&
		(window.initialContextLength === undefined ||
			(Number.isSafeInteger(window.initialContextLength) && window.initialContextLength >= 0)) &&
		Array.isArray(window.initialMessages)
	);
}
