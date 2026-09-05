import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getPackageDir, isBunBinary } from "../config.ts";
import type { CompactionPreparation, CompactionResult } from "../core/compaction/index.ts";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { assertWritable, fileAccessPolicy, resolveFilesystemSnapshot } from "./access-policy.ts";
import { RiemannActivityTracker } from "./activity.ts";
import {
	type AgentEventDelivery,
	AgentSupervisor,
	type ChildRiemannRuntime,
	type CompactionWarningSink,
	type SubagentUiSnapshot,
} from "./agents/supervisor.ts";
import { createRiemannCompaction, createRiemannSnapshotCompaction } from "./compaction.ts";
import { type CompactionStrategyResolution, resolveCompactionStrategy } from "./compaction-strategy.ts";
import {
	type AgentNetworkPolicy,
	expandConfigSecret,
	getRiemannAgentDir,
	loadRiemannConfig,
	type RiemannConfig,
} from "./config.ts";
import { formatEnvironmentContext } from "./environment.ts";
import { RiemannHostError } from "./errors.ts";
import { FileFunctions } from "./functions/fs.ts";
import { type FunctionDefinition, FunctionRegistry, hasCapability } from "./functions/registry.ts";
import { ShellFunctions } from "./functions/shell.ts";
import { WebFunctions } from "./functions/web.ts";
import { storeModelImage } from "./images.ts";
import { IPYTHON_TOOL_METADATA, type IPythonSchema, type IPythonToolDetails } from "./ipython.ts";
import { IPythonKernelManager } from "./kernel/manager.ts";
import {
	type JsonValue,
	type KernelExecuteResult,
	type KernelImageReference,
	type KernelRestoreResult,
	kernelHostResult,
} from "./kernel/types.ts";
import { RiemannMcpManager } from "./mcp/manager.ts";
import { createRiemannOpenAICompaction } from "./openai-compaction.ts";
import { renderRiemannPrompt } from "./prompts.ts";
import { ensureManagedPython } from "./python/runtime.ts";
import { ArtifactStore } from "./state/artifacts.ts";
import { applyRetention, type RetentionReport } from "./state/retention.ts";
import { RiemannStore, type StoredAgent, type StoredRun } from "./state/store.ts";

const MAX_MODEL_IMAGES = 8;
const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;

interface SharedRun {
	config: RiemannConfig;
	configLoadOptions: {
		cwd: string;
		agentDir: string;
		projectTrusted: boolean;
	};

	store: RiemannStore;
	artifacts: ArtifactStore;
	run: StoredRun;
	rootAgent: StoredAgent;
	supervisor: AgentSupervisor;
	agentDir: string;
	retentionReport: RetentionReport;
	rootContext: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "thinkingLevel">;
}

export interface RiemannRootOptions {
	deliverAgentEvents?: (delivery: AgentEventDelivery) => Promise<void>;
	warningSink?: CompactionWarningSink;
}

interface CompactionDispatch extends CompactionStrategyResolution {
	reason: "configured" | "automatic-openai-codex" | "automatic-default";
}

function preludePath(): string {
	const packageDir = getPackageDir();
	if (isBunBinary) return join(packageDir, "riemann-python", "prelude.py");
	const source = join(packageDir, "src", "riemann", "python", "prelude.py");
	return existsSync(source) ? source : join(packageDir, "dist", "riemann", "python", "prelude.py");
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

function imageFromDisplay(data: Record<string, JsonValue>): { mimeType: string; bytes: Buffer } | undefined {
	for (const mimeType of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
		const encoded = data[mimeType];
		if (typeof encoded !== "string") continue;
		return { mimeType, bytes: Buffer.from(encoded.replace(/\s/g, ""), "base64") };
	}
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
	private readonly policy: ReturnType<typeof fileAccessPolicy>;
	private readonly mcp: RiemannMcpManager;
	private readonly web: WebFunctions;
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
		this.policy = fileAccessPolicy(agent.workspace, agent.filesystem);
		const policy = this.policy;
		const files = new FileFunctions(policy, shared.run.id, shared.store, shared.artifacts);
		const shell = new ShellFunctions(
			policy,
			shared.artifacts,
			shared.config.limits.maxArtifactPreviewChars,
			agent.network === "allow",
		);
		this.web = new WebFunctions(
			shared.config.web.searchBackend === "exa" ? exaApiKey : undefined,
			shared.artifacts,
			shared.config.limits.maxArtifactPreviewChars,
		);
		for (const definition of [...files.definitions(), ...shell.definitions(), ...this.web.definitions()])
			this.registry.register(definition);
		this.mcp = new RiemannMcpManager(
			shared.config.mcpServers,
			agent.workspace,
			this.registry,
			shared.artifacts,
			this.capabilities,
		);
		for (const definition of this.mcp.definitions()) this.registry.register(definition);
		for (const definition of shared.supervisor.definitions(agent.id)) this.registry.register(definition);
		for (const definition of this.utilityDefinitions()) this.registry.register(definition);
	}

	static async createRoot(ctx: ExtensionContext, options: RiemannRootOptions = {}): Promise<RiemannRuntime> {
		const agentDir = getRiemannAgentDir();
		const configLoadOptions = { cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted() };
		const config = await loadRiemannConfig(configLoadOptions);
		const store = new RiemannStore(agentDir);
		const run = store.openRun(ctx.sessionManager.getSessionId(), ctx.cwd);
		const retentionReport = await applyRetention(store, config.retention);
		const mainFilesystem = resolveFilesystemSnapshot({
			config: config.mainAgent.filesystem,
			mode: "main",
			workspace: ctx.cwd,
			parent: undefined,
		});
		const mainNetwork = config.mainAgent.network === "allow" ? "allow" : "deny";
		const rootAgent = store.ensureRootAgent(run.id, ctx.cwd, mainFilesystem, mainNetwork);
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
			projectTrusted: configLoadOptions.projectTrusted,
			config,
			deliverAgentEvents: options.deliverAgentEvents,
			warningSink: options.warningSink,
			createChildRuntime: async (agent) => {
				const child = await RiemannRuntime.createChild(shared, agent);
				return child.asChildRuntime();
			},
		});
		shared = {
			config,
			configLoadOptions,
			store,
			artifacts,
			run,
			rootAgent,
			supervisor,
			agentDir,
			retentionReport,
			rootContext,
		};
		return new RiemannRuntime(shared, rootAgent, true, await existingExaKey(config));
	}

	private static async createChild(shared: SharedRun, agent: StoredAgent): Promise<RiemannRuntime> {
		return new RiemannRuntime(shared, agent, false, await existingExaKey(shared.config));
	}

	updateRootContext(ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">): void {
		if (!this.root) return;
		this.shared.rootContext.model = ctx.model;
		this.shared.rootContext.modelRegistry = ctx.modelRegistry;
		this.shared.rootContext.thinkingLevel = ctx.thinkingLevel;
	}

	listSubagentsForUi(): SubagentUiSnapshot[] {
		if (!this.root) return [];
		return this.shared.supervisor.listSubagentsForUi();
	}

	subscribeSubagentUi(listener: () => void): () => void {
		if (!this.root) return () => undefined;
		return this.shared.supervisor.subscribeSubagentUi(listener);
	}

	async steerSubagentFromUi(agentId: string, message: string): Promise<void> {
		if (!this.root) throw new RiemannHostError("permission_denied", "Only the root runtime can steer Subagents");
		await this.shared.supervisor.steerSubagentFromUi(agentId, message);
	}

	async stopSubagentFromUi(agentId: string): Promise<void> {
		if (!this.root) throw new RiemannHostError("permission_denied", "Only the root runtime can stop Subagents");
		await this.shared.supervisor.stopSubagentFromUi(agentId);
	}

	async releaseSubagentFromUi(agentId: string): Promise<void> {
		if (!this.root) throw new RiemannHostError("permission_denied", "Only the root runtime can release Subagents");
		await this.shared.supervisor.releaseSubagentFromUi(agentId);
	}

	async flushAgentEvents(): Promise<void> {
		if (!this.root) return;
		await this.shared.supervisor.flushAgentEvents();
	}

	private async resolveArtifactDestination(input: string): Promise<string> {
		const candidate = resolve(this.policy.cwd, input);
		assertWritable(this.policy, candidate, input);
		let ancestor = dirname(candidate);
		while (true) {
			try {
				const canonical = await realpath(ancestor);
				assertWritable(this.policy, canonical, input);
				break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				const parent = dirname(ancestor);
				if (parent === ancestor) throw error;
				ancestor = parent;
			}
		}
		await mkdir(dirname(candidate), { recursive: true });
		const parent = await realpath(dirname(candidate));
		assertWritable(this.policy, parent, input);
		return candidate;
	}

	private utilityDefinitions(): FunctionDefinition[] {
		const noCancellation = {
			supported: false,
			description: "The operation completes synchronously or does not observe cancellation.",
		} as const;
		const errorSchema = Type.Object(
			{ code: Type.String(), description: Type.String(), retryable: Type.Boolean() },
			{ additionalProperties: false },
		);
		const effectSchema = Type.Object(
			{ kind: Type.String(), resource: Type.String() },
			{ additionalProperties: false },
		);
		const cancellationSchema = Type.Object(
			{ supported: Type.Boolean(), description: Type.String() },
			{ additionalProperties: false },
		);
		const jsonObjectSchema = Type.Object({}, { additionalProperties: true });
		const artifactSchema = Type.Object(
			{
				$riemann: Type.Literal("artifact"),
				handle: Type.String(),
				mime_type: Type.String(),
				size: Type.Integer({ minimum: 0 }),
				name: Type.Union([Type.String(), Type.Null()]),
			},
			{ additionalProperties: false },
		);
		const artifactSliceProperties = {
			handle: Type.String(),
			mime_type: Type.String(),
			size: Type.Integer({ minimum: 0 }),
			offset: Type.Integer({ minimum: 0 }),
			next_offset: Type.Integer({ minimum: 0 }),
			truncated: Type.Boolean(),
		};
		const filesystemFieldSchema = Type.Union([Type.Array(Type.String()), Type.Literal("inherit")]);
		const filesystemConfigSchema = Type.Object(
			{
				read: Type.Optional(filesystemFieldSchema),
				readExclude: Type.Optional(filesystemFieldSchema),
				write: Type.Optional(filesystemFieldSchema),
				writeExclude: Type.Optional(filesystemFieldSchema),
			},
			{ additionalProperties: false },
		);
		return [
			{
				name: "search",
				namespace: "catalog",
				description: "Search registered functions by capability, task, namespace, or input description.",
				inputSchema: Type.Object(
					{
						query: Type.String({ description: "Capability or task query" }),
						limit: Type.Optional(
							Type.Integer({ minimum: 1, maximum: 50, default: 8, description: "Maximum matches" }),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: Type.Array(
					Type.Object(
						{
							name: Type.String(),
							description: Type.String(),
							pythonReturnType: Type.String(),
							capability: Type.Union([Type.String(), Type.Null()]),
						},
						{ additionalProperties: false },
					),
				),
				pythonReturnType: "list[OperationSummary]",
				errors: [{ code: "invalid_arguments", description: "The query or limit is invalid.", retryable: false }],
				effects: [{ kind: "read", resource: "function-registry" }],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Search available functions by task or capability.",
					example: 'await catalog.search(query="workspace write", limit=8)',
				},
				handler: async (args) => {
					if (typeof args.query !== "string")
						throw new RiemannHostError("invalid_arguments", "query must be a string");
					const limit = args.limit === undefined || args.limit === null ? 8 : args.limit;
					if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
						throw new RiemannHostError("invalid_arguments", "limit must be an integer from 1 to 50");
					}
					return this.registry.search(args.query, limit, this.capabilities);
				},
			},
			{
				name: "describe",
				namespace: "catalog",
				description:
					"Describe one exact registered function, including schemas, defaults, errors, effects, and execution semantics.",
				inputSchema: Type.Object(
					{ name: Type.String({ minLength: 1, description: "Qualified function name" }) },
					{ additionalProperties: false },
				),
				outputSchema: Type.Object(
					{
						name: Type.String(),
						description: Type.String(),
						inputSchema: jsonObjectSchema,
						outputSchema: jsonObjectSchema,
						defaults: jsonObjectSchema,
						pythonReturnType: Type.String(),
						errors: Type.Array(errorSchema),
						effects: Type.Array(effectSchema),
						idempotency: Type.Union([
							Type.Literal("idempotent"),
							Type.Literal("non-idempotent"),
							Type.Literal("conditional"),
						]),
						cancellation: cancellationSchema,
						capability: Type.Union([Type.String(), Type.Null()]),
						example: Type.String(),
					},
					{ additionalProperties: false },
				),
				pythonReturnType: "OperationSpec",
				errors: [
					{ code: "not_found", description: "The function is hidden, unavailable, or unknown.", retryable: false },
				],
				effects: [{ kind: "read", resource: "function-registry" }],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Return exact schemas and execution metadata for one function.",
					example: 'await catalog.describe(name="fs.read")',
				},
				handler: async (args) => {
					if (typeof args.name !== "string")
						throw new RiemannHostError("invalid_arguments", "name must be a string");
					return this.registry.describe(args.name, this.capabilities);
				},
			},
			{
				name: "open",
				namespace: "artifacts",
				description:
					"Resolve a durable artifact handle to an Artifact object with read, materialize, and view methods.",
				inputSchema: Type.Object(
					{ handle: Type.String({ minLength: 1, description: "Artifact handle" }) },
					{ additionalProperties: false },
				),
				outputSchema: artifactSchema,
				pythonReturnType: "Artifact",
				errors: [{ code: "not_found", description: "The artifact handle does not exist.", retryable: false }],
				effects: [{ kind: "read", resource: "artifact-metadata" }],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Resolve a durable artifact handle.",
					example: 'artifact = await artifacts.open(handle="artifact://...")',
				},
				handler: async (args) => {
					if (typeof args.handle !== "string") {
						throw new RiemannHostError("invalid_arguments", "handle must be a string");
					}
					const artifact = this.shared.artifacts.getMetadata(args.handle);
					return {
						$riemann: "artifact",
						handle: artifact.handle,
						mime_type: artifact.mimeType,
						size: artifact.size,
						name: artifact.name,
					};
				},
			},
			{
				name: "get",
				namespace: "artifacts",
				description: "Read a byte or text slice from a durable artifact handle.",
				inputSchema: Type.Object(
					{
						handle: Type.String({ minLength: 1, description: "Artifact handle" }),
						offset: Type.Optional(
							Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], { description: "Byte offset" }),
						),
						limit: Type.Optional(
							Type.Union([Type.Integer({ minimum: 1, maximum: 1_048_576 }), Type.Null()], {
								description: "Maximum bytes; defaults to 65536",
							}),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: Type.Union([
					Type.Object({ ...artifactSliceProperties, content: Type.String() }, { additionalProperties: false }),
					Type.Object({ ...artifactSliceProperties, base64: Type.String() }, { additionalProperties: false }),
				]),
				pythonReturnType: "ArtifactSlice",
				errors: [{ code: "not_found", description: "The artifact handle does not exist.", retryable: false }],
				effects: [{ kind: "read", resource: "artifact-store" }],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "handle-method",
				prompt: {
					inventory: "Read a slice of a durable artifact.",
					example: "await artifact.read(offset=0, limit=4096)",
				},
				handler: async (args) => {
					if (typeof args.handle !== "string")
						throw new RiemannHostError("invalid_arguments", "handle must be a string");
					const offset = typeof args.offset === "number" ? args.offset : undefined;
					const limit = typeof args.limit === "number" ? args.limit : undefined;
					return this.shared.artifacts.get(args.handle, { offset, limit });
				},
			},
			{
				name: "view",
				namespace: "artifacts",
				description: "Load an image artifact into the current model context.",
				inputSchema: Type.Object(
					{ handle: Type.String({ minLength: 1, description: "Image artifact handle" }) },
					{ additionalProperties: false },
				),
				outputSchema: Type.Object(
					{
						$riemann: Type.Literal("image_snapshot"),
						kind: Type.Literal("image"),
						path: Type.Null(),
						artifact: artifactSchema,
						mime_type: Type.String(),
						source_size: Type.Integer({ minimum: 0 }),
						_capability: Type.Null(),
						width: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
						height: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
					},
					{ additionalProperties: false },
				),
				pythonReturnType: "ImageSnapshot",
				errors: [
					{ code: "not_found", description: "The artifact handle does not exist.", retryable: false },
					{
						code: "unsupported_media_type",
						description: "The artifact is not a supported image.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "read", resource: "artifact-store" },
					{ kind: "write", resource: "model-context" },
				],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "handle-method",
				prompt: {
					inventory: "Load an image artifact into the current model context.",
					example: "await artifact.view()",
				},
				handler: async (args) => {
					if (typeof args.handle !== "string")
						throw new RiemannHostError("invalid_arguments", "handle must be a string");
					const source = this.shared.artifacts.getMetadata(args.handle);
					const image = await storeModelImage({
						artifacts: this.shared.artifacts,
						bytes: await this.shared.artifacts.readBuffer(args.handle),
						claimedMimeType: source.mimeType,
						...(source.name ? { name: source.name } : {}),
					});
					return kernelHostResult(
						{
							$riemann: "image_snapshot",
							kind: "image",
							path: null,
							artifact: image.artifact,
							mime_type: image.reference.mimeType,
							source_size: source.size,
							_capability: null,
							width: null,
							height: null,
						},
						[{ type: "text", text: `Viewed image artifact [${image.reference.mimeType}]` }, image.reference],
					);
				},
			},
			{
				name: "materialize",
				namespace: "artifacts",
				description: "Copy a durable artifact into the current workspace atomically.",
				inputSchema: Type.Object(
					{
						handle: Type.String({ minLength: 1, description: "Artifact handle" }),
						path: Type.String({ minLength: 1, description: "Workspace-relative destination" }),
					},
					{ additionalProperties: false },
				),
				outputSchema: Type.Object(
					{ path: Type.String(), size: Type.Integer({ minimum: 0 }), handle: Type.String() },
					{ additionalProperties: false },
				),
				pythonReturnType: "MaterializedArtifact",
				errors: [
					{ code: "not_found", description: "The artifact handle does not exist.", retryable: false },
					{ code: "permission_denied", description: "The destination is not writable.", retryable: false },
				],
				effects: [
					{ kind: "read", resource: "artifact-store" },
					{ kind: "write", resource: "workspace" },
				],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "handle-method",
				prompt: {
					inventory: "Copy a durable artifact into the workspace atomically.",
					example: 'await artifact.materialize(path="results/report.txt")',
				},
				capability: "fs.write",
				handler: async (args) => {
					if (typeof args.handle !== "string" || typeof args.path !== "string") {
						throw new RiemannHostError("invalid_arguments", "handle and path must be strings");
					}
					const destination = await this.resolveArtifactDestination(args.path);
					return this.shared.artifacts.materialize(args.handle, destination);
				},
			},
			{
				name: "status",
				namespace: "state",
				description: "Return durable run, agent, workspace, and configuration metadata.",
				inputSchema: Type.Object({}, { additionalProperties: false }),
				outputSchema: Type.Object(
					{
						observed_at: Type.String(),
						run_id: Type.String(),
						session_id: Type.String(),
						agent_id: Type.String(),
						agent_name: Type.String(),
						workspace: Type.String(),
						network: Type.Object(
							{
								configured: Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("inherit")]),
								effective: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
								source: Type.String(),
							},
							{ additionalProperties: false },
						),
						configuration: Type.Object(
							{ freshness: Type.Literal("startup-snapshot"), files: Type.Array(Type.String()) },
							{ additionalProperties: false },
						),
						filesystem: Type.Object(
							{
								backend: Type.Union([
									Type.Literal("bubblewrap-v1"),
									Type.Literal("seatbelt-v1"),
									Type.Literal("unsupported"),
								]),
								cwd: Type.String(),
								read: Type.Array(Type.String()),
								read_exclude: Type.Array(Type.String()),
								write: Type.Array(Type.String()),
								write_exclude: Type.Array(Type.String()),
								semantics: Type.Object(
									{
										write_requires_read: Type.Literal(true),
										read_exclude_denies_write: Type.Literal(true),
										same_path_mounts: Type.Literal(true),
									},
									{ additionalProperties: false },
								),
							},
							{ additionalProperties: false },
						),
						subagent_defaults: Type.Object(
							{
								workspace: Type.Union([Type.Literal("shared"), Type.Literal("worktree")]),
								filesystem: Type.Optional(filesystemConfigSchema),
								model: Type.Optional(Type.String()),
								network: Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("inherit")]),
							},
							{ additionalProperties: false },
						),
						agent_slots: Type.Object(
							{
								max: Type.Integer(),
								max_concurrent: Type.Integer(),
								used: Type.Integer({ minimum: 0 }),
								running: Type.Integer({ minimum: 0 }),
								queued: Type.Integer({ minimum: 0 }),
							},
							{ additionalProperties: false },
						),
						retention: Type.Object(
							{
								removedRunIds: Type.Array(Type.String()),
								freedArtifactBytes: Type.Integer({ minimum: 0 }),
								freedSnapshotBytes: Type.Integer({ minimum: 0 }),
								freedWorktreeBytes: Type.Integer({ minimum: 0 }),
								errors: Type.Array(
									Type.Object(
										{ runId: Type.String(), message: Type.String() },
										{ additionalProperties: false },
									),
								),
							},
							{ additionalProperties: false },
						),
					},
					{ additionalProperties: false },
				),
				pythonReturnType: "RuntimeStatus",
				errors: [],
				effects: [
					{ kind: "read", resource: "run-state" },
					{ kind: "read", resource: "configuration" },
				],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Return durable run, agent, workspace, and config metadata.",
					example: "await state.status()",
				},
				handler: async () => {
					const children = this.shared.store
						.listAgents(this.shared.run.id)
						.filter((agent) => agent.parentId !== null);
					return {
						observed_at: new Date().toISOString(),
						run_id: this.shared.run.id,
						session_id: this.shared.run.sessionId,
						agent_id: this.agent.id,
						agent_name: this.agent.name,
						workspace: this.agent.workspace,
						network: this.networkStatus(),
						configuration: { freshness: "startup-snapshot", files: this.shared.config.files },
						filesystem: {
							backend:
								process.platform === "linux"
									? "bubblewrap-v1"
									: process.platform === "darwin"
										? "seatbelt-v1"
										: "unsupported",
							cwd: this.policy.cwd,
							read: [...this.policy.readRoots],
							read_exclude: [...this.policy.readExcludes],
							write: [...this.policy.writeRoots],
							write_exclude: [...this.policy.writeExcludes],
							semantics: {
								write_requires_read: true,
								read_exclude_denies_write: true,
								same_path_mounts: true,
							},
						},
						subagent_defaults: this.shared.config.agentDefaults,
						agent_slots: {
							max: this.shared.config.maxAgents,
							max_concurrent: this.shared.config.maxConcurrentAgents,
							used: children.length,
							running: children.filter((agent) => agent.status === "running").length,
							queued: children.filter((agent) => agent.status === "queued").length,
						},
						retention: this.shared.retentionReport as unknown as JsonValue,
					};
				},
			},
		];
	}

	private networkStatus(): {
		configured: AgentNetworkPolicy;
		effective: "allow" | "deny";
		source: "builtin" | "main" | "defaults" | `profile:${string}` | "parent";
	} {
		if (this.root) {
			const configured = this.shared.config.mainAgent.network;
			return {
				configured,
				effective: this.agent.network,
				source: configured === "inherit" ? "builtin" : "main",
			};
		}
		const profile =
			this.agent.modelRole === "inherit" ? undefined : this.shared.config.profiles[this.agent.modelRole];
		const configured = profile?.network ?? this.shared.config.agentDefaults.network;
		return {
			configured,
			effective: this.agent.network,
			source:
				configured === "inherit"
					? "parent"
					: profile?.network !== undefined
						? `profile:${this.agent.modelRole}`
						: "defaults",
		};
	}

	private pythonNamespaceInventory(): string {
		return this.registry.promptInventory(this.capabilities);
	}

	private operationGuidelines(): string {
		const guidelines = [
			'Use `await catalog.describe(name="...")` when an exact contract is needed.',
			...this.registry.promptGuidelines(this.capabilities),
		];
		return `## Python operation discipline\n\n${guidelines.map((guideline) => `- ${guideline}`).join("\n")}`;
	}

	private agentProfiles(): string {
		if (!hasCapability(this.capabilities, "agents.start", "agents")) return "";
		const inventory = this.shared.supervisor.profileInventory(this.agent.id);
		return inventory
			? `## Configured agent profiles\n\n\`profile\` selects an optional configured policy bundle. Use an exact key below; express the child role and objective in \`task\`.\n\n${inventory}`
			: "";
	}

	private exposedMcpServers(): string {
		const inventory = this.mcp.promptInventory(this.capabilities);
		return inventory
			? `## Configured MCP servers\n\nInside \`ipython.code\`, \`await mcp.open(name=...)\` returns a Python namespace.\n\n${inventory}`
			: "";
	}

	private durableState(compaction: CompactionDispatch): JsonValue {
		const agents = this.shared.store.listAgents(this.shared.run.id);
		const pendingEvents = this.shared.store.listPendingAgentEvents(this.agent.id);
		return {
			run: {
				id: this.shared.run.id,
				session_id: this.shared.run.sessionId,
				cwd: this.shared.run.cwd,
			},
			self: {
				id: this.agent.id,
				name: this.agent.name,
			},
			agents: agents.map((agent) => ({
				id: agent.id,
				name: agent.name,
				parent_id: agent.parentId,
				status: agent.status,
				active_turn_id: agent.activeTurnId,
				last_turn_id: agent.lastTurnId,
				last_outcome: agent.lastOutcome,
				result_available: agent.result !== null,
				transcript_handle: agent.transcriptHandle,
				patch_handle: agent.patchHandle,
			})),
			pending_agent_events: pendingEvents.map((event) => event.id),
			compaction: {
				configured: compaction.configured,
				effective: compaction.effective,
				reason: compaction.reason,
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
		const configured = (await loadRiemannConfig(this.shared.configLoadOptions)).compaction.strategy;
		const dispatchContext = {
			model: context.model,
			modelRegistry: context.modelRegistry,
			getSystemPrompt: context.getSystemPrompt,
			thinkingLevel: context.thinkingLevel,
		};
		const resolution = resolveCompactionStrategy(configured, dispatchContext.model);
		const dispatch: CompactionDispatch = {
			...resolution,
			reason:
				configured !== "automatic"
					? "configured"
					: resolution.effective === "openai"
						? "automatic-openai-codex"
						: "automatic-default",
		};
		const durableState = this.durableState(dispatch);
		let result: CompactionResult;
		if (dispatch.effective === "openai") {
			result = await createRiemannOpenAICompaction({
				preparation,
				customInstructions,
				signal,
				context: dispatchContext,
				durableState,
				sessionId: this.shared.run.sessionId,
			});
		} else if (dispatch.effective === "snapshot") {
			if (customInstructions !== undefined) {
				throw new Error(
					'compaction.strategy "snapshot" does not support custom instructions; configure strategy "default"',
				);
			}
			result = await createRiemannSnapshotCompaction({
				preparation,
				signal,
				context: dispatchContext,
				durableState,
			});
		} else {
			result = await createRiemannCompaction({
				preparation,
				includeImages: this.root,
				customInstructions,
				signal,
				context: dispatchContext,
				durableState,
			});
		}
		const resultDetails =
			typeof result.details === "object" && result.details !== null && !Array.isArray(result.details)
				? result.details
				: {};
		return { ...result, details: { ...resultDetails, ...dispatch } };
	}

	systemPrompt(kind: "main" | "child"): string {
		const values = {
			environment: formatEnvironmentContext(this.agent.workspace),
			pythonNamespaceInventory: this.pythonNamespaceInventory(),
			runtimeSections: [this.operationGuidelines(), this.agentProfiles(), this.exposedMcpServers()]
				.filter(Boolean)
				.join("\n\n"),
		};
		if (kind === "main") return renderRiemannPrompt("system/main.md", values);
		const context = JSON.stringify(
			{
				id: this.agent.id,
				name: this.agent.name,
				parentId: this.agent.parentId,
				depth: this.agent.depth,
				workspace: this.agent.workspace,
				workspaceMode: this.agent.workspaceMode,
				modelRole: this.agent.modelRole,
				capabilities: this.agent.capabilities,
				network: this.networkStatus(),
				filesystem: {
					cwd: this.policy.cwd,
					read: [...this.policy.readRoots],
					readExclude: [...this.policy.readExcludes],
					write: [...this.policy.writeRoots],
					writeExclude: [...this.policy.writeExcludes],
				},
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
			const { python, environment } = await ensureManagedPython();
			const prelude = await readFile(preludePath(), "utf8");
			const specifications = JSON.stringify(this.registry.pythonSpecifications(undefined, this.capabilities));
			const bootstrapCode = `${prelude}\n\n_install_functions(_json.loads(${JSON.stringify(specifications)}))`;
			const kernel = new IPythonKernelManager({
				python,
				env: environment,
				cwd: this.agent.workspace,
				sessionId: this.agent.id,
				bootstrapCode,
				hostRequest: (request, signal, onUpdate) =>
					this.registry.dispatch(request, this.capabilities, signal, onUpdate),
				snapshotPath: join(this.shared.store.snapshotsDir, this.agent.id, "kernel.dill"),
				sandbox: { policy: this.policy, networkAllowed: this.agent.network === "allow" },
				maxOutputChars: Math.max(this.shared.config.limits.maxCellOutputChars * 4, 400_000),
				onRestore: (result) => {
					this.pendingRestoreNotice = restoreNotice(result);
				},
			});
			await kernel.start();
			if (this.closed) {
				await kernel.close().catch(() => undefined);
				throw new Error("Riemann runtime closed during IPython startup");
			}
			this.kernel = kernel;
			return kernel;
		})().catch((error) => {
			this.kernelStartup = undefined;
			throw error;
		});
		return this.kernelStartup;
	}

	private async formatResult(result: KernelExecuteResult): Promise<{
		content: Array<TextContent | ImageContent>;
		artifactHandle?: string;
		media?: IPythonToolDetails["media"];
	}> {
		const sections: string[] = [];
		const imageReferences: KernelImageReference[] = [];
		if (this.pendingRestoreNotice) {
			sections.push(this.pendingRestoreNotice);
			this.pendingRestoreNotice = undefined;
		}
		if (result.stdout) sections.push(result.stdout.trimEnd());
		if (result.stderr) sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
		let displayIndex = 0;
		for (const display of result.displays) {
			const text = textFromDisplay(display.data);
			if (text) sections.push(text);
			const rawImage = imageFromDisplay(display.data);
			if (rawImage) {
				if (!this.root) {
					sections.push(`Displayed image [${rawImage.mimeType}; omitted from child Agent context]`);
					continue;
				}
				displayIndex += 1;
				const image = await storeModelImage({
					artifacts: this.shared.artifacts,
					bytes: rawImage.bytes,
					claimedMimeType: rawImage.mimeType,
					name: `ipython-display-${result.executionCount ?? "internal"}-${displayIndex}`,
				});
				imageReferences.push(image.reference);
				sections.push(`Displayed image [${image.reference.mimeType}]`);
			}
		}
		if (result.result) {
			const text = textFromDisplay(result.result.data);
			if (text) sections.push(text);
			const rawImage = imageFromDisplay(result.result.data);
			if (rawImage) {
				if (!this.root) {
					sections.push(`Returned image [${rawImage.mimeType}; omitted from child Agent context]`);
				} else {
					const image = await storeModelImage({
						artifacts: this.shared.artifacts,
						bytes: rawImage.bytes,
						claimedMimeType: rawImage.mimeType,
						name: `ipython-result-${result.executionCount ?? "internal"}`,
					});
					imageReferences.push(image.reference);
					sections.push(`Returned image [${image.reference.mimeType}]`);
				}
			}
		}
		for (const content of result.modelContent) {
			if (content.type === "text") sections.push(content.text);
			else if (this.root) imageReferences.push(content);
			else sections.push(`Image content [${content.mimeType}; omitted from child Agent context]`);
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
		const selectedImages: KernelImageReference[] = [];
		const seenImages = new Set<string>();
		let selectedImageBytes = 0;
		let omittedImages = 0;
		for (const image of imageReferences) {
			if (seenImages.has(image.artifactHandle)) continue;
			seenImages.add(image.artifactHandle);
			if (
				selectedImages.length >= MAX_MODEL_IMAGES ||
				selectedImageBytes + image.byteLength > MAX_MODEL_IMAGE_BYTES
			) {
				omittedImages += 1;
				continue;
			}
			selectedImages.push(image);
			selectedImageBytes += image.byteLength;
		}
		if (omittedImages > 0) sections.push(`[${omittedImages} image(s) omitted by model-context budget]`);
		const full = sections.join("\n\n");
		const limit = this.shared.config.limits.maxCellOutputChars;
		let text = full;
		let artifactHandleValue: string | undefined;
		if (full.length > limit) {
			const artifact = await this.shared.artifacts.putText(full, {
				name: `ipython-cell-${result.executionCount ?? "internal"}.txt`,
			});
			artifactHandleValue = artifactHandle(artifact);
			text = `${full.slice(0, limit)}\n\n[Cell output truncated. Recover with: artifact = await artifacts.open(handle=${JSON.stringify(artifactHandleValue ?? "artifact unavailable")}); chunk = await artifact.read(offset=0, limit=65536)]`;
		}
		const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
		for (const image of selectedImages) {
			const bytes = await this.shared.artifacts.readBuffer(image.artifactHandle);
			content.push({
				type: "image",
				data: bytes.toString("base64"),
				mimeType: image.mimeType,
				...(image.detail ? { detail: image.detail } : {}),
			});
		}
		return {
			content,
			...(artifactHandleValue ? { artifactHandle: artifactHandleValue } : {}),
			...(selectedImages.length > 0
				? {
						media: selectedImages.map((image) => ({
							type: "image" as const,
							artifactHandle: image.artifactHandle,
							mimeType: image.mimeType,
							byteLength: image.byteLength,
						})),
					}
				: {}),
		};
	}

	toolDefinition(): ToolDefinition<typeof IPythonSchema, IPythonToolDetails> {
		const runtime = this;
		return {
			...IPYTHON_TOOL_METADATA,
			async execute(_toolCallId, params, signal, onUpdate) {
				const timeoutSignal = AbortSignal.timeout((params.timeout ?? 300) * 1_000);
				const executionSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
				const kernel = await raceWithAbortSignal(runtime.ensureKernel(), executionSignal);
				const activityTracker = new RiemannActivityTracker(
					runtime.agent.workspace,
					(capability) => runtime.shared.store.getFileCapability(runtime.shared.run.id, capability)?.path,
					(operation) => runtime.registry.get(operation)?.pythonReturnType === "McpResult",
				);
				let activities: IPythonToolDetails["activities"] = [];
				// Exclude managed-Python/kernel startup. Keep the same dispatch timestamp
				// through host updates and the final result; durationMs remains kernel-authoritative.
				const startedAt = Date.now();
				onUpdate?.({ content: [], details: { status: "running", startedAt, activities } });
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
								startedAt,
								durationMs: undefined,
								activities,
							},
						});
					},
				});
				if (result.status !== "cancelled" && result.status !== "timeout") {
					const snapshot = await kernel.snapshot(AbortSignal.any([timeoutSignal, AbortSignal.timeout(30_000)]));
					if (snapshot.error) runtime.pendingRestoreNotice = `[Checkpoint warning] ${snapshot.error}`;
				}
				const formatted = await runtime.formatResult(result);
				return {
					content: formatted.content,
					details: {
						status: result.status,
						startedAt,
						durationMs: result.durationMs,
						...(result.error ? { errorName: result.error.ename } : {}),
						...(result.executionCount === undefined ? {} : { executionCount: result.executionCount }),
						...(formatted.artifactHandle ? { artifactHandle: formatted.artifactHandle } : {}),
						...(formatted.media ? { media: formatted.media } : {}),
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
		const startingKernel = await this.kernelStartup?.catch(() => undefined);
		const kernel = this.kernel ?? startingKernel;
		await kernel?.snapshot().catch(() => undefined);
		await kernel?.close().catch(() => undefined);
		await this.mcp.close();
		await this.web.close();
		if (this.root) {
			this.shared.store.closeRun(this.shared.run.id);
			this.shared.store.close();
		}
	}
}
