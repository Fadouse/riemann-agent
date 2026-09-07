import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import type { McpServerConfig } from "../config.ts";
import { expandConfigSecret } from "../config.ts";
import { RiemannHostError } from "../errors.ts";
import { remainingExecutionMs } from "../execution.ts";
import {
	type FunctionDefinition,
	type FunctionRegistry,
	hasCapability,
	type PythonFunctionSpecification,
} from "../functions/registry.ts";
import { storeModelImage } from "../images.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { ArtifactStore } from "../state/artifacts.ts";

type McpCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface McpServerState {
	name: string;
	status: "idle" | "connecting" | "ready" | "failed" | "closed";
	tools: Tool[];
	client?: Client;
	transport?: Transport;
	error?: string;
	stderr?: string;
	namespace?: string;
	functionNames?: string[];
	lifecycle?: object;
	closing?: Promise<void>;
}

const RESERVED_NAMESPACES = new Set([
	"fs",
	"shell",
	"web",
	"artifacts",
	"agents",
	"mcp",
	"catalog",
	"state",
	"output",
	"pages",
	"MaterializedArtifact",
	"Page",
	"PathEntry",
	"ArtifactSlice",
	"SearchMatch",
	"OperationSpec",
	"OperationSummary",
	"RuntimeStatus",
	"McpNamespace",
	"FileSnapshot",
	"Artifact",
	"TextSnapshot",
	"ImageSnapshot",
	"ProcessResult",
	"SearchHit",
	"Document",
	"RemovedFile",
	"McpResult",
	"AgentInfo",
	"AgentResult",
	"AgentTurnHandle",
	"McpServerStatus",
	"RiemannError",
	"ConflictError",
	"ApprovalRequired",
	"NotFoundError",
	"LimitExceededError",
	"PermissionDeniedError",
	"RiemannTimeoutError",
	"CancelledError",
	"UnavailableError",
]);
const MCP_NAMESPACE_METHODS = new Set(["status", "refresh", "close"]);
const PYTHON_KEYWORDS = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
]);

const McpResultSchema = Type.Object(
	{
		$riemann: Type.Literal("mcp_result"),
		content: Type.Array(Type.Any()),
		structured_content: Type.Any(),
		metadata: Type.Any(),
		artifacts: Type.Array(Type.Any()),
		extensions: Type.Record(Type.String(), Type.Any()),
	},
	{ additionalProperties: false },
);
const FunctionBundleSchema = Type.Object(
	{
		$riemann: Type.Literal("function_bundle"),
		namespace: Type.String(),
		server_name: Type.String(),
		specifications: Type.Array(Type.Any()),
	},
	{ additionalProperties: false },
);

const McpServerStatusSchema = Type.Object(
	{
		$riemann: Type.Literal("mcp_server_status"),
		name: Type.String(),
		namespace: Type.String(),
		status: Type.Union([
			Type.Literal("idle"),
			Type.Literal("connecting"),
			Type.Literal("ready"),
			Type.Literal("failed"),
			Type.Literal("closed"),
		]),
		tool_count: Type.Integer({ minimum: 0 }),
		error: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false },
);

function safeIdentifier(value: string): string {
	const normalized = value
		.replace(/[^A-Za-z0-9_]+/g, "_")
		.replace(/^([^A-Za-z_])/, "_$1")
		.replace(/_+/g, "_");
	const identifier = normalized || "tool";
	return PYTHON_KEYWORDS.has(identifier) ? `${identifier}_` : identifier;
}

function asJson(value: unknown): JsonValue {
	const serialized = JSON.stringify(value, (_key, item: unknown) =>
		typeof item === "bigint" ? item.toString() : item,
	);
	if (serialized === undefined) return null;
	return JSON.parse(serialized) as JsonValue;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class RiemannMcpManager {
	private readonly states = new Map<string, McpServerState>();
	private readonly startups = new Map<
		string,
		{ controller: AbortController; promise: Promise<McpServerState>; waiters: number }
	>();
	private closed = false;
	private readonly configs: Record<string, McpServerConfig>;
	private readonly cwd: string;
	private readonly artifacts: ArtifactStore;
	private readonly registry: FunctionRegistry;
	private readonly capabilities: ReadonlySet<string>;

	constructor(
		configs: Record<string, McpServerConfig>,
		cwd: string,
		registry: FunctionRegistry,
		artifacts: ArtifactStore,
		capabilities: ReadonlySet<string>,
	) {
		this.configs = configs;
		this.cwd = cwd;
		this.registry = registry;
		this.artifacts = artifacts;
		this.capabilities = capabilities;
		const enabledNames = Object.entries(configs)
			.filter(([, config]) => config.enabled !== false)
			.map(([name]) => name)
			.sort();
		const counts = new Map<string, number>();
		for (const name of enabledNames) {
			const normalized = safeIdentifier(name);
			counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
		}
		const canUsePlain = (normalized: string): boolean =>
			!normalized.startsWith("_") && !RESERVED_NAMESPACES.has(normalized) && (counts.get(normalized) ?? 0) === 1;
		const reservedCandidates = new Set(
			enabledNames.map((name) => safeIdentifier(name)).filter((normalized) => canUsePlain(normalized)),
		);
		const used = new Set<string>();
		for (const name of enabledNames) {
			const normalized = safeIdentifier(name);
			let namespace = normalized;
			if (!canUsePlain(normalized)) {
				const digest = createHash("sha256").update(name).digest("hex");
				let length = 8;
				do {
					namespace = `mcp_${normalized.replace(/^_+/, "") || "server"}_${digest.slice(0, length)}`;
					length += 4;
				} while (used.has(namespace) || reservedCandidates.has(namespace) || RESERVED_NAMESPACES.has(namespace));
			}
			if (used.has(namespace)) throw new Error(`Could not allocate MCP namespace for ${name}`);
			used.add(namespace);
			this.states.set(name, { name, status: "idle", tools: [], namespace });
		}
	}

	private validateConfig(name: string, config: McpServerConfig): void {
		const hasCommand = typeof config.command === "string" && config.command.length > 0;
		const hasUrl = typeof config.url === "string" && config.url.length > 0;
		if (hasCommand === hasUrl)
			throw new RiemannHostError("invalid_config", `MCP server ${name} must set exactly one of command or url`);
		if (hasUrl) {
			const urlValue = config.url;
			if (!urlValue) throw new RiemannHostError("invalid_config", `MCP server ${name} URL is empty`);
			const url = new URL(expandConfigSecret(urlValue) ?? urlValue);
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new RiemannHostError("invalid_config", `MCP server ${name} URL must use HTTP or HTTPS`);
		}
	}

	private createTransport(name: string, config: McpServerConfig, state: McpServerState): Transport {
		this.validateConfig(name, config);
		if (config.command) {
			const transport = new StdioClientTransport({
				command: expandConfigSecret(config.command) ?? config.command,
				args: (config.args ?? []).map((value) => expandConfigSecret(value) ?? value),
				env: {
					...getDefaultEnvironment(),
					...Object.fromEntries(
						Object.entries(config.env ?? {}).map(([key, value]) => [key, expandConfigSecret(value) ?? value]),
					),
				},
				cwd: config.cwd ? (isAbsolute(config.cwd) ? config.cwd : resolve(this.cwd, config.cwd)) : this.cwd,
				stderr: "pipe",
			});
			transport.stderr?.on("data", (chunk: Buffer | string) => {
				state.stderr = `${state.stderr ?? ""}${String(chunk)}`.slice(-16_000);
			});
			return transport;
		}
		const url = new URL(expandConfigSecret(config.url) ?? config.url ?? "");
		const headers = Object.fromEntries(
			Object.entries(config.headers ?? {}).map(([key, value]) => [key, expandConfigSecret(value) ?? value]),
		);
		return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
	}

	private async listTools(client: Client, signal: AbortSignal): Promise<Tool[]> {
		const tools: Tool[] = [];
		let cursor: string | undefined;
		const cursors = new Set<string>();
		do {
			const remaining = remainingExecutionMs(signal);
			const result = await client.listTools(cursor ? { cursor } : undefined, {
				timeout: remaining,
				maxTotalTimeout: remaining,
				signal,
			});
			tools.push(...result.tools);
			cursor = result.nextCursor;
			if (cursor && cursors.has(cursor))
				throw new RiemannHostError("mcp_error", "MCP tools/list returned a duplicate cursor");
			if (cursor) cursors.add(cursor);
		} while (cursor);
		return tools;
	}

	private filterTools(tools: Tool[], config: McpServerConfig): Tool[] {
		const enabled = config.enabledTools ? new Set(config.enabledTools) : undefined;
		const disabled = new Set(config.disabledTools ?? []);
		return tools.filter((tool) => (!enabled || enabled.has(tool.name)) && !disabled.has(tool.name));
	}

	private async normalizeToolResult(result: McpCallToolResult): Promise<JsonValue> {
		const raw = asJson(result);
		const source = await this.artifacts.putJson(raw, "mcp-result.json");
		try {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
				throw new RiemannHostError("mcp_error", "MCP tool returned an invalid result");
			}
			const rawContent = Array.isArray(raw.content) ? raw.content : [];
			const protocolContent = "content" in result && Array.isArray(result.content) ? result.content : [];
			const content: JsonValue[] = [];
			const artifacts: JsonValue[] = [source];
			for (let index = 0; index < rawContent.length; index += 1) {
				const wireItem = rawContent[index];
				const item = protocolContent[index];
				if (!item || typeof wireItem !== "object" || wireItem === null || Array.isArray(wireItem)) {
					content.push(wireItem ?? null);
					continue;
				}
				if (item.type === "image") {
					const image = await storeModelImage({
						artifacts: this.artifacts,
						bytes: Buffer.from(item.data, "base64"),
						claimedMimeType: item.mimeType,
						name: `mcp-image-${index + 1}`,
					});
					const normalized = { ...wireItem };
					delete normalized.data;
					normalized.mimeType = image.sourceMimeType;
					normalized.artifact = image.artifact;
					content.push(normalized);
					artifacts.push(image.artifact);
					continue;
				}
				if (item.type === "resource" && "blob" in item.resource && item.resource.mimeType?.startsWith("image/")) {
					const image = await storeModelImage({
						artifacts: this.artifacts,
						bytes: Buffer.from(item.resource.blob, "base64"),
						claimedMimeType: item.resource.mimeType,
						name: `mcp-resource-image-${index + 1}`,
					});
					const wireResource = wireItem.resource;
					if (typeof wireResource === "object" && wireResource !== null && !Array.isArray(wireResource)) {
						const normalizedResource = { ...wireResource };
						delete normalizedResource.blob;
						normalizedResource.mimeType = image.sourceMimeType;
						normalizedResource.artifact = image.artifact;
						content.push({ ...wireItem, resource: normalizedResource });
						artifacts.push(image.artifact);
						continue;
					}
				}
				content.push(wireItem);
			}
			const extensions = Object.fromEntries(
				Object.entries(raw).filter(([key]) => !["content", "structuredContent", "_meta", "isError"].includes(key)),
			);
			const opaqueMcpJson = (value: JsonValue): JsonValue => ({ $riemann: "mcp_json", value });
			const normalized: JsonValue = {
				$riemann: "mcp_result",
				content: content.map(opaqueMcpJson),
				structured_content: opaqueMcpJson(raw.structuredContent ?? null),
				metadata: opaqueMcpJson(raw._meta ?? null),
				artifacts,
				extensions: opaqueMcpJson(extensions),
			};
			if (result.isError) {
				throw new RiemannHostError("mcp_tool_error", "MCP tool reported an error", normalized);
			}
			return normalized;
		} catch (error) {
			if (error instanceof RiemannHostError && error.code === "mcp_tool_error") throw error;
			throw new RiemannHostError("mcp_error", `MCP result normalization failed: ${errorMessage(error)}`, {
				artifact: source,
				cause: error instanceof RiemannHostError ? (error.details ?? null) : null,
			});
		}
	}

	private definitionForTool(
		serverName: string,
		namespace: string,
		tool: Tool,
		usedNames: Set<string>,
	): FunctionDefinition {
		let name = safeIdentifier(tool.name);
		if (name.startsWith("_") || MCP_NAMESPACE_METHODS.has(name)) {
			name = `tool_${name.replace(/^_+/, "") || "private"}_${createHash("sha256").update(tool.name).digest("hex").slice(0, 8)}`;
		}
		if (usedNames.has(name)) name = `${name}_${createHash("sha256").update(tool.name).digest("hex").slice(0, 8)}`;
		usedNames.add(name);
		const remoteInputSchema = Type.Unsafe<Record<string, JsonValue>>(
			asJson(tool.inputSchema) as Record<string, JsonValue>,
		);
		return {
			name,
			namespace,
			description: `${tool.description || tool.title || tool.name} [MCP ${serverName}/${tool.name}]`,
			inputSchema: Type.Object({ input: remoteInputSchema }, { additionalProperties: false }),
			outputSchema: McpResultSchema,
			...(tool.outputSchema
				? { remoteOutputSchema: Type.Unsafe(asJson(tool.outputSchema) as Record<string, JsonValue>) }
				: {}),
			pythonReturnType: "McpResult",
			errors: [
				{
					code: "not_ready",
					description: "The MCP server is not connected",
					retryable: false,
					recovery: "refresh",
				},
				{ code: "mcp_tool_error", description: "The MCP tool returned isError", retryable: false },
				{
					code: "limit_exceeded",
					description: "The run has exhausted its resource reference numbers.",
					retryable: false,
				},
				{ code: "invalid_image", description: "The MCP image is empty.", retryable: false },
				{
					code: "unsupported_media_type",
					description: "The MCP image format is unsupported or invalid.",
					retryable: false,
				},
				{ code: "image_decode_failed", description: "The MCP image cannot be decoded.", retryable: false },
				{ code: "artifact_error", description: "The MCP image artifact is invalid.", retryable: false },
				{
					code: "cancelled",
					description: "The MCP request was cancelled; remote effects may already have occurred.",
					retryable: false,
				},
				{
					code: "mcp_error",
					description: "The MCP request or result failed; remote effects may already have occurred",
					retryable: false,
				},
			],
			effects: [
				{ kind: "remote-call", resource: `MCP ${serverName}/${tool.name}` },
				{ kind: "write", resource: "artifact-store" },
			],
			idempotency: "conditional",
			cancellation: { supported: true, description: "Cancels the MCP request" },
			visibility: "public",
			prompt: {
				inventory: tool.description || tool.title || tool.name,
				example: `await ${namespace}.${name}(input={})`,
			},
			capability: `mcp.${serverName}`,
			handler: async (args, signal) => {
				if (signal.aborted) throw new RiemannHostError("cancelled", "MCP tool call was cancelled");
				const state = this.states.get(serverName);
				const config = this.configs[serverName];
				if (!state?.client || state.status !== "ready" || !config) {
					throw new RiemannHostError(
						"not_ready",
						`MCP server ${serverName} is not ready`,
						undefined,
						false,
						"refresh",
					);
				}
				const input = args.input;
				if (typeof input !== "object" || input === null || Array.isArray(input)) {
					throw new RiemannHostError("invalid_arguments", "input must be an object");
				}
				const timeout = remainingExecutionMs(signal);
				try {
					const result = await state.client.callTool({ name: tool.name, arguments: input }, undefined, {
						timeout,
						maxTotalTimeout: timeout,
						resetTimeoutOnProgress: true,
						signal,
					});
					return await this.normalizeToolResult(result);
				} catch (error) {
					if (error instanceof RiemannHostError) throw error;
					if (signal.aborted) throw new RiemannHostError("cancelled", "MCP tool call was cancelled");
					throw new RiemannHostError(
						"mcp_error",
						`MCP tool call failed: ${errorMessage(error)}`,
						undefined,
						false,
						"none",
					);
				}
			},
		};
	}

	private installTools(serverName: string, state: McpServerState): PythonFunctionSpecification[] {
		const namespace = state.namespace;
		if (!namespace) throw new RiemannHostError("invalid_config", `MCP server ${serverName} has no Python namespace`);
		this.registry.unregisterNamespace(namespace);
		const usedNames = new Set<string>();
		const definitions = [...state.tools]
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((tool) => this.definitionForTool(serverName, namespace, tool, usedNames));
		for (const definition of definitions) this.registry.register(definition);
		state.namespace = namespace;
		state.functionNames = definitions.map((definition) => `${namespace}.${definition.name}`);
		return this.registry.pythonSpecifications(namespace);
	}

	private functionBundle(serverName: string, state: McpServerState): JsonValue {
		return asJson({
			$riemann: "function_bundle",
			namespace: state.namespace ?? "",
			server_name: serverName,
			specifications: this.registry.pythonSpecifications(state.namespace),
		});
	}

	private requireServer(serverName: string): McpServerState {
		const state = this.states.get(serverName);
		if (!state || !this.configs[serverName]) {
			throw new RiemannHostError("not_found", `Unknown or disabled MCP server: ${serverName}`);
		}
		if (!hasCapability(this.capabilities, `mcp.${serverName}`, "mcp")) {
			throw new RiemannHostError("permission_denied", `Capability mcp.${serverName} is not available to this agent`);
		}
		return state;
	}

	serverStatus(serverName: string): JsonValue {
		const state = this.requireServer(serverName);
		return {
			$riemann: "mcp_server_status",
			name: serverName,
			namespace: state.namespace ?? "",
			status: state.status,
			tool_count: state.tools.length,
			error: state.error ?? null,
		};
	}

	async closeServer(serverName: string): Promise<void> {
		return this.shutdown(this.requireServer(serverName));
	}

	private async shutdown(state: McpServerState): Promise<void> {
		const serverName = state.name;
		state.lifecycle = {};
		state.status = "closed";
		const startup = this.startups.get(serverName);
		this.startups.delete(serverName);
		startup?.controller.abort();
		const client = state.client;
		state.client = undefined;
		state.transport = undefined;
		if (state.namespace) this.registry.unregisterNamespace(state.namespace);
		state.tools = [];
		state.functionNames = [];
		state.error = undefined;
		const previous = state.closing;
		const closing = Promise.allSettled([
			...(previous ? [previous] : []),
			...(client ? [client.close()] : []),
			...(startup ? [startup.promise] : []),
		]).then(() => undefined);
		state.closing = closing;
		await closing;
		if (state.closing === closing) state.closing = undefined;
	}

	async refresh(serverName: string, signal: AbortSignal): Promise<JsonValue> {
		if (signal.aborted) throw new RiemannHostError("cancelled", "MCP refresh was cancelled");
		if (this.closed) throw new RiemannHostError("closed", "MCP manager is closed");
		const state = this.requireServer(serverName);
		const closing = this.closeServer(serverName);
		const lifecycle = state.lifecycle;
		await closing;
		if (this.closed || state.lifecycle !== lifecycle)
			throw new RiemannHostError("closed", "MCP refresh was superseded by close");
		return this.open(serverName, signal);
	}

	async open(serverName: string, signal: AbortSignal): Promise<JsonValue> {
		if (signal.aborted) throw new RiemannHostError("cancelled", "MCP open was cancelled");
		if (this.closed) throw new RiemannHostError("closed", "MCP manager is closed");
		const config = this.configs[serverName];
		const state = this.requireServer(serverName);
		if (!config) throw new RiemannHostError("not_found", `Unknown MCP server: ${serverName}`);
		try {
			if (state.closing) {
				const lifecycle = state.lifecycle;
				await raceWithAbortSignal(state.closing, signal);
				if (this.closed || state.lifecycle !== lifecycle)
					throw new RiemannHostError("closed", "MCP open was superseded by close");
			}
			if (state.status === "ready") return this.functionBundle(serverName, state);
			let startup = this.startups.get(serverName);
			if (!startup) {
				const controller = new AbortController();
				const lifecycle = {};
				state.lifecycle = lifecycle;
				state.status = "connecting";
				const promise = Promise.resolve().then(() =>
					this.connect(serverName, config, state, lifecycle, controller.signal),
				);
				startup = { controller, promise, waiters: 0 };
				this.startups.set(serverName, startup);
				void promise
					.finally(() => {
						if (this.startups.get(serverName)?.promise === promise) this.startups.delete(serverName);
					})
					.catch(() => undefined);
			}
			startup.waiters++;
			let activated: McpServerState;
			try {
				activated = await raceWithAbortSignal(startup.promise, signal);
			} finally {
				startup.waiters--;
				if (startup.waiters === 0 && signal.aborted && this.startups.get(serverName) === startup) {
					this.startups.delete(serverName);
					startup.controller.abort(signal.reason);
				}
			}
			if (this.closed || startup.controller.signal.aborted || activated.status !== "ready")
				throw new RiemannHostError("closed", "MCP server was closed");
			return this.functionBundle(serverName, activated);
		} catch (error) {
			if (signal.aborted) throw new RiemannHostError("cancelled", "MCP open was cancelled");
			throw error;
		}
	}

	private async connect(
		serverName: string,
		config: McpServerConfig,
		state: McpServerState,
		lifecycle: object,
		managerSignal: AbortSignal,
	): Promise<McpServerState> {
		let client: Client | undefined;
		try {
			managerSignal.throwIfAborted();
			const transport = this.createTransport(serverName, config, state);
			client = new Client({ name: "riemann-agent", version: "0.1.0" }, { capabilities: {} });
			state.transport = transport;
			state.client = client;
			client.onerror = (error) => {
				if (state.lifecycle === lifecycle) state.error = error.message;
			};
			client.onclose = () => {
				if (state.lifecycle !== lifecycle) return;
				if (!this.closed && state.status !== "failed") state.status = "failed";
				if (state.namespace) this.registry.unregisterNamespace(state.namespace);
			};
			const timeout = remainingExecutionMs(managerSignal);
			const startupSignal = managerSignal;
			await raceWithAbortSignal(
				client.connect(transport, { timeout, maxTotalTimeout: timeout, signal: startupSignal }),
				startupSignal,
			);
			startupSignal.throwIfAborted();
			const tools = this.filterTools(
				await raceWithAbortSignal(this.listTools(client, startupSignal), startupSignal),
				config,
			);
			startupSignal.throwIfAborted();
			if (this.closed || state.lifecycle !== lifecycle)
				throw new RiemannHostError("closed", "MCP startup was closed");
			state.tools = tools;
			state.status = "ready";
			state.error = undefined;
			this.installTools(serverName, state);
			return state;
		} catch (error) {
			const wasClosed = managerSignal.aborted || this.closed || state.lifecycle !== lifecycle;
			if (!wasClosed) {
				state.status = "failed";
				state.error = errorMessage(error);
			}
			await client?.close().catch(() => undefined);
			if (wasClosed) throw new RiemannHostError("closed", `MCP server ${serverName} startup was closed`);
			throw new RiemannHostError(
				"mcp_error",
				`MCP server ${serverName} failed: ${state.error}${state.stderr ? `\n${state.stderr}` : ""}`,
				undefined,
				true,
			);
		}
	}

	promptInventory(capabilities: ReadonlySet<string>): string {
		if (!hasCapability(capabilities, "mcp.open", "mcp")) return "";
		return Object.entries(this.configs)
			.filter(
				([name, config]) =>
					config.enabled !== false &&
					config.exposeToModel !== false &&
					typeof config.description === "string" &&
					config.description.trim().length > 0 &&
					hasCapability(capabilities, `mcp.${name}`, "mcp"),
			)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, config]) => `- ${JSON.stringify(name)}: ${config.description?.replace(/\s+/g, " ").trim() ?? ""}`)
			.join("\n");
	}

	definitions(): FunctionDefinition[] {
		return [
			{
				name: "open",
				namespace: "mcp",
				description: "Open one configured MCP server and install its tools in a Python namespace.",
				inputSchema: Type.Object(
					{ name: Type.String({ minLength: 1, description: "Configured server name" }) },
					{ additionalProperties: false },
				),
				outputSchema: FunctionBundleSchema,
				pythonReturnType: "McpNamespace",
				errors: [
					{
						code: "closed",
						description: "The manager is closed or a concurrent close superseded startup.",
						retryable: false,
					},
					{ code: "not_found", description: "The configured server does not exist", retryable: false },
					{ code: "mcp_error", description: "The MCP server failed to start", retryable: true },
				],
				effects: [{ kind: "connect", resource: "configured MCP server" }],
				idempotency: "idempotent",
				cancellation: { supported: true, description: "Cancels waiting for server startup" },
				visibility: "public",
				prompt: {
					inventory: "Open a configured MCP server and install its tools.",
					example: 'server = await mcp.open(name="ida")',
				},
				capability: "mcp.open",
				handler: (args, signal) => this.open(args.name as string, signal),
			},
			{
				name: "status",
				namespace: "mcp",
				description: "Return lifecycle state for an opened MCP namespace.",
				inputSchema: Type.Object({ server_name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
				outputSchema: McpServerStatusSchema,
				pythonReturnType: "McpServerStatus",
				errors: [{ code: "not_found", description: "The server is unavailable.", retryable: false }],
				effects: [{ kind: "read", resource: "MCP server state" }],
				idempotency: "idempotent",
				cancellation: { supported: false, description: "Not cancellable." },
				visibility: "handle-method",
				prompt: { inventory: "Inspect MCP lifecycle state.", example: "await server.status()" },
				capability: "mcp.open",
				handler: async (args) => this.serverStatus(args.server_name as string),
			},
			{
				name: "refresh",
				namespace: "mcp",
				description: "Reconnect an MCP server and replace its namespace tools.",
				inputSchema: Type.Object({ server_name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
				outputSchema: FunctionBundleSchema,
				pythonReturnType: "McpNamespace",
				errors: [
					{
						code: "closed",
						description: "The manager is closed or a concurrent close superseded startup.",
						retryable: false,
					},
					{ code: "mcp_error", description: "The server failed to reconnect.", retryable: true },
				],
				effects: [{ kind: "connect", resource: "configured MCP server" }],
				idempotency: "non-idempotent",
				cancellation: { supported: true, description: "Cancels waiting for reconnection." },
				visibility: "handle-method",
				prompt: { inventory: "Refresh MCP tools.", example: "await server.refresh()" },
				capability: "mcp.open",
				handler: (args, signal) => this.refresh(args.server_name as string, signal),
			},
			{
				name: "close",
				namespace: "mcp",
				description: "Close one MCP server and remove its tools.",
				inputSchema: Type.Object({ server_name: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
				outputSchema: Type.Null(),
				pythonReturnType: "None",
				errors: [{ code: "not_found", description: "The server is unavailable.", retryable: false }],
				effects: [{ kind: "disconnect", resource: "configured MCP server" }],
				idempotency: "idempotent",
				cancellation: { supported: false, description: "Close runs to settlement." },
				visibility: "handle-method",
				prompt: { inventory: "Close an MCP namespace.", example: "await server.close()" },
				capability: "mcp.open",
				handler: async (args) => {
					await this.closeServer(args.server_name as string);
					return null;
				},
			},
		];
	}

	async close(): Promise<void> {
		if (this.closed) {
			await Promise.allSettled([...this.states.values()].flatMap((state) => (state.closing ? [state.closing] : [])));
			return;
		}
		this.closed = true;
		await Promise.allSettled([...this.states.values()].map((state) => this.shutdown(state)));
	}
}
