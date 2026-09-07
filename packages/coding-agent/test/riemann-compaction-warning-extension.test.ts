import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getCodexContextHost, setCodexContextActive } from "../src/core/codex-context-session.ts";
import type { CompactionPreparation, CompactionResult } from "../src/core/compaction/index.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import riemannExtension from "../src/extensions/riemann/index.ts";
import { type ChildRiemannRuntime, registerChildCompactionHooks } from "../src/riemann/agents/supervisor.ts";
import { OPENAI_COMPACTION_PRESERVE_KEY } from "../src/riemann/openai-compaction-state.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";

const roots: string[] = [];
const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;

const textModel = {
	provider: "faux",
	id: "text",
	name: "Text",
	api: "faux:test",
	input: ["text"],
} as Model<Api>;

const codexModel = {
	provider: "openai-codex",
	id: "gpt-codex",
	name: "Codex",
	api: "openai-codex-responses",
	input: ["text", "image"],
} as Model<Api>;

const preservedOpenAIContext = {
	[OPENAI_COMPACTION_PRESERVE_KEY]: {
		compactionItem: { type: "compaction", encrypted_content: "encrypted" },
		replacementHistory: [
			{ type: "compaction", encrypted_content: "encrypted" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "summary" }] },
		],
	},
};

function opaqueBranch(): SessionEntry[] {
	return [
		{
			id: "compaction",
			parentId: null,
			timestamp: "2026-08-26T00:00:00.000Z",
			type: "compaction",
			summary: "opaque",
			firstKeptEntryId: "first",
			tokensBefore: 100,
			preserveData: preservedOpenAIContext,
		},
	];
}

function preparation(previousPreserveData = preservedOpenAIContext): CompactionPreparation {
	return {
		firstKeptEntryId: "first",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 100,
		previousPreserveData,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
	};
}

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>;

function extensionApi(handlers: Map<string, Handler>): Record<string, unknown> {
	return {
		registerEntryRenderer() {},
		registerTool() {},
		registerCommand() {},
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		getActiveTools: () => ["ipython"],
		setActiveTools() {},
	};
}

function context(options: {
	cwd: string;
	model: Model<Api>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
	branch?: SessionEntry[];
	usingOAuth?: boolean;
}): ExtensionContext {
	return {
		cwd: options.cwd,
		model: options.model,
		mode: "json",
		ui: { notify: options.notify },
		modelRegistry: { isUsingOAuth: () => options.usingOAuth ?? false },
		sessionManager: {
			getSessionId: () => "warning-session",
			getEntries: () => options.branch ?? [],
			getBranch: () => options.branch ?? [],
		},
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
}

async function configRoot(strategy: "automatic" | "default" | "openai" | "snapshot"): Promise<{
	root: string;
	agentDir: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "riemann-compaction-warning-extension-"));
	roots.push(root);
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "config.yaml"), `compaction:\n  strategy: ${strategy}\n`);
	return { root, agentDir };
}

async function setStrategy(agentDir: string, strategy: "automatic" | "default" | "openai" | "snapshot") {
	await writeFile(join(agentDir, "config.yaml"), `compaction:\n  strategy: ${strategy}\n`);
}

afterEach(async () => {
	vi.restoreAllMocks();
	if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
	else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Riemann compaction warning extension hooks", () => {
	test("root session and model hooks inspect the active branch and reload the configured strategy", async () => {
		const { root, agentDir } = await configRoot("automatic");
		process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
		const notify = vi.fn();
		const ctx = context({ cwd: root, model: textModel, notify, branch: opaqueBranch() });
		const fakeRuntime = {
			subscribeSubagentUi: () => () => undefined,
			updateRootContext() {},
		} as unknown as RiemannRuntime;
		const createRoot = vi.spyOn(RiemannRuntime, "createRoot").mockResolvedValue(fakeRuntime);
		const handlers = new Map<string, Handler>();
		riemannExtension(extensionApi(handlers) as never);

		for (const reason of ["startup", "resume", "new", "fork"] as const) {
			await handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
		}
		expect(notify).toHaveBeenCalledTimes(4);
		expect(notify.mock.calls).toEqual(
			Array.from({ length: 4 }, () => [expect.stringContaining("encrypted OpenAI compaction"), "warning"]),
		);

		await handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
		expect(notify).toHaveBeenCalledTimes(4);

		await setStrategy(agentDir, "snapshot");
		const staleContext = context({ cwd: root, model: codexModel, notify, branch: opaqueBranch() });
		await handlers.get("model_select")?.(
			{ type: "model_select", model: textModel, previousModel: codexModel, source: "restore" },
			staleContext,
		);
		expect(notify).toHaveBeenCalledTimes(4);

		await handlers.get("model_select")?.(
			{ type: "model_select", model: textModel, previousModel: codexModel, source: "set" },
			staleContext,
		);
		expect(notify).toHaveBeenCalledTimes(6);
		expect(notify.mock.calls.slice(-2)).toEqual([
			[expect.stringContaining("encrypted OpenAI compaction"), "warning"],
			[expect.stringContaining("Snapshot compaction requires an image-capable model"), "warning"],
		]);

		const warningSink = createRoot.mock.calls[0]?.[1]?.warningSink;
		expect(warningSink).toBeTypeOf("function");
		warningSink?.("child warning");
		expect(notify).toHaveBeenLastCalledWith("child warning", "warning");
	});

	test("root manual dispatch swallows warning sink failures without changing compaction", async () => {
		const { root, agentDir } = await configRoot("openai");
		process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
		const notify = vi.fn().mockImplementationOnce(() => {
			throw new Error("closed warning sink");
		});
		const ctx = context({ cwd: root, model: textModel, notify });
		const expected: CompactionResult = {
			summary: "unchanged",
			firstKeptEntryId: "first",
			tokensBefore: 100,
			details: { original: true },
			preserveData: preservedOpenAIContext,
		};
		const compact = vi.fn().mockResolvedValue(expected);
		const fakeRuntime = {
			compact,
			subscribeSubagentUi: () => () => undefined,
		} as unknown as RiemannRuntime;
		vi.spyOn(RiemannRuntime, "createRoot").mockResolvedValue(fakeRuntime);
		const handlers = new Map<string, Handler>();
		riemannExtension(extensionApi(handlers) as never);
		const input = preparation();
		const signal = new AbortController().signal;

		const result = await handlers.get("session_before_compact")?.(
			{
				type: "session_before_compact",
				preparation: input,
				customInstructions: "keep exact",
				reason: "manual",
				willRetry: false,
				signal,
			},
			ctx,
		);

		expect(notify).toHaveBeenCalledTimes(2);
		expect(compact).toHaveBeenCalledWith(input, "keep exact", signal, ctx);
		expect(result).toEqual({ compaction: expected });
		expect(result && (result as { compaction: CompactionResult }).compaction).toBe(expected);
	});

	test("child hooks use the root warning sink without relying on a bound child UI", async () => {
		const { root, agentDir } = await configRoot("snapshot");
		const childUiNotify = vi.fn(() => {
			throw new Error("child UI is not bound");
		});
		const warningSink = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("closed warning sink");
			})
			.mockImplementationOnce(() => Promise.reject(new Error("async warning sink failure")));
		const ctx = context({ cwd: root, model: textModel, notify: childUiNotify, branch: opaqueBranch() });
		const expected: CompactionResult = {
			summary: "child unchanged",
			firstKeptEntryId: "first",
			tokensBefore: 100,
			preserveData: preservedOpenAIContext,
		};
		const compact = vi.fn().mockResolvedValue(expected);
		const runtime = { compact } as unknown as ChildRiemannRuntime;
		const handlers = new Map<string, Handler>();
		registerChildCompactionHooks(
			extensionApi(handlers) as never,
			runtime,
			{ cwd: root, agentDir, projectTrusted: true },
			warningSink,
		);

		await handlers.get("model_select")?.(
			{ type: "model_select", model: codexModel, previousModel: textModel, source: "restore" },
			ctx,
		);
		expect(warningSink).toHaveBeenCalledTimes(0);

		await handlers.get("model_select")?.(
			{ type: "model_select", model: codexModel, previousModel: textModel, source: "set" },
			ctx,
		);
		expect(warningSink).toHaveBeenCalledTimes(1);

		await handlers.get("model_select")?.(
			{ type: "model_select", model: textModel, previousModel: codexModel, source: "cycle" },
			ctx,
		);
		expect(warningSink).toHaveBeenCalledTimes(3);

		const input = preparation();
		const signal = new AbortController().signal;
		const result = await handlers.get("session_before_compact")?.(
			{
				type: "session_before_compact",
				preparation: input,
				reason: "threshold",
				willRetry: false,
				signal,
			},
			ctx,
		);

		expect(warningSink).toHaveBeenCalledTimes(5);
		expect(childUiNotify).not.toHaveBeenCalled();
		expect(compact).toHaveBeenCalledWith(input, undefined, signal, ctx);
		expect(result && (result as { compaction: CompactionResult }).compaction).toBe(expected);
	});
});

test("child context host is registered before generation and removed on shutdown", async () => {
	const { root, agentDir } = await configRoot("automatic");
	const handlers = new Map<string, Handler>();
	const ctx = context({ cwd: root, model: codexModel, notify: vi.fn(), usingOAuth: true });
	const host = {
		agentName: "/root/worker",
		sharedSessionId: "shared-root-session",
		parentThreadId: "parent-thread",
		initialContext: vi.fn(async () => ({ messages: [] })),
	};
	registerChildCompactionHooks(
		extensionApi(handlers) as never,
		{} as ChildRiemannRuntime,
		{ cwd: root, agentDir, projectTrusted: true },
		undefined,
		host,
	);
	try {
		await handlers.get("session_start")?.({ reason: "new" }, ctx);
		expect(getCodexContextHost("warning-session")).toBe(host);
		await getCodexContextHost("warning-session")?.initialContext();
		expect(host.initialContext).toHaveBeenCalledOnce();
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
	}
	expect(getCodexContextHost("warning-session")).toBeUndefined();
});

test.each(["root", "child"])("%s hook never summarizes an active experimental reset", async (kind) => {
	const { root, agentDir } = await configRoot("automatic");
	process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
	const ctx = context({ cwd: root, model: codexModel, notify: vi.fn(), usingOAuth: true });
	const compact = vi.fn(async () => ({
		summary: "unexpected cloud call",
		firstKeptEntryId: "first",
		tokensBefore: 100,
	}));
	const runtime = { compact };
	const handlers = new Map<string, Handler>();
	if (kind === "root") {
		vi.spyOn(RiemannRuntime, "createRoot").mockResolvedValue(runtime as unknown as RiemannRuntime);
		riemannExtension(extensionApi(handlers) as never);
	} else {
		registerChildCompactionHooks(extensionApi(handlers) as never, runtime as unknown as ChildRiemannRuntime, {
			cwd: root,
			agentDir,
			projectTrusted: true,
		});
	}
	setCodexContextActive("warning-session", true);
	try {
		const result = await handlers.get("session_before_compact")?.(
			{
				preparation: preparation(),
				signal: new AbortController().signal,
				reason: "threshold",
			},
			ctx,
		);
		expect(compact).not.toHaveBeenCalled();
		expect(result).toBeUndefined();
	} finally {
		setCodexContextActive("warning-session", false);
	}
});

test("root reset context preserves native tool guidance and current project instructions", async () => {
	const { root, agentDir } = await configRoot("automatic");
	process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
	const handlers = new Map<string, Handler>();
	const ctx = context({ cwd: root, model: codexModel, notify: vi.fn(), usingOAuth: true });
	const runtime = {
		systemPrompt: () => "Emit model tool calls only with the name `ipython`.",
		initialCodexContext: async () => ({ systemPrompt: "Native context tools are available.", messages: [] }),
		close: vi.fn(async () => {}),
	};
	vi.spyOn(RiemannRuntime, "createRoot").mockResolvedValue(runtime as unknown as RiemannRuntime);
	riemannExtension(extensionApi(handlers) as never);
	await handlers.get("before_agent_start")?.(
		{
			systemPromptOptions: { cwd: root, contextFiles: [{ path: "AGENTS.md", content: "Project rule marker" }] },
		},
		ctx,
	);
	try {
		const initial = await getCodexContextHost("warning-session")?.initialContext();
		expect(initial?.systemPrompt).toContain("Native context tools are available.");
		expect(initial?.systemPrompt).toContain("Project rule marker");
		expect(initial?.systemPrompt).not.toContain("Emit model tool calls only");
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
	}
	expect(getCodexContextHost("warning-session")).toBeUndefined();
});
