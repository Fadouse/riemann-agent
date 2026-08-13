import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getPackageDir, isBunBinary } from "../config.ts";
import type { CompactionPreparation, CompactionResult } from "../core/compaction/index.ts";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import { RiemannActivityTracker } from "./activity.ts";
import { AgentSupervisor, type ChildRiemannRuntime } from "./agents/supervisor.ts";
import { createRiemannCompaction, createRiemannSnapshotCompaction } from "./compaction.ts";
import { expandConfigSecret, getRiemannAgentDir, loadRiemannConfig, type RiemannConfig } from "./config.ts";
import { formatEnvironmentContext } from "./environment.ts";
import { RiemannHostError } from "./errors.ts";
import { type FunctionDefinition, FunctionRegistry, hasCapability } from "./functions/registry.ts";
import { ShellFunctions } from "./functions/shell.ts";
import { WebFunctions } from "./functions/web.ts";
import { WorkspaceFunctions } from "./functions/workspace.ts";
import {
	IPYTHON_TOOL_DESCRIPTION,
	IPYTHON_TOOL_PROMPT_SNIPPET,
	IPythonSchema,
	type IPythonToolDetails,
} from "./ipython.ts";
import { IPythonKernelManager } from "./kernel/manager.ts";
import type { JsonValue, KernelExecuteResult, KernelRestoreResult } from "./kernel/types.ts";
import { RiemannMcpManager } from "./mcp/manager.ts";
import { createRiemannOpenAICompaction } from "./openai-compaction.ts";
import { renderRiemannPrompt } from "./prompts.ts";
import { ensureManagedPython } from "./python/runtime.ts";
import { ArtifactStore } from "./state/artifacts.ts";
import { applyRetention, type RetentionReport } from "./state/retention.ts";
import { RiemannStore, type StoredAgent, type StoredRun } from "./state/store.ts";

interface SharedRun {
	config: RiemannConfig;

	store: RiemannStore;
	artifacts: ArtifactStore;
	run: StoredRun;
	rootAgent: StoredAgent;
	supervisor: AgentSupervisor;
	agentDir: string;
	retentionReport: RetentionReport;
	rootContext: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "thinkingLevel">;
}

function preludePath(): string {
	const packageDir = getPackageDir();
	if (isBunBinary) return join(packageDir, "riemann-python", "prelude.py");
	const source = join(packageDir, "src", "riemann", "python", "prelude.py");
	return existsSync(source) ? source : join(packageDir, "dist", "riemann", "python", "prelude.py");
}

function isInside(root: string, path: string): boolean {
	const pathFromRoot = relative(root, path);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
	);
}

function artifactHandle(value: JsonValue): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return typeof value.handle === "string" ? value.handle : undefined;
}

function textFromDisplay(data: Record<string, JsonValue>): string | undefined {
	const plain = data["text/plain"];
	if (typeof plain === "string") return plain;
	const markdown = data["text/markdown"];
	if (typeof markdown === "string") return markdown;
	const json = data["application/json"];
	if (json !== undefined) return JSON.stringify(json, null, 2);
	const html = data["text/html"];
	if (typeof html === "string")
		return html
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	return undefined;
}

function restoreNotice(result: KernelRestoreResult): string | undefined {
	if (result.restored.length === 0 && result.skipped.length === 0 && !result.error) return undefined;
	const parts = [
		result.restored.length > 0 ? `Restored variables: ${result.restored.join(", ")}` : undefined,
		result.skipped.length > 0
			? `Skipped variables: ${result.skipped.map((item) => `${item.name} (${item.reason})`).join(", ")}`
			: undefined,
		result.error ? `Restore error: ${result.error}` : undefined,
	].filter((part): part is string => part !== undefined);
	return `[Kernel restore notice]\n${parts.join("\n")}`;
}

async function existingExaKey(config: RiemannConfig): Promise<string | undefined> {
	if (config.web.exaApiKey) return expandConfigSecret(config.web.exaApiKey);
	const legacyPath = join(process.env.HOME ?? "", ".pi", "agent", "pi-web.json");
	if (!existsSync(legacyPath)) return undefined;
	try {
		const value: unknown = JSON.parse(await readFile(legacyPath, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if ("exa_api_key" in value && typeof value.exa_api_key === "string") return value.exa_api_key;
		if ("exaApiKey" in value && typeof value.exaApiKey === "string") return value.exaApiKey;
	} catch {
		return undefined;
	}
	return undefined;
}

export class RiemannRuntime {
	private readonly registry = new FunctionRegistry();
	private readonly capabilities: ReadonlySet<string>;
	private readonly mcp: RiemannMcpManager;
	private kernel?: IPythonKernelManager;
	private kernelStartup?: Promise<IPythonKernelManager>;
	private pendingRestoreNotice?: string;
	private closed = false;
	private readonly shared: SharedRun;
	readonly agent: StoredAgent;
	private readonly root: boolean;

	private constructor(shared: SharedRun, agent: StoredAgent, root: boolean, exaApiKey: string | undefined) {
		this.shared = shared;
		this.agent = agent;
		this.root = root;
		this.capabilities = new Set(agent.capabilities);
		const workspace = new WorkspaceFunctions(agent.workspace, shared.run.id, shared.store);
		const shell = new ShellFunctions(
			agent.workspace,
			shared.artifacts,
			shared.config.limits.maxArtifactPreviewChars,
			{
				agentDir: shared.agentDir,
				workspaceWritable: hasCapability(this.capabilities, "workspace.write", "workspace"),
				networkAllowed: hasCapability(this.capabilities, "shell.network", "shell"),
			},
		);
		const web = new WebFunctions(
			shared.config.web.searchBackend === "exa" ? exaApiKey : undefined,
			shared.artifacts,
			shared.config.limits.maxArtifactPreviewChars,
		);
		for (const definition of [...workspace.definitions(), ...shell.definitions(), ...web.definitions()])
			this.registry.register(definition);
		this.mcp = new RiemannMcpManager(shared.config.mcpServers, agent.workspace, this.registry);
		for (const definition of this.mcp.definitions()) this.registry.register(definition);
		for (const definition of shared.supervisor.definitions(agent.id)) this.registry.register(definition);
		for (const definition of this.utilityDefinitions()) this.registry.register(definition);
	}

	static async createRoot(ctx: ExtensionContext): Promise<RiemannRuntime> {
		const agentDir = getRiemannAgentDir();
		const config = await loadRiemannConfig({ cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted() });
		const store = new RiemannStore(agentDir);
		const run = store.openRun(ctx.sessionManager.getSessionId(), ctx.cwd);
		const retentionReport = await applyRetention(store, config.retention);
		const rootAgent = store.ensureRootAgent(run.id, ctx.cwd);
		const artifacts = new ArtifactStore(store, run.id);
		const rootContext = {
			cwd: ctx.cwd,
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			thinkingLevel: ctx.thinkingLevel,
		};
		let shared: SharedRun;
		const supervisor = new AgentSupervisor({
			store,
			artifacts,
			runId: run.id,
			rootAgent,
			rootContext,
			agentDir,
			config,
			createChildRuntime: async (agent) => {
				const child = await RiemannRuntime.createChild(shared, agent);
				return child.asChildRuntime();
			},
		});
		shared = { config, store, artifacts, run, rootAgent, supervisor, agentDir, retentionReport, rootContext };
		return new RiemannRuntime(shared, rootAgent, true, await existingExaKey(config));
	}

	private static async createChild(shared: SharedRun, agent: StoredAgent): Promise<RiemannRuntime> {
		return new RiemannRuntime(shared, agent, false, await existingExaKey(shared.config));
	}

	private async resolveArtifactDestination(input: string): Promise<string> {
		const root = resolve(this.agent.workspace);
		const candidate = resolve(root, input);
		if (!isInside(root, candidate)) {
			throw new RiemannHostError("permission_denied", `Destination is outside the workspace: ${input}`);
		}
		const canonicalRoot = await realpath(root);
		let ancestor = dirname(candidate);
		while (true) {
			try {
				const canonicalAncestor = await realpath(ancestor);
				if (!isInside(canonicalRoot, canonicalAncestor)) {
					throw new RiemannHostError(
						"permission_denied",
						`Destination parent resolves outside the workspace: ${input}`,
					);
				}
				break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				const parent = dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
		await mkdir(dirname(candidate), { recursive: true });
		const canonicalParent = await realpath(dirname(candidate));
		if (!isInside(canonicalRoot, canonicalParent)) {
			throw new RiemannHostError("permission_denied", `Destination parent resolves outside the workspace: ${input}`);
		}
		return candidate;
	}

	private utilityDefinitions(): FunctionDefinition[] {
		return [
			{
				name: "search",
				namespace: "catalog",
				description: "Search registered functions by capability, task, namespace, or parameter description.",
				promptSnippet: "Search available functions by task or capability.",
				parameters: [
					{ name: "query", description: "Capability or task query", type: "str", required: true },
					{ name: "limit", description: "Maximum matches", type: "int | None", required: false },
				],
				returns: "list[dict]",
				handler: async (args) => {
					if (typeof args.query !== "string")
						throw new RiemannHostError("invalid_arguments", "query must be a string");
					const limit = args.limit === undefined || args.limit === null ? 8 : args.limit;
					if (typeof limit !== "number" || !Number.isInteger(limit))
						throw new RiemannHostError("invalid_arguments", "limit must be an integer");
					return this.registry.search(args.query, limit, this.capabilities);
				},
			},
			{
				name: "describe",
				namespace: "catalog",
				description:
					"Describe one exact registered function, including signature, errors, return type, capability, and examples.",
				promptSnippet: "Return an exact function signature, errors, examples, and return type.",
				parameters: [{ name: "name", description: "Qualified function name", type: "str", required: true }],
				returns: "dict",
				handler: async (args) => {
					if (typeof args.name !== "string")
						throw new RiemannHostError("invalid_arguments", "name must be a string");
					return this.registry.describe(args.name, this.capabilities);
				},
			},
			{
				name: "namespaces",
				namespace: "catalog",
				description: "List currently installed Python function namespaces and their function names.",
				promptSnippet: "List installed function namespaces.",
				parameters: [],
				returns: "dict[str,list[str]]",
				handler: async () =>
					Object.fromEntries(
						this.registry
							.namespaces(this.capabilities)
							.map((namespace) => [
								namespace,
								this.registry
									.pythonSpecifications(namespace, this.capabilities)
									.map((specification) => specification.name),
							]),
					),
			},
			{
				name: "get",
				namespace: "artifacts",
				description: "Read a byte or text slice from a durable artifact handle.",
				promptSnippet: "Read a slice of a durable artifact.",
				parameters: [
					{ name: "handle", description: "Artifact handle", type: "str", required: true },
					{ name: "offset", description: "Byte offset", type: "int | None", required: false },
					{ name: "limit", description: "Maximum bytes", type: "int | None", required: false },
				],
				returns: "dict",
				handler: async (args) => {
					if (typeof args.handle !== "string")
						throw new RiemannHostError("invalid_arguments", "handle must be a string");
					const offset = typeof args.offset === "number" ? args.offset : undefined;
					const limit = typeof args.limit === "number" ? args.limit : undefined;
					return this.shared.artifacts.get(args.handle, { offset, limit });
				},
			},
			{
				name: "materialize",
				namespace: "artifacts",
				description: "Copy a durable artifact into the current workspace atomically.",
				promptSnippet: "Copy a durable artifact into the workspace atomically.",
				parameters: [
					{ name: "handle", description: "Artifact handle", type: "str", required: true },
					{ name: "path", description: "Workspace-relative destination", type: "str", required: true },
				],
				returns: "dict",
				capability: "workspace.write",
				handler: async (args) => {
					if (typeof args.handle !== "string" || typeof args.path !== "string") {
						throw new RiemannHostError("invalid_arguments", "handle and path must be strings");
					}
					const destination = await this.resolveArtifactDestination(args.path);
					return this.shared.artifacts.materialize(args.handle, destination);
				},
			},
			{
				name: "checkpoint",
				namespace: "state",
				description: "Confirm that the current cell will be checkpointed atomically after it finishes.",
				promptSnippet: "Confirm the current execution will be checkpointed on completion.",
				parameters: [],
				returns: "dict",
				handler: async () => ({ scheduled: true, timing: "after_current_cell" }),
			},
			{
				name: "status",
				namespace: "state",
				description: "Return durable run, agent, workspace, and configuration metadata.",
				promptSnippet: "Return durable run, agent, workspace, and config metadata.",
				parameters: [],
				returns: "dict",
				handler: async () => ({
					run_id: this.shared.run.id,
					session_id: this.shared.run.sessionId,
					agent_id: this.agent.id,
					agent_name: this.agent.name,
					workspace: this.agent.workspace,
					config_files: this.shared.config.files,
					retention: this.shared.retentionReport as unknown as JsonValue,
				}),
			},
		];
	}

	private availableOperations(): string {
		return this.registry.promptInventory(this.capabilities);
	}

	private operationGuidelines(): string {
		const guidelines = this.registry.promptGuidelines(this.capabilities);
		if (guidelines.length === 0) return "";
		return `## Operation guidance\n\n${guidelines.map((guideline) => `- ${guideline}`).join("\n")}`;
	}

	private agentProfiles(): string {
		if (!hasCapability(this.capabilities, "agents.spawn", "agents")) return "";
		const inventory = this.shared.supervisor.profileInventory(this.agent.id);
		return inventory ? `## Configured agent profiles\n\n${inventory}` : "";
	}

	private exposedMcpServers(): string {
		const inventory = this.mcp.promptInventory(this.capabilities);
		return inventory ? `## Configured MCP servers\n\n${inventory}` : "";
	}

	private durableState(): JsonValue {
		const agents = this.shared.store.listAgents(this.shared.run.id);
		const unread = this.shared.store.listInbox(this.agent.id, { unreadOnly: true });
		return {
			version: 1,
			run: {
				id: this.shared.run.id,
				session_id: this.shared.run.sessionId,
				cwd: this.shared.run.cwd,
			},
			self: {
				id: this.agent.id,
				name: this.agent.name,
				workspace: this.agent.workspace,
			},
			agents: agents.map((agent) => ({
				id: agent.id,
				name: agent.name,
				parent_id: agent.parentId,
				status: agent.status,
				model_role: agent.modelRole,
				workspace: agent.workspace,
				result_available: agent.result !== null,
				error: agent.error,
			})),
			unread_messages: unread.map((message) => ({
				id: message.id,
				sender_id: message.senderId,
				created_at: message.createdAt,
			})),
			compaction: {
				strategy: this.shared.config.compaction.strategy,
			},
			config_files: this.shared.config.files,
		};
	}

	async compact(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		context: Pick<ExtensionContext, "model" | "modelRegistry" | "getSystemPrompt" | "thinkingLevel">,
	): Promise<CompactionResult> {
		const durableState = this.durableState();
		const strategy = this.shared.config.compaction.strategy;
		if (strategy === "openai") {
			return createRiemannOpenAICompaction({
				preparation,
				customInstructions,
				signal,
				context,
				durableState,
				sessionId: this.shared.run.sessionId,
			});
		}
		if (strategy === "snapshot") {
			if (customInstructions !== undefined) {
				throw new Error(
					'compaction.strategy "snapshot" does not support custom instructions; configure strategy "default"',
				);
			}
			return createRiemannSnapshotCompaction({ preparation, signal, context, durableState });
		}
		return createRiemannCompaction({
			preparation,
			customInstructions,
			signal,
			context,
			durableState,
		});
	}

	systemPrompt(kind: "main" | "child"): string {
		const values = {
			environment: formatEnvironmentContext(this.agent.workspace),
			availableOperations: this.availableOperations(),
			agentProfiles: this.agentProfiles(),
			operationGuidelines: this.operationGuidelines(),
			exposedMcpServers: this.exposedMcpServers(),
		};
		if (kind === "main") return renderRiemannPrompt("system/main.md", values);
		const context = JSON.stringify(
			{
				id: this.agent.id,
				name: this.agent.name,
				parentId: this.agent.parentId,
				depth: this.agent.depth,
				workspace: this.agent.workspace,
				modelRole: this.agent.modelRole,
				capabilities: this.agent.capabilities,
			},
			null,
			2,
		);
		return renderRiemannPrompt("system/child.md", { ...values, agentContext: context });
	}

	private async ensureKernel(): Promise<IPythonKernelManager> {
		if (this.closed) throw new Error("Riemann runtime is closed");
		if (this.kernel) return this.kernel;
		this.kernelStartup ??= (async () => {
			const python = await ensureManagedPython();
			const prelude = await readFile(preludePath(), "utf8");
			const specifications = JSON.stringify(this.registry.pythonSpecifications(undefined, this.capabilities));
			const bootstrapCode = `${prelude}\n\n_install_functions(_json.loads(${JSON.stringify(specifications)}))`;
			const kernel = new IPythonKernelManager({
				python,
				cwd: this.agent.workspace,
				sessionId: this.agent.id,
				bootstrapCode,
				hostRequest: (request, signal, onUpdate) =>
					this.registry.dispatch(request, this.capabilities, signal, onUpdate),
				snapshotPath: join(this.shared.store.snapshotsDir, this.agent.id, "kernel.dill"),
				sandbox: {
					agentDir: this.shared.agentDir,
					workspaceWritable: hasCapability(this.capabilities, "workspace.write", "workspace"),
				},
				maxOutputChars: Math.max(this.shared.config.limits.maxCellOutputChars * 4, 400_000),
				onRestore: (result) => {
					this.pendingRestoreNotice = restoreNotice(result);
				},
			});
			await kernel.start();
			this.kernel = kernel;
			return kernel;
		})().catch((error) => {
			this.kernelStartup = undefined;
			throw error;
		});
		return this.kernelStartup;
	}

	private async formatResult(result: KernelExecuteResult): Promise<{ text: string; artifactHandle?: string }> {
		const sections: string[] = [];
		if (this.pendingRestoreNotice) {
			sections.push(this.pendingRestoreNotice);
			this.pendingRestoreNotice = undefined;
		}
		if (result.stdout) sections.push(result.stdout.trimEnd());
		if (result.stderr) sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
		for (const display of result.displays) {
			const text = textFromDisplay(display.data);
			if (text) sections.push(text);
		}
		if (result.result) {
			const text = textFromDisplay(result.result.data);
			if (text) sections.push(text);
		}
		if (result.error) {
			const traceback =
				result.error.traceback.length > 0
					? result.error.traceback.join("\n")
					: `${result.error.ename}: ${result.error.evalue}`;
			sections.push(traceback);
		}
		if (sections.length === 0)
			sections.push(
				`Cell ${result.status === "ok" ? "completed" : result.status} in ${result.durationMs} ms. No explicit output.`,
			);
		const full = sections.join("\n\n");
		const limit = this.shared.config.limits.maxCellOutputChars;
		if (full.length <= limit) return { text: full };
		const artifact = await this.shared.artifacts.putText(full, {
			name: `ipython-cell-${result.executionCount ?? "internal"}.txt`,
		});
		const handle = artifactHandle(artifact);
		return {
			text: `${full.slice(0, limit)}\n\n[Cell output truncated. Full output: ${handle ?? "artifact unavailable"}]`,
			...(handle ? { artifactHandle: handle } : {}),
		};
	}

	toolDefinition(): ToolDefinition<typeof IPythonSchema, IPythonToolDetails> {
		const runtime = this;
		return {
			name: "ipython",
			label: "IPython",
			description: IPYTHON_TOOL_DESCRIPTION,
			promptSnippet: IPYTHON_TOOL_PROMPT_SNIPPET,
			parameters: IPythonSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params, signal, onUpdate) {
				const kernel = await runtime.ensureKernel();
				const timeoutSignal = AbortSignal.timeout((params.timeout ?? 300) * 1_000);
				const executionSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
				const activityTracker = new RiemannActivityTracker(
					runtime.agent.workspace,
					(capability) => runtime.shared.store.getFileCapability(runtime.shared.run.id, capability)?.path,
				);
				let activities: IPythonToolDetails["activities"] = [];
				const result = await kernel.execute(params.code, {
					signal: executionSignal,
					onHostRequest: async (event) => {
						const next = await activityTracker.observe(event);
						if (!next) return;
						activities = next;
						onUpdate?.({
							content: [],
							details: {
								status: "running",
								durationMs: undefined,
								activities,
							},
						});
					},
				});
				const snapshot = await kernel.snapshot();
				if (snapshot.error) runtime.pendingRestoreNotice = `[Checkpoint warning] ${snapshot.error}`;
				const formatted = await runtime.formatResult(result);
				return {
					content: [{ type: "text", text: formatted.text }],
					details: {
						status: result.status,
						durationMs: result.durationMs,
						...(result.error ? { errorName: result.error.ename } : {}),
						...(result.executionCount === undefined ? {} : { executionCount: result.executionCount }),
						...(formatted.artifactHandle ? { artifactHandle: formatted.artifactHandle } : {}),
						...(activities.length > 0 ? { activities } : {}),
					},
				};
			},
		};
	}

	private asChildRuntime(): ChildRiemannRuntime {
		return {
			tool: this.toolDefinition(),
			systemPrompt: this.systemPrompt("child"),
			compact: (preparation, customInstructions, signal, context) =>
				this.compact(preparation, customInstructions, signal, context),
			snapshot: async () => {
				await this.snapshot();
			},
			close: () => this.close(),
		};
	}

	async snapshot(): Promise<void> {
		if (this.kernel) await this.kernel.snapshot();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.root) await this.shared.supervisor.close();
		await this.kernel?.snapshot().catch(() => undefined);
		await this.kernel?.close().catch(() => undefined);
		await this.mcp.close();
		if (this.root) {
			this.shared.store.closeRun(this.shared.run.id);
			this.shared.store.close();
		}
	}
}
