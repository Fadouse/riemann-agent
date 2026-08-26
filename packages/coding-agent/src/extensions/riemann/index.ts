import { Text } from "@earendil-works/pi-tui";
import type { BuildSystemPromptOptions, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import type { AgentEventDelivery } from "../../riemann/agents/supervisor.ts";
import { resolveCompactionStrategy } from "../../riemann/compaction-strategy.ts";
import {
	type CompactionWarningTrigger,
	detectCompactionWarnings,
	latestActiveCompactionHasOpenAIContext,
} from "../../riemann/compaction-warning.ts";
import { getRiemannAgentDir, loadRiemannConfig } from "../../riemann/config.ts";
import {
	IPYTHON_TOOL_DESCRIPTION,
	IPYTHON_TOOL_PROMPT_SNIPPET,
	IPythonSchema,
	type IPythonToolDetails,
} from "../../riemann/ipython.ts";
import { getPreservedOpenAICompaction } from "../../riemann/openai-compaction-state.ts";
import { RiemannRuntime } from "../../riemann/runtime.ts";
import { installSubagentUi, type SubagentUiController } from "./subagent-ui.ts";

const AGENT_EVENT_RECEIPT_TYPE = "riemann-agent-events";
const AGENT_COMPLETION_MESSAGE_TYPE = "riemann-agent-completion";

type AgentCompletionDisplay = Pick<AgentEventDelivery["events"][number], "name" | "outcome">;

interface AgentEventReceipt {
	eventIds: string[];
	completions?: AgentCompletionDisplay[];
}

interface CompactionWarningEventInput {
	trigger: CompactionWarningTrigger;
	hasEncryptedOpenAIContext: boolean;
	model: ExtensionContext["model"];
	previousModel?: ExtensionContext["model"];
}

function notifyWarnings(
	ctx: Pick<ExtensionContext, "ui">,
	warnings: ReturnType<typeof detectCompactionWarnings>,
): void {
	for (const warning of warnings) {
		try {
			ctx.ui.notify(warning.message, "warning");
		} catch {}
	}
}

function activeBranchHasEncryptedOpenAIContext(ctx: ExtensionContext): boolean {
	try {
		return latestActiveCompactionHasOpenAIContext(ctx.sessionManager.getBranch());
	} catch {
		return false;
	}
}

function preparationHasEncryptedOpenAIContext(preparation: {
	previousPreserveData?: Record<string, unknown>;
}): boolean {
	try {
		return getPreservedOpenAICompaction(preparation.previousPreserveData) !== undefined;
	} catch {
		return false;
	}
}

/** Warning-only compatibility check. Failures must not affect the event being observed. */
async function warnForCompactionEvent(ctx: ExtensionContext, input: CompactionWarningEventInput): Promise<void> {
	try {
		const configured = (
			await loadRiemannConfig({
				cwd: ctx.cwd,
				agentDir: getRiemannAgentDir(),
				projectTrusted: ctx.isProjectTrusted(),
			})
		).compaction.strategy;
		const resolution = resolveCompactionStrategy(configured, input.model);
		const supportsOpenAICompaction =
			input.model?.provider === "openai-codex" && input.model.api === "openai-codex-responses";
		const previousEffectiveStrategy =
			input.trigger === "model-change"
				? resolveCompactionStrategy(configured, input.previousModel).effective
				: input.hasEncryptedOpenAIContext
					? "openai"
					: resolution.effective;
		notifyWarnings(
			ctx,
			detectCompactionWarnings({
				trigger: input.trigger,
				hasEncryptedOpenAIContext: input.hasEncryptedOpenAIContext,
				previousEffectiveStrategy,
				effectiveStrategy: resolution.effective,
				currentModel: {
					supportsImageInput: input.model?.input.includes("image") ?? false,
					supportsOpenAICompaction,
					...(input.model ? { usingOAuth: ctx.modelRegistry.isUsingOAuth(input.model) } : {}),
				},
			}),
		);
	} catch {}
}

function persistedAgentEventIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		let metadata: unknown;
		if (entry.type === "custom" && entry.customType === AGENT_EVENT_RECEIPT_TYPE) {
			metadata = entry.data;
		} else if (entry.type === "custom_message" && entry.customType === AGENT_EVENT_RECEIPT_TYPE) {
			metadata = entry.details;
		} else {
			continue;
		}
		if (
			typeof metadata !== "object" ||
			metadata === null ||
			!("eventIds" in metadata) ||
			!Array.isArray(metadata.eventIds)
		)
			continue;
		for (const id of metadata.eventIds) {
			if (typeof id === "string") ids.add(id);
		}
	}
	return ids;
}

function completionDisplays(value: unknown): AgentCompletionDisplay[] {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("completions" in value) ||
		!Array.isArray(value.completions)
	) {
		return [];
	}
	const displays: AgentCompletionDisplay[] = [];
	for (const completion of value.completions) {
		if (
			typeof completion !== "object" ||
			completion === null ||
			Array.isArray(completion) ||
			!("name" in completion) ||
			typeof completion.name !== "string" ||
			!("outcome" in completion) ||
			(completion.outcome !== "ok" && completion.outcome !== "error" && completion.outcome !== "cancelled")
		) {
			continue;
		}
		displays.push({ name: completion.name, outcome: completion.outcome });
	}
	return displays;
}

function completionReminder(events: AgentEventDelivery["events"]): string {
	return [
		"[Riemann Agent completion]",
		"",
		...events.map(
			(event) => `Agent ${event.name} (${event.agentId}) completed turn ${event.turnId}: ${event.outcome}.`,
		),
		"",
		"Progress only: wait for every retained handle and read each AgentResult.output before synthesizing a batch.",
	].join("\n");
}

export function deliverAgentEvents(
	pi: Parameters<ExtensionFactory>[0],
	ctx: ExtensionContext,
	delivery: AgentEventDelivery,
): void {
	const persisted = persistedAgentEventIds(ctx);
	const missing = delivery.events.filter((event) => !persisted.has(event.id));
	if (missing.length === 0) return;
	const eventIds = missing.map((event) => event.id);
	pi.sendMessage(
		{
			customType: AGENT_COMPLETION_MESSAGE_TYPE,
			content: completionReminder(missing),
			display: false,
			details: { eventIds },
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
	pi.appendEntry<AgentEventReceipt>(AGENT_EVENT_RECEIPT_TYPE, {
		eventIds,
		completions: missing.map(({ name, outcome }) => ({ name, outcome })),
	});
	const stored = persistedAgentEventIds(ctx);
	if (eventIds.some((id) => !stored.has(id))) {
		throw new Error("Could not persist Riemann Agent completion receipts");
	}
}

function appendProjectContext(prompt: string, options: BuildSystemPromptOptions): string {
	const sections = [prompt];
	if (options.customPrompt) {
		sections.push(`<user_system_prompt>\n${options.customPrompt}\n</user_system_prompt>`);
	}
	if (options.appendSystemPrompt) sections.push(options.appendSystemPrompt);
	if (options.contextFiles && options.contextFiles.length > 0) {
		sections.push(
			[
				"<project_context>",
				...options.contextFiles.map(
					({ path, content }) =>
						`<project_instructions path=${JSON.stringify(path)}>\n${content}\n</project_instructions>`,
				),
				"</project_context>",
			].join("\n\n"),
		);
	}
	if (options.skills && options.skills.length > 0) {
		sections.push(
			[
				"<available_skills>",
				"Load a skill with fs.read only when its description matches the task.",
				...options.skills.map((skill) => `- ${skill.name}: ${skill.description}\n  path: ${skill.filePath}`),
				"</available_skills>",
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}

const riemannExtension: ExtensionFactory = (pi) => {
	pi.registerEntryRenderer<AgentEventReceipt>(AGENT_EVENT_RECEIPT_TYPE, (entry, _options, theme) => {
		const completions = completionDisplays(entry.data);
		if (completions.length === 0) return undefined;
		const lines = completions.map(({ name, outcome }) => {
			if (outcome === "error") return `${theme.fg("error", "✗")} ${theme.fg("muted", `${name} failed`)}`;
			if (outcome === "cancelled") return `${theme.fg("dim", "■")} ${theme.fg("muted", `${name} cancelled`)}`;
			return `${theme.fg("success", "✓")} ${theme.fg("muted", `${name} completed`)}`;
		});
		return new Text(lines.join("\n"), 1, 0);
	});

	let runtime: RiemannRuntime | undefined;
	let closing: Promise<void> | undefined;
	let subagentUi: SubagentUiController | undefined;

	const getRuntime = async (ctx: ExtensionContext): Promise<RiemannRuntime> => {
		if (runtime) {
			runtime.updateRootContext(ctx);
			return runtime;
		}
		runtime = await RiemannRuntime.createRoot(ctx, {
			deliverAgentEvents: async (delivery) => deliverAgentEvents(pi, ctx, delivery),
			warningSink: (message) => {
				try {
					ctx.ui.notify(message, "warning");
				} catch {}
			},
		});
		return runtime;
	};

	const closeRuntime = async (): Promise<void> => {
		subagentUi?.dispose();
		subagentUi = undefined;
		if (!runtime) return;
		closing ??= runtime.close();
		await closing;
		runtime = undefined;
		closing = undefined;
	};

	pi.registerTool<typeof IPythonSchema, IPythonToolDetails>({
		name: "ipython",
		label: "IPython",
		description: IPYTHON_TOOL_DESCRIPTION,
		promptSnippet: IPYTHON_TOOL_PROMPT_SNIPPET,
		parameters: IPythonSchema,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const current = await getRuntime(ctx);
			return current.toolDefinition().execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	pi.registerCommand("agents", {
		description: "Inspect and manage active Riemann Subagents",
		handler: async (_args, ctx) => {
			const current = await getRuntime(ctx);
			subagentUi ??= installSubagentUi(current, ctx);
			await subagentUi.showHub(ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "reload") {
			await warnForCompactionEvent(ctx, {
				trigger: "session-resume",
				hasEncryptedOpenAIContext: activeBranchHasEncryptedOpenAIContext(ctx),
				model: ctx.model,
			});
		}
		const current = await getRuntime(ctx);
		subagentUi?.dispose();
		subagentUi = installSubagentUi(current, ctx);
		pi.setActiveTools(["ipython"]);
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;
		await warnForCompactionEvent(ctx, {
			trigger: "model-change",
			hasEncryptedOpenAIContext: activeBranchHasEncryptedOpenAIContext(ctx),
			model: event.model,
			previousModel: event.previousModel,
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = await getRuntime(ctx);
		if (pi.getActiveTools().length !== 1 || pi.getActiveTools()[0] !== "ipython") pi.setActiveTools(["ipython"]);
		return { systemPrompt: appendProjectContext(current.systemPrompt("main"), event.systemPromptOptions) };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		await warnForCompactionEvent(ctx, {
			trigger: "compaction-dispatch",
			hasEncryptedOpenAIContext: preparationHasEncryptedOpenAIContext(event.preparation),
			model: ctx.model,
		});
		const current = await getRuntime(ctx);
		return {
			compaction: await current.compact(event.preparation, event.customInstructions, event.signal, ctx),
		};
	});

	pi.on("agent_settled", async () => {
		await runtime?.snapshot();
		await runtime?.flushAgentEvents();
	});

	pi.on("session_shutdown", closeRuntime);
};

export default riemannExtension;
