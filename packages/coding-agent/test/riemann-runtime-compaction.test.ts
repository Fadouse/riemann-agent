import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { createFileOps } from "../src/core/compaction/utils.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { ChildRiemannRuntime } from "../src/riemann/agents/supervisor.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [{ role: "user", content: "old history", timestamp: 1 }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 42_000,
		fileOps: createFileOps(),
		settings: DEFAULT_COMPACTION_SETTINGS,
	};
}

async function writeStrategy(path: string, strategy: "automatic" | "default" | "openai" | "snapshot") {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, `compaction:\n  strategy: ${strategy}\n`);
}

function durableCompaction(summary: string): unknown {
	const match = /<riemann_state>\n(.+)\n<\/riemann_state>/.exec(summary);
	if (!match?.[1]) throw new Error("Missing Riemann durable state");
	const value: unknown = JSON.parse(match[1]);
	if (typeof value !== "object" || value === null || !("compaction" in value)) {
		throw new Error("Missing compaction dispatch state");
	}
	return value.compaction;
}

function childFacade(runtime: RiemannRuntime): ChildRiemannRuntime {
	return (runtime as unknown as { asChildRuntime(): ChildRiemannRuntime }).asChildRuntime();
}

describe("Riemann runtime compaction dispatch", () => {
	test("captures one hot-reloaded strategy and uses the active dispatch model for root and child compaction", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-runtime-compaction-"));
		roots.push(root);
		const agentDir = join(root, "agent-dir");
		const configPath = join(agentDir, "config.yaml");
		await writeStrategy(configPath, "default");
		const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
		process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
		const model = getModel("openai", "gpt-4o-mini");
		const codexModel = getModel("openai-codex", "gpt-5.5");
		if (!model || !codexModel) throw new Error("Built-in compaction test models are unavailable");
		let releaseCompletion: (() => void) | undefined;
		const completionGate = new Promise<void>((resolve) => {
			releaseCompletion = resolve;
		});
		let reportStarted: (() => void) | undefined;
		const completionStarted = new Promise<void>((resolve) => {
			reportStarted = resolve;
		});
		const complete = vi.fn(async () => {
			reportStarted?.();
			await completionGate;
			return fauxAssistantMessage("captured summary");
		});
		const context = {
			model,
			modelRegistry: {
				complete,
				isUsingOAuth: (selected: { provider: string }) => selected.provider === "openai-codex",
			},
			getSystemPrompt: () => "Riemann system",
			thinkingLevel: "off",
		} as unknown as Pick<ExtensionContext, "model" | "modelRegistry" | "getSystemPrompt" | "thinkingLevel">;
		let runtime: RiemannRuntime | undefined;
		try {
			runtime = await RiemannRuntime.createRoot({
				cwd: root,
				model,
				modelRegistry: context.modelRegistry,
				thinkingLevel: "off",
				sessionManager: { getSessionId: () => "runtime-compaction" },
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext);

			const firstCompaction = runtime.compact(preparation(), undefined, new AbortController().signal, context);
			await completionStarted;
			await writeStrategy(configPath, "snapshot");
			releaseCompletion?.();
			const first = await firstCompaction;
			const expectedDefaultDispatch = {
				configured: "default",
				effective: "default",
				reason: "configured",
			};
			expect(first.details).toMatchObject({ strategy: "default", ...expectedDefaultDispatch });
			expect(first.details).not.toHaveProperty("provider");
			expect(first.details).not.toHaveProperty("model");
			expect(durableCompaction(first.summary)).toEqual(expectedDefaultDispatch);

			await expect(
				childFacade(runtime).compact(preparation(), "manual focus", new AbortController().signal, context),
			).rejects.toThrow('compaction.strategy "snapshot" does not support custom instructions');

			await writeStrategy(configPath, "automatic");
			const automatic = await childFacade(runtime).compact(
				preparation(),
				undefined,
				new AbortController().signal,
				context,
			);
			const expectedAutomaticDispatch = {
				configured: "automatic",
				effective: "default",
				reason: "automatic-default",
			};
			expect(automatic.details).toMatchObject({ strategy: "default", ...expectedAutomaticDispatch });
			expect(durableCompaction(automatic.summary)).toEqual(expectedAutomaticDispatch);

			const codexContext = { ...context, model: codexModel };
			await expect(
				runtime.compact(preparation(), "manual focus", new AbortController().signal, codexContext),
			).rejects.toThrow('compaction.strategy "openai" does not support custom instructions');
		} finally {
			releaseCompletion?.();
			await runtime?.close();
			if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
			else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	test("keeps a trusted project strategy authoritative during hot reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-runtime-project-compaction-"));
		roots.push(root);
		const agentDir = join(root, "agent-dir");
		const globalPath = join(agentDir, "config.yaml");
		const projectPath = join(root, ".riemann", "config.yaml");
		await writeStrategy(globalPath, "automatic");
		await writeStrategy(projectPath, "default");
		const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
		process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in compaction test model is unavailable");
		const complete = vi.fn(async () => fauxAssistantMessage("project summary"));
		const context = {
			model,
			modelRegistry: {
				complete,
				isUsingOAuth: (selected: { provider: string }) => selected.provider === "openai-codex",
			},
			getSystemPrompt: () => "Riemann system",
			thinkingLevel: "off",
		} as unknown as Pick<ExtensionContext, "model" | "modelRegistry" | "getSystemPrompt" | "thinkingLevel">;
		let runtime: RiemannRuntime | undefined;
		try {
			runtime = await RiemannRuntime.createRoot({
				cwd: root,
				model,
				modelRegistry: context.modelRegistry,
				thinkingLevel: "off",
				sessionManager: { getSessionId: () => "project-compaction" },
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext);

			await writeStrategy(globalPath, "snapshot");
			const first = await runtime.compact(preparation(), undefined, new AbortController().signal, context);
			expect(first.details).toMatchObject({ configured: "default", effective: "default" });

			await writeStrategy(globalPath, "default");
			await writeStrategy(projectPath, "snapshot");
			await expect(
				runtime.compact(preparation(), "manual focus", new AbortController().signal, context),
			).rejects.toThrow('compaction.strategy "snapshot" does not support custom instructions');
		} finally {
			await runtime?.close();
			if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
			else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
