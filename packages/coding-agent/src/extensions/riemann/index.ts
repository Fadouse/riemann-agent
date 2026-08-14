import type { BuildSystemPromptOptions, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import {
	IPYTHON_TOOL_DESCRIPTION,
	IPYTHON_TOOL_PROMPT_SNIPPET,
	IPythonSchema,
	type IPythonToolDetails,
} from "../../riemann/ipython.ts";
import { RiemannRuntime } from "../../riemann/runtime.ts";
import { installSubagentUi, type SubagentUiController } from "./subagent-ui.ts";

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
				"Load a skill with workspace.read only when its description matches the task.",
				...options.skills.map((skill) => `- ${skill.name}: ${skill.description}\n  path: ${skill.filePath}`),
				"</available_skills>",
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}

const riemannExtension: ExtensionFactory = (pi) => {
	let runtime: RiemannRuntime | undefined;
	let closing: Promise<void> | undefined;
	let subagentUi: SubagentUiController | undefined;

	const getRuntime = async (ctx: ExtensionContext): Promise<RiemannRuntime> => {
		if (runtime) return runtime;
		runtime = await RiemannRuntime.createRoot(ctx);
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

	pi.on("session_start", async (_event, ctx) => {
		const current = await getRuntime(ctx);
		subagentUi?.dispose();
		subagentUi = installSubagentUi(current, ctx);
		pi.setActiveTools(["ipython"]);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = await getRuntime(ctx);
		if (pi.getActiveTools().length !== 1 || pi.getActiveTools()[0] !== "ipython") pi.setActiveTools(["ipython"]);
		return { systemPrompt: appendProjectContext(current.systemPrompt("main"), event.systemPromptOptions) };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const current = await getRuntime(ctx);
		return {
			compaction: await current.compact(event.preparation, event.customInstructions, event.signal, ctx),
		};
	});

	pi.on("agent_settled", async () => {
		await runtime?.snapshot();
	});

	pi.on("session_shutdown", closeRuntime);
};

export default riemannExtension;
