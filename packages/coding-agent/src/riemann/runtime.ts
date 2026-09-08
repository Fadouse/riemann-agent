import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type AgentMessage, AgentToolExecutionError } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { getPackageDir, isBunBinary } from "../config.ts";
import type { CompactionPreparation, CompactionResult } from "../core/compaction/index.ts";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { assertWritable, fileAccessPolicy, resolveFilesystemSnapshot } from "./access-policy.ts";
import { RiemannActivityTracker } from "./activity.ts";
import {
	type AgentEventDelivery,
	AgentSupervisor,
	type ChildRiemannRuntime,
	type CompactionWarningSink,
	type SubagentUiSnapshot,
} from "./agents/supervisor.ts";
import { type PythonCell, PythonCells, parsePythonExec } from "./code-mode.ts";
import { PYTHON_CODE_MODE_BOOTSTRAP } from "./code-mode-python.ts";
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
import {
	type FunctionDefinition,
	FunctionRegistry,
	hasCapability,
	OperationSpecSchema,
	OperationSummarySchema,
} from "./functions/registry.ts";
import { ShellFunctions } from "./functions/shell.ts";
import { WebFunctions } from "./functions/web.ts";
import { storeModelImage } from "./images.ts";
import {
	IPYTHON_TOOL_METADATA,
	IPYTHON_WAIT_TOOL_METADATA,
	type IPythonSchema,
	type IPythonToolDetails,
	type IPythonWaitSchema,
} from "./ipython.ts";
import { IPythonKernelManager } from "./kernel/manager.ts";
import {
	isKernelHostResult,
	type JsonValue,
	type KernelDisplay,
	type KernelExecuteResult,
	type KernelImageReference,
	type KernelModelContent,
	type KernelRestoreResult,
	kernelHostResult,
} from "./kernel/types.ts";
import { RiemannMcpManager } from "./mcp/manager.ts";
import { createRiemannOpenAICompaction } from "./openai-compaction.ts";
import { type OutputPart, OutputViews, renderModelText, utf8Prefix } from "./output.ts";
import { renderRiemannPrompt } from "./prompts.ts";
import { ensureManagedPython } from "./python/runtime.ts";
import { ArtifactStore } from "./state/artifacts.ts";
import { PageStore, pageSchema } from "./state/pages.ts";
import { OUTPUT_VIEW_MIME, RESULT_MIME } from "./state/references.ts";
import type { RetentionReport } from "./state/retention.ts";
import { RiemannStore, type StoredAgent, type StoredRun } from "./state/store.ts";

const MAX_MODEL_IMAGES = 8;
const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
type RuntimeUpdate = Parameters<ToolDefinition<typeof IPythonWaitSchema, IPythonToolDetails>["execute"]>[3];

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
	if (data["application/vnd.riemann.error+json"] !== undefined) return undefined;
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

async function retainDisplay(artifacts: ArtifactStore, display: KernelDisplay): Promise<KernelModelContent[]> {
	const handle = artifactHandle(
		await artifacts.putJson({ data: display.data, metadata: display.metadata }, "python-display.json"),
	);
	const content: KernelModelContent[] = [{ type: "text", text: `[source ${handle}]` }];
	const text = textFromDisplay(display.data);
	if (text) {
		const retained = artifactHandle(await artifacts.putText(text, { name: "python-display.txt" }));
		if (retained) content.push({ type: "output_ref", handle: retained });
	}
	const rawImage = imageFromDisplay(display.data);
	if (rawImage) {
		try {
			const image = await storeModelImage({ artifacts, bytes: rawImage.bytes, claimedMimeType: rawImage.mimeType });
			content.push(image.reference);
		} catch (error) {
			content.push({
				type: "text",
				text: `Image display failed; original display retained at ${handle}: ${String(error)}`,
			});
		}
	}
	return content;
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
	private readonly pages: PageStore;
	private readonly artifacts: ArtifactStore;
	private readonly outputViews: OutputViews;
	private readonly cells = new PythonCells();
	private readonly shell: ShellFunctions;
	private kernel?: IPythonKernelManager;
	private kernelStartup?: Promise<IPythonKernelManager>;
	private pendingRestoreNotice?: string;
	private checkpointIncompatible = false;
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
		this.artifacts = shared.artifacts.forAgent(agent.id);
		this.outputViews = new OutputViews(this.artifacts);
		this.pages = new PageStore(this.artifacts, agent.id);
		const files = new FileFunctions(policy, shared.run.id, shared.store, this.artifacts, this.pages);
		const shell = new ShellFunctions(policy, this.artifacts, agent.network === "allow");
		this.shell = shell;
		this.web = new WebFunctions(
			shared.config.web.searchBackend === "exa" ? exaApiKey : undefined,
			this.artifacts,
			shared.config.limits.maxPreviewBytes,
			undefined,
			undefined,
			this.pages,
		);
		for (const definition of [...files.definitions(), ...shell.definitions(), ...this.web.definitions()])
			this.registry.register(definition);
		this.mcp = new RiemannMcpManager(
			shared.config.mcpServers,
			agent.workspace,
			this.registry,
			this.artifacts,
			this.capabilities,
		);
		for (const definition of this.mcp.definitions()) this.registry.register(definition);
		for (const definition of shared.supervisor.definitions(agent.id, this.pages)) this.registry.register(definition);
		for (const definition of this.utilityDefinitions()) this.registry.register(definition);
	}

	static async createRoot(ctx: ExtensionContext, options: RiemannRootOptions = {}): Promise<RiemannRuntime> {
		const agentDir = getRiemannAgentDir();
		const configLoadOptions = { cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted() };
		const config = await loadRiemannConfig(configLoadOptions);
		const store = new RiemannStore(agentDir);
		const run = store.openRun(ctx.sessionManager.getSessionId(), ctx.cwd);
		// Closing a run does not invalidate references in a resumable session.
		const retentionReport: RetentionReport = {
			removedRunIds: [],
			freedArtifactBytes: 0,
			freedSnapshotBytes: 0,
			freedWorktreeBytes: 0,
			errors: [],
		};
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
		const artifactSchema = Type.Object(
			{
				$riemann: Type.Literal("artifact"),
				handle: Type.String(),
				mime_type: Type.String(),
				size: Type.Integer({ minimum: 0 }),
				name: Type.Union([Type.String(), Type.Null()]),
			},
			{ additionalProperties: false, $id: "Ref" },
		);
		const filesystemFieldSchema = Type.Union([Type.Array(Type.String()), Type.Literal("inherit")]);
		const filesystemConfigSchema = Type.Object(
			{
				read: Type.Optional(filesystemFieldSchema),
				read_exclude: Type.Optional(filesystemFieldSchema),
				write: Type.Optional(filesystemFieldSchema),
				write_exclude: Type.Optional(filesystemFieldSchema),
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
					},
					{ additionalProperties: false },
				),
				outputSchema: pageSchema(OperationSummarySchema),
				pythonReturnType: "Page[OperationSummary]",
				errors: [{ code: "invalid_arguments", description: "The query or limit is invalid.", retryable: false }],
				effects: [
					{ kind: "read", resource: "function-registry" },
					{ kind: "write", resource: "artifact-store" },
				],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Search available functions by task or capability.",
					example: 'await catalog.search(query="workspace write")',
				},
				handler: async (args) => {
					if (typeof args.query !== "string")
						throw new RiemannHostError("invalid_arguments", "query must be a string");
					return this.pages.create("catalog.search", this.registry.searchAll(args.query, this.capabilities), {
						coverage: "complete",
					});
				},
			},
			{
				name: "describe",
				namespace: "catalog",
				description:
					"Describe one exact registered function, including schemas, defaults, errors, effects, and execution semantics.",
				inputSchema: Type.Object(
					{
						name: Type.String({ minLength: 1, description: "Qualified operation, type, or handle method" }),
						detail: Type.Optional(
							Type.Union([Type.Literal("usage"), Type.Literal("schema")], { default: "usage" }),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: OperationSpecSchema,
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
					return this.registry.describe(
						args.name,
						this.capabilities,
						args.detail === "schema" ? "schema" : "usage",
					);
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
					const source = this.artifacts.assertPublic(args.handle);
					const image = await storeModelImage({
						artifacts: this.artifacts,
						bytes: await this.artifacts.readBuffer(args.handle),
						claimedMimeType: source.mimeType,
						...(source.name ? { name: source.name } : {}),
					});
					return kernelHostResult(
						{
							$riemann: "image_snapshot",
							kind: "image",
							path: null,
							artifact: image.artifact,
							mime_type: image.sourceMimeType,
							source_size: source.size,
							_capability: null,
							width: null,
							height: null,
						},
						[{ type: "text", text: `[image ${image.reference.artifactHandle}]` }, image.reference],
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
					{
						$riemann: Type.Literal("materialized_artifact"),
						path: Type.String(),
						size: Type.Integer({ minimum: 0 }),
						handle: Type.String(),
					},
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
					let handle = args.handle;
					const metadata = this.artifacts.getMetadata(handle);
					if (metadata.mimeType === RESULT_MIME) handle = (await this.artifacts.readResult(handle)).value_ref;
					else if (metadata.mimeType === OUTPUT_VIEW_MIME) {
						const text = await this.outputViews.text(handle);
						const retained = await this.artifacts.putText(text.text, { name: "materialized-output.txt" });
						handle = artifactHandle(retained)!;
					}
					const result = await this.artifacts.materialize(handle, destination);
					return typeof result === "object" && result !== null && !Array.isArray(result)
						? { ...result, handle: args.handle }
						: result;
				},
			},
			{
				name: "next",
				namespace: "pages",
				description: "Read the next retained page from a durable result snapshot.",
				inputSchema: Type.Object({ cursor: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
				outputSchema: pageSchema(Type.Unknown()),
				pythonReturnType: "Page",
				errors: [
					{
						code: "invalid_arguments",
						description: "The cursor is invalid or belongs to another agent.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "read", resource: "result-snapshot" },
					{ kind: "write", resource: "artifact-store" },
				],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "handle-method",
				prompt: { inventory: "Continue a result snapshot.", example: "page = await page.next()" },
				handler: async (args) => {
					if (typeof args.cursor !== "string")
						throw new RiemannHostError("invalid_arguments", "cursor must be a string");
					return this.pages.next(args.cursor, (operation) => {
						const definition = this.registry.get(operation);
						if (
							!definition ||
							(definition.capability &&
								!hasCapability(this.capabilities, definition.capability, definition.namespace))
						) {
							throw new RiemannHostError("permission_denied", "The source operation is no longer available");
						}
					});
				},
			},
			{
				name: "read",
				namespace: "references",
				description:
					"Read a retained value into Python. Text spans are reference-relative UTF-8 byte intervals [start,end).",
				inputSchema: Type.Object(
					{
						handle: Type.String({ minLength: 1 }),
						span: Type.Optional(
							Type.Tuple([
								Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
								Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
							]),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: Type.Unknown(),
				pythonReturnType: "JSON",
				errors: [{ code: "not_found", description: "Unknown reference", retryable: false }],
				effects: [{ kind: "read", resource: "artifact-store" }],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "handle-method",
				prompt: { inventory: "Read a reference", example: 'value = await refs["r1"].read()' },
				handler: async (args): Promise<JsonValue> => {
					if (typeof args.handle !== "string")
						throw new RiemannHostError("invalid_arguments", "Expected reference");
					const span = Array.isArray(args.span) ? (args.span as [number, number]) : undefined;
					const metadata = this.artifacts.getMetadata(args.handle);
					if (metadata.mimeType === RESULT_MIME && !span) {
						const retained = await this.artifacts.readResult(args.handle);
						const value: JsonValue = JSON.parse(
							(await this.artifacts.readBuffer(retained.value_ref)).toString("utf8"),
						);
						return { kind: "value", value, schema: retained.schema, return_type: retained.return_type };
					}
					if (
						metadata.mimeType === OUTPUT_VIEW_MIME ||
						metadata.mimeType === RESULT_MIME ||
						metadata.mimeType.startsWith("text/") ||
						metadata.mimeType.includes("json") ||
						metadata.mimeType.includes("xml")
					) {
						return { kind: "text", ...(await this.outputViews.text(args.handle, span)) };
					}
					this.artifacts.assertPublic(args.handle);
					const [start, end] = span ?? [0, metadata.size];
					if (start > end || end > metadata.size)
						throw new RiemannHostError("invalid_arguments", "span must be within the reference");
					const slice = await this.artifacts.get(args.handle, { offset: start, limit: end - start });
					if (!slice || typeof slice !== "object" || Array.isArray(slice) || typeof slice.base64 !== "string")
						throw new RiemannHostError("artifact_error", "Invalid binary slice");
					return { kind: "binary", base64: slice.base64 };
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
						contract_fingerprint: Type.Union([Type.String(), Type.Null()]),
						checkpoint: Type.Object(
							{
								state: Type.Union([
									Type.Literal("not_started"),
									Type.Literal("ready"),
									Type.Literal("incompatible"),
								]),
							},
							{ additionalProperties: false },
						),
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
								removed_run_ids: Type.Array(Type.String()),
								freed_artifact_bytes: Type.Integer({ minimum: 0 }),
								freed_snapshot_bytes: Type.Integer({ minimum: 0 }),
								freed_worktree_bytes: Type.Integer({ minimum: 0 }),
								errors: Type.Array(
									Type.Object(
										{ run_id: Type.String(), message: Type.String() },
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
					const defaults = this.shared.config.agentDefaults;
					const filesystem = defaults.filesystem;
					return {
						observed_at: new Date().toISOString(),
						contract_fingerprint: this.kernel?.contractFingerprint ?? null,
						checkpoint: {
							state: !this.kernel ? "not_started" : this.checkpointIncompatible ? "incompatible" : "ready",
						},
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
						subagent_defaults: {
							workspace: defaults.workspace,
							network: defaults.network,
							...(defaults.model === undefined ? {} : { model: defaults.model }),
							...(filesystem
								? {
										filesystem: {
											...(filesystem.read ? { read: filesystem.read } : {}),
											...(filesystem.readExclude ? { read_exclude: filesystem.readExclude } : {}),
											...(filesystem.write ? { write: filesystem.write } : {}),
											...(filesystem.writeExclude ? { write_exclude: filesystem.writeExclude } : {}),
										},
									}
								: {}),
						},
						agent_slots: {
							max: this.shared.config.maxAgents,
							max_concurrent: this.shared.config.maxConcurrentAgents,
							used: children.length,
							running: children.filter((agent) => agent.status === "running").length,
							queued: children.filter((agent) => agent.status === "queued").length,
						},
						retention: {
							removed_run_ids: this.shared.retentionReport.removedRunIds,
							freed_artifact_bytes: this.shared.retentionReport.freedArtifactBytes,
							freed_snapshot_bytes: this.shared.retentionReport.freedSnapshotBytes,
							freed_worktree_bytes: this.shared.retentionReport.freedWorktreeBytes,
							errors: this.shared.retentionReport.errors.map((error) => ({
								run_id: error.runId,
								message: error.message,
							})),
						},
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
			? `## Configured MCP servers\n\nInside \`ipython\`, \`await mcp.open(name=...)\` returns a Python namespace.\n\n${inventory}`
			: "";
	}

	private durableState(compaction: CompactionDispatch): JsonValue {
		const agents = this.shared.store.listAgents(this.shared.run.id);
		const pendingEvents = this.shared.store.listPendingAgentEvents(this.agent.id);
		const accessibleReference = (handle: string | null): string | null => {
			if (!handle) return null;
			try {
				const ref = this.shared.artifacts.reference(handle);
				this.artifacts.getMetadata(ref);
				return ref;
			} catch (error) {
				if (error instanceof RiemannHostError && ["not_found", "permission_denied"].includes(error.code))
					return null;
				throw error;
			}
		};
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
				transcript_handle: accessibleReference(agent.transcriptHandle),
				patch_handle: accessibleReference(agent.patchHandle),
			})),
			pending_agent_events: pendingEvents.map((event) => event.id),
			python_cell: this.cells.pending,
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
		const resolution = resolveCompactionStrategy(configured, dispatchContext.model, {
			usingOAuth: dispatchContext.model ? dispatchContext.modelRegistry.isUsingOAuth(dispatchContext.model) : false,
			// Experimental resets are owned by AgentSession, before ordinary compaction preparation.
			supportsExperimentalContext: false,
		});
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

	/** Rebuild live host context without summarizing or altering the kernel/environment. */
	async initialCodexContext(): Promise<{ systemPrompt: string; messages: AgentMessage[] }> {
		const configured = (await loadRiemannConfig(this.shared.configLoadOptions)).compaction.strategy;
		const state = this.durableState({ configured, effective: "experimental", reason: "configured" });
		const text = `<riemann_state>\n${JSON.stringify(state, null, 2)}\n</riemann_state>`;
		return {
			systemPrompt: this.systemPrompt(this.root ? "main" : "child").replace(
				"Model tools: `ipython` and `ipython_wait`.",
				"Model tools: `ipython` and `ipython_wait`. Native model-only `history`, `notes`, `new_context`, and `get_context_remaining` tools are also available directly; never call them through Python.",
			),
			messages: [
				{
					role: "user",
					content: [],
					timestamp: Date.now(),
					providerPayload: {
						type: "openaiResponsesHistory",
						items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }],
					},
				},
			],
		};
	}

	systemPrompt(kind: "main" | "child"): string {
		const values = {
			environment: `${formatEnvironmentContext(this.agent.workspace)}\n- Effective policy: ${JSON.stringify({ filesystem: { read: [...this.policy.readRoots], read_exclude: [...this.policy.readExcludes], write: [...this.policy.writeRoots], write_exclude: [...this.policy.writeExcludes] }, network: this.agent.network })}`,
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
			const bootstrapCode = `${prelude}\n\n_configure_runtime(_json.loads(${JSON.stringify(JSON.stringify(this.shared.config.limits))}))\n_install_functions(_json.loads(${JSON.stringify(specifications)}))\n${PYTHON_CODE_MODE_BOOTSTRAP}`;
			const kernel = new IPythonKernelManager({
				python,
				env: environment,
				cwd: this.agent.workspace,
				sessionId: this.agent.id,
				bootstrapCode,
				contractFingerprint: createHash("sha256")
					.update(prelude)
					.update(specifications)
					.update(PYTHON_CODE_MODE_BOOTSTRAP)
					.digest("hex"),
				hostRequest: async (request, signal, onUpdate) => {
					let ref: string | undefined;
					const result = await this.registry.dispatch(
						request,
						this.capabilities,
						signal,
						onUpdate,
						async (value) => {
							if (value !== null && request.operation !== "references.read") {
								const definition = this.registry.get(request.operation)!;
								ref = await this.artifacts.putResult(
									value,
									JSON.parse(JSON.stringify(definition.outputSchema)) as JsonValue,
									definition.pythonReturnType,
									request.operation,
								);
							}
							return ref;
						},
					);
					if (!ref) return result;
					return kernelHostResult(isKernelHostResult(result) ? result.value : result, [
						...(isKernelHostResult(result) ? result.modelContent : []),
						{ type: "text", text: `[result ${request.operation} ${ref}]` },
					]);
				},
				snapshotPath: join(this.shared.store.snapshotsDir, this.agent.id, "kernel.dill"),
				migrateCodeState: true,
				sandbox: { policy: this.policy, networkAllowed: this.agent.network === "allow" },
				retainOutput: async (output) => {
					if ("stream" in output) {
						const artifact = await this.artifacts.putText(output.text, { name: `python-${output.stream}.txt` });
						const handle = artifactHandle(artifact);
						if (!handle) throw new RiemannHostError("artifact_error", "Python output has no reference");
						return [{ type: "output_ref", handle, separator: output.stream === "stderr" ? "\n[stderr]\n" : "" }];
					}
					if (output.data["application/vnd.riemann.migration+json"] !== undefined) {
						const legacy = await this.artifacts.putJson(
							output.data["application/vnd.riemann.migration+json"],
							"legacy-store.json",
						);
						return [
							{
								type: "text",
								text: `Previous store data retained at ${artifactHandle(legacy)}; read with refs.`,
							},
						];
					}
					if (output.data["application/vnd.riemann.print+json"] !== undefined)
						return this.outputViews.print(output.data["application/vnd.riemann.print+json"]);
					return retainDisplay(this.artifacts, output);
				},
				onRestore: (result) => {
					this.checkpointIncompatible = result.incompatible === true;
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

	private async formatResult(
		result: KernelExecuteResult,
		header: string,
	): Promise<{
		content: Array<TextContent | ImageContent>;
		moreRef?: string;
		diagnosticRef?: string;
		error?: string;
		media?: IPythonToolDetails["media"];
	}> {
		const sections: OutputPart[] = [];
		const imageReferences: KernelImageReference[] = [];
		if (result.captureTruncated) {
			const streams = Object.entries(result.captureTruncated)
				.filter(([, truncated]) => truncated)
				.map(([kind]) => kind);
			sections.push(`[Capture incomplete: ${streams.join(", ")}; recovery contains retained output only]`);
		}
		if (this.pendingRestoreNotice) {
			sections.push(this.pendingRestoreNotice);
			this.pendingRestoreNotice = undefined;
		}
		if (result.stdout) sections.push(result.stdout);
		if (result.stderr) sections.push(`[stderr]\n${result.stderr}`);
		const modelContent: KernelModelContent[] = [];
		for (const display of [...result.displays, ...(result.result ? [result.result] : [])]) {
			modelContent.push(...(await retainDisplay(this.artifacts, display)));
		}
		modelContent.push(...result.modelContent);
		const shownReferences = new Set<string>();
		for (const content of modelContent) {
			if (content.type === "text") {
				// Only coalesce framework reference notices, never explicit output or payloads.
				if (/^\[(?:source|result|image) (?:[\w.]+ )?r[0-9a-z]+\]$/.test(content.text)) {
					if (shownReferences.has(content.text)) continue;
					shownReferences.add(content.text);
				}
				sections.push(content.text);
			} else if (content.type === "output_ref") sections.push(content);
			else if (this.root) imageReferences.push(content);
			else
				sections.push(
					`Image content [${content.mimeType}; reference ${content.artifactHandle}; not displayed in child Agent context]`,
				);
		}
		let diagnosticRef: string | undefined;
		if (result.error) {
			const prefix = result.error.code
				? `${result.error.operation ?? "ipython"} [${result.error.code}]: `
				: `${result.error.ename}: `;
			const summary = result.error.evalue.startsWith(prefix) ? result.error.evalue : prefix + result.error.evalue;
			const traceback = stripAnsi(result.error.traceback.join("\n"));
			const location = [...traceback.matchAll(/File ["']?<python-cell>["']?(?::|, line )(\d+)/g)].at(-1)?.[1];
			const repair = `${location && !summary.includes("<python-cell>") ? `\nAt <python-cell>:${location}` : ""}${result.error.repairCode ? `\nUse: ${result.error.repairCode}` : ""}`;
			const diagnostic = `${summary}${repair}\n${traceback}${result.error.details === undefined ? "" : `\nHost details:\n${JSON.stringify(result.error.details)}`}`;
			const formatted = await this.errorOutput(summary, diagnostic, repair);
			diagnosticRef = formatted.ref;
			sections.unshift(formatted.text);
		}
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
				sections.push(
					`[image ${image.artifactHandle}; deferred, use await refs["${image.artifactHandle}"].view()]`,
				);
				continue;
			}
			selectedImages.push(image);
			selectedImageBytes += image.byteLength;
		}
		if (omittedImages > 0) sections.push(`[${omittedImages} image(s) omitted by model-context budget]`);
		const rendered = await renderModelText(this.outputViews, [sections.length ? `${header}\n` : header, ...sections]);
		const text = rendered.text;
		const content: Array<TextContent | ImageContent> = [{ type: "text", text }];
		for (const image of selectedImages) {
			const bytes = await this.artifacts.readBuffer(image.artifactHandle);
			content.push({
				type: "image",
				data: bytes.toString("base64"),
				mimeType: image.mimeType,
				...(image.detail ? { detail: image.detail } : {}),
			});
		}
		return {
			content,
			...(rendered.more ? { moreRef: rendered.more } : {}),
			...(diagnosticRef ? { diagnosticRef } : {}),
			...(rendered.error ? { error: rendered.error } : {}),
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
				if (signal?.aborted) throw signal.reason;
				let options: ReturnType<typeof parsePythonExec>;
				try {
					options = parsePythonExec(params.code);
				} catch (error) {
					return runtime.toolFailure(error, "ipython", "invalid_arguments");
				}
				let cellId: string;
				try {
					cellId = runtime.cells.start(options, async (cell) => {
						const kernel = await raceWithAbortSignal(runtime.ensureKernel(), cell.signal);
						cell.peek = () => kernel.peek();
						const activityTracker = new RiemannActivityTracker(
							runtime.agent.workspace,
							(capability) => runtime.shared.store.getFileCapability(runtime.shared.run.id, capability)?.path,
							(operation) => runtime.registry.get(operation)?.pythonReturnType === "McpResult",
							(agentId) => {
								const child = runtime.shared.store.getAgent(agentId);
								return child?.runId === runtime.shared.run.id && child.parentId === runtime.agent.id
									? child.name
									: undefined;
							},
						);
						let activities: IPythonToolDetails["activities"] = [];
						// Exclude managed-Python/kernel startup. Keep the same dispatch timestamp
						// through host updates and the final result; durationMs remains kernel-authoritative.
						const startedAt = Date.now();
						cell.details = { status: "running", startedAt, cellId: cell.id, activities };
						cell.notify();
						const result = await kernel.execute(`await _riemann_exec_source(${JSON.stringify(params.code)})`, {
							signal: cell.signal,
							outputOrder: "arrival",
							onOutput: cell.notify,
							onHostRequest: async (event) => {
								const next = await activityTracker.observe(event);
								if (!next) return;
								activities = next;
								cell.details.activities = activities;
								cell.notify();
							},
						});
						return result;
					});
				} catch (error) {
					return runtime.toolFailure(error);
				}
				try {
					return await runtime.collectCell(cellId, false, signal, onUpdate, true);
				} catch (error) {
					if (signal?.aborted) runtime.cells.cancel(cellId);
					return runtime.toolFailure(error);
				}
			},
		};
	}

	waitToolDefinition(): ToolDefinition<typeof IPythonWaitSchema, IPythonToolDetails> {
		return {
			...IPYTHON_WAIT_TOOL_METADATA,
			execute: async (_id, params, signal, onUpdate) =>
				this.collectCell(params.id, params.terminate ?? false, signal, onUpdate).catch((error: unknown) =>
					this.toolFailure(error, "ipython_wait"),
				),
		};
	}

	private async errorOutput(
		summary: string,
		diagnostic: string,
		repair = "",
	): Promise<{ text: string; ref?: string }> {
		try {
			const ref = artifactHandle(await this.artifacts.putText(diagnostic, { name: "ipython-error.txt" }));
			if (!ref) throw new Error("Diagnostic reference missing");
			const firstLine = summary.split("\n", 1)[0];
			const preview = utf8Prefix(firstLine, this.shared.config.limits.maxPreviewBytes);
			return { text: `${preview}${preview === summary ? "" : "…"}${repair}\n[details=${ref}]`, ref };
		} catch (error) {
			// If archival fails, keep the original diagnostic in the final output path.
			return {
				text: `${diagnostic}\n[Diagnostic unavailable: ${error instanceof Error ? error.message : String(error)}]`,
			};
		}
	}

	private async toolFailure(error: unknown, operation = "ipython", code = "runtime_error"): Promise<never> {
		if (error instanceof AgentToolExecutionError) throw error;
		const summary =
			error instanceof RiemannHostError
				? `${operation} [${error.code}]: ${error.message}${error.recovery === "none" ? "" : ` (recovery=${error.recovery})`}`
				: error instanceof Error
					? `${operation} [${code}]: ${error.name === "Error" ? "" : `${error.name}: `}${error.message}`
					: `${operation} [${code}]: ${String(error)}`;
		const diagnostic = `${summary}\n${error instanceof Error ? (error.stack ?? "") : ""}${error instanceof RiemannHostError && error.details !== undefined ? `\nHost details:\n${JSON.stringify(error.details)}` : ""}`;
		const formatted = await this.errorOutput(summary, diagnostic);
		const rendered = await renderModelText(this.outputViews, [formatted.text]);
		throw new AgentToolExecutionError({
			content: [{ type: "text", text: rendered.text }],
			details: {
				status: "error",
				...(formatted.ref ? { diagnosticRef: formatted.ref } : {}),
				...(rendered.more ? { moreRef: rendered.more } : {}),
			},
		});
	}

	private async collectCell(
		cellId: string,
		terminate: boolean,
		signal?: AbortSignal,
		onUpdate?: RuntimeUpdate,
		initial = false,
	) {
		const tasks = this.cells.has(cellId) ? this.cells : this.shell.tasks;
		const unobserve = tasks.observe(cellId, (details) =>
			onUpdate?.({ content: [], details: { ...details, status: "running" } }),
		);
		try {
			const outcome = await tasks.poll(
				cellId,
				initial ? 10000 : undefined,
				terminate,
				signal,
				async (result, running, cell: PythonCell) => {
					const status = result.status;
					const header = running ? `running id=${cellId}; use ipython_wait; do not rerun` : status;
					const formatted = await this.formatResult(result, header);
					return {
						content: formatted.content,
						details: {
							...cell.details,
							status: running ? ("running" as const) : status,
							cellId,
							durationMs: result.durationMs,
							...(result.captureTruncated ? { captureTruncated: result.captureTruncated } : {}),
							...(result.error
								? {
										errorName: result.error.ename,
										...(result.error.code ? { errorCode: result.error.code } : {}),
									}
								: {}),
							...(result.executionCount === undefined ? {} : { executionCount: result.executionCount }),
							...(formatted.moreRef ? { moreRef: formatted.moreRef } : {}),
							...(formatted.diagnosticRef ? { diagnosticRef: formatted.diagnosticRef } : {}),
							...(formatted.media ? { media: formatted.media } : {}),
						},
					};
				},
			);
			if (outcome.details.status !== "ok" && outcome.details.status !== "running")
				throw new AgentToolExecutionError(outcome);
			return outcome;
		} finally {
			unobserve();
		}
	}

	private asChildRuntime(): ChildRiemannRuntime {
		return {
			tool: this.toolDefinition(),
			waitTool: this.waitToolDefinition(),
			systemPrompt: this.systemPrompt("child"),
			initialCodexContext: () => this.initialCodexContext(),
			compact: (preparation, customInstructions, signal, context) =>
				this.compact(preparation, customInstructions, signal, context),
			snapshot: async () => {
				if (this.cells.active)
					throw new Error("Child returned before collecting its Python cell with ipython_wait");
				await this.snapshot();
			},
			close: () => this.close(),
		};
	}

	async snapshot(): Promise<void> {
		if (this.kernel && !this.cells.executing) {
			const result = await this.kernel.snapshot();
			if (result.error || result.skipped.length > 0)
				this.pendingRestoreNotice = `[Checkpoint warning] ${JSON.stringify(result)}`;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.cells.close();
		await this.shell.tasks.close();
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
