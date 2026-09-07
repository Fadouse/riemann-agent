import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { isOpenAICodexContextTool } from "@earendil-works/pi-ai/api/openai-codex-context";

/** Presentation only. Never use this projection for persistence or provider context. */
export function isModelOnlyToolCall(message: Pick<AssistantMessage, "provider" | "api">, call: ToolCall): boolean {
	return (
		message.provider === "openai-codex" &&
		message.api === "openai-codex-responses" &&
		(isOpenAICodexContextTool(call) ||
			((call.namespace === undefined || call.namespace === "functions") &&
				(call.name === "new_context" || call.name === "get_context_remaining")))
	);
}

/** Tracks private call IDs so local context-tool results need no persistent display flag. */
export class ModelOnlyToolPresentation {
	private readonly hiddenCalls = new Set<string>();

	message(message: AgentMessage): AgentMessage | undefined {
		if (message.role === "assistant") {
			const content = message.content.filter((block) => {
				if (block.type !== "toolCall" || !isModelOnlyToolCall(message, block)) return true;
				this.hiddenCalls.add(block.id);
				return false;
			});
			return content.length === message.content.length ? message : { ...message, content };
		}
		if (
			message.role === "toolResult" &&
			(message.openaiCodexOutput !== undefined || this.hiddenCalls.has(message.toolCallId))
		)
			return undefined;
		return message;
	}
}
