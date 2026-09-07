import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { assignOpenAICodexContextItemIds } from "@earendil-works/pi-ai/api/openai-codex-context";
import { convertToLlm } from "./messages.ts";

/** Assign provider item IDs before persisting either raw messages or custom-message projections. */
export function assignCodexContextIds(messages: readonly AgentMessage[], turnId?: string): void {
	for (const message of messages) {
		const projected = convertToLlm([message]);
		assignOpenAICodexContextItemIds(projected, turnId);
		const item = projected[0];
		if (item && message.role !== "assistant" && message.role !== "toolResult") {
			message.openaiCodexItemId = item.role === "user" ? item.openaiCodexItemId : undefined;
			message.openaiCodexMetadata = item.openaiCodexMetadata;
		}
	}
}
