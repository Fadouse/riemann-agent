import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import type { McpServerConfig } from "../config.ts";
import { expandConfigSecret } from "../config.ts";
import { RiemannHostError } from "../errors.ts";
import {
	type FunctionDefinition,
	type FunctionRegistry,
	hasCapability,
	type PythonFunctionSpecification,
} from "../functions/registry.ts";
import { storeModelImage } from "../images.ts";
import type { JsonValue } from "../kernel/types.ts";
import { type KernelHostResult, type KernelModelContent, kernelHostResult } from "../kernel/types.ts";
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
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_NAMESPACES = new Set(["fs", "shell", "web", "artifacts", "agents", "mcp", "catalog", "state"]);

function safeIdentifier(value: string): string {
	const normalized = value
		.replace(/[^A-Za-z0-9_]+/g, "_")
		.replace(/^([^A-Za-z_])/, "_$1")
		.replace(/_+/g, "_");
	return normalized || "tool";
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
	private readonly startups = new Map<string, Promise<McpServerState>>();
	private closed = false;
	private readonly configs: Record<string, McpServerConfig>;
	private readonly cwd: string;
	private readonly artifacts: ArtifactStore;
	private readonly registry: FunctionRegistry;

	constructor(
		configs: Record<string, McpServerConfig>,
		cwd: string,
		registry: FunctionRegistry,
		artifacts: ArtifactStore,
	) {
		this.configs = configs;
		this.cwd = cwd;
		this.registry = registry;
		this.artifacts = artifacts;
		const usedNamespaces = new Set<string>(RESERVED_NAMESPACES);
		for (const [name, config] of Object.entries(configs)) {
			if (config.enabled === false) continue;
			const serverNamespace = safeIdentifier(name);
			const baseNamespace = usedNamespaces.has(serverNamespace) ? `mcp_${serverNamespace}` : serverNamespace;
			const namespace = usedNamespaces.has(baseNamespace)
				? `${baseNamespace}_${createHash("sha256").update(name).digest("hex").slice(0, 8)}`
				: baseNamespace;
			usedNamespaces.add(namespace);
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

	private async listTools(client: Client, timeout: number): Promise<Tool[]> {
		const tools: Tool[] = [];
		let cursor: string | undefined;
		const cursors = new Set<string>();
		do {
			const result = await client.listTools(cursor ? { cursor } : undefined, { timeout, maxTotalTimeout: timeout });
			tools.push(...result.tools);
			cursor = result.nextCursor;
			if (cursor && cursors.has(cursor)) throw new Error("MCP tools/list returned a duplicate cursor");
			if (cursor) cursors.add(cursor);
		} while (cursor);
		return tools;
	}

	private filterTools(tools: Tool[], config: McpServerConfig): Tool[] {
		const enabled = config.enabledTools ? new Set(config.enabledTools) : undefined;
		const disabled = new Set(config.disabledTools ?? []);
		return tools.filter((tool) => (!enabled || enabled.has(tool.name)) && !disabled.has(tool.name));
	}

	private async normalizeToolResult(result: McpCallToolResult): Promise<JsonValue | KernelHostResult> {
		const wire = asJson(result);
		if (!("content" in result) || !Array.isArray(result.content)) return wire;
		if (typeof wire !== "object" || wire === null || Array.isArray(wire) || !Array.isArray(wire.content)) return wire;
		const content = result.content as CallToolResult["content"];
		const modelContent: KernelModelContent[] = [];
		const normalizedContent: JsonValue[] = [];
		for (let index = 0; index < content.length; index += 1) {
			const item = content[index];
			const wireItem = wire.content[index];
			if (!item || typeof wireItem !== "object" || wireItem === null || Array.isArray(wireItem)) {
				if (wireItem !== undefined) normalizedContent.push(wireItem);
				continue;
			}
			const audience = "annotations" in item ? item.annotations?.audience : undefined;
			const visibleToModel = audience === undefined || audience.includes("assistant");
			if (item.type === "image") {
				const image = await storeModelImage({
					artifacts: this.artifacts,
					bytes: Buffer.from(item.data, "base64"),
					claimedMimeType: item.mimeType,
					name: `mcp-image-${index + 1}`,
				});
				const normalizedItem = { ...wireItem };
				delete normalizedItem.data;
				normalizedItem.mimeType = image.reference.mimeType;
				normalizedItem.artifact = image.artifact;
				normalizedContent.push(normalizedItem);
				if (visibleToModel) {
					modelContent.push(
						{ type: "text", text: `MCP image result [${image.reference.mimeType}]` },
						image.reference,
					);
				}
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
				if (typeof wireResource !== "object" || wireResource === null || Array.isArray(wireResource)) {
					normalizedContent.push(wireItem);
					continue;
				}
				const normalizedResource = { ...wireResource };
				delete normalizedResource.blob;
				normalizedResource.mimeType = image.reference.mimeType;
				normalizedResource.artifact = image.artifact;
				normalizedContent.push({ ...wireItem, resource: normalizedResource });
				if (visibleToModel) {
					modelContent.push(
						{ type: "text", text: `MCP image resource [${image.reference.mimeType}]` },
						image.reference,
					);
				}
				continue;
			}
			normalizedContent.push(wireItem);
		}
		wire.content = normalizedContent;
		return modelContent.length > 0 ? kernelHostResult(wire, modelContent) : wire;
	}

	private definitionForTool(
		serverName: string,
		namespace: string,
		tool: Tool,
		usedNames: Set<string>,
	): FunctionDefinition {
		let name = safeIdentifier(tool.name);
		if (usedNames.has(name)) name = `${name}_${createHash("sha256").update(tool.name).digest("hex").slice(0, 8)}`;
		usedNames.add(name);
		const schema = tool.inputSchema;
		const properties =
			schema &&
			typeof schema === "object" &&
			"properties" in schema &&
			schema.properties &&
			typeof schema.properties === "object"
				? (schema.properties as Record<string, unknown>)
				: {};
		const required = new Set(
			Array.isArray(schema?.required)
				? schema.required.filter((item): item is string => typeof item === "string")
				: [],
		);
		const propertyNames = Object.keys(properties);
		const directlyCallable =
			propertyNames.length <= 24 && propertyNames.every((property) => IDENTIFIER.test(property));
		const orderedNames = directlyCallable
			? [
					...propertyNames.filter((property) => required.has(property)),
					...propertyNames.filter((property) => !required.has(property)),
				]
			: ["arguments"];
		const parameters = orderedNames.map((parameter) => ({
			name: parameter,
			description: directlyCallable
				? JSON.stringify(properties[parameter] ?? {})
				: `Arguments matching the MCP input schema: ${JSON.stringify(schema ?? {})}`,
			type: directlyCallable ? "Any" : "dict",
			required: directlyCallable ? required.has(parameter) : true,
		}));
		return {
			name,
			namespace,
			description: `${tool.description || tool.title || tool.name} [MCP ${serverName}/${tool.name}]`,
			parameters,
			returns: "MCP tool result",
			capability: `mcp.${serverName}`,
			includeInSystemPrompt: false,
			handler: async (args, signal) => {
				const state = this.states.get(serverName);
				const config = this.configs[serverName];
				if (!state?.client || state.status !== "ready" || !config)
					throw new RiemannHostError("not_ready", `MCP server ${serverName} is not ready`);
				let callArguments: Record<string, JsonValue>;
				if (directlyCallable) {
					callArguments = {};
					for (const property of propertyNames) {
						const value = args[property];
						if (value !== undefined) callArguments[property] = value;
					}
				} else {
					if (typeof args.arguments !== "object" || args.arguments === null || Array.isArray(args.arguments)) {
						throw new RiemannHostError("invalid_arguments", "arguments must be a dictionary");
					}
					callArguments = args.arguments;
				}
				const timeout = config.toolTimeoutMs ?? 60_000;
				const result = await state.client.callTool({ name: tool.name, arguments: callArguments }, undefined, {
					timeout,
					maxTotalTimeout: timeout,
					resetTimeoutOnProgress: true,
					signal,
				});
				return this.normalizeToolResult(result);
			},
		};
	}

	private installTools(serverName: string, state: McpServerState): PythonFunctionSpecification[] {
		const namespace = state.namespace;
		if (!namespace) throw new RiemannHostError("invalid_config", `MCP server ${serverName} has no Python namespace`);
		this.registry.unregisterNamespace(namespace);
		const usedNames = new Set<string>();
		const definitions = state.tools.map((tool) => this.definitionForTool(serverName, namespace, tool, usedNames));
		for (const definition of definitions) this.registry.register(definition);
		state.namespace = namespace;
		state.functionNames = definitions.map((definition) => `${namespace}.${definition.name}`);
		return this.registry.pythonSpecifications(namespace);
	}

	async activate(serverName: string, signal: AbortSignal): Promise<JsonValue> {
		if (this.closed) throw new RiemannHostError("closed", "MCP manager is closed");
		const config = this.configs[serverName];
		const state = this.states.get(serverName);
		if (!config || !state) throw new RiemannHostError("not_found", `Unknown or disabled MCP server: ${serverName}`);
		if (state.status === "ready") {
			return asJson({
				$riemann: "function_bundle",
				namespace: state.namespace ?? "",
				specifications: this.registry.pythonSpecifications(state.namespace),
			});
		}
		let startup = this.startups.get(serverName);
		if (!startup) {
			startup = this.connect(serverName, config, state);
			this.startups.set(serverName, startup);
		}
		const activated = await raceWithAbortSignal(startup, signal);
		return asJson({
			$riemann: "function_bundle",
			namespace: activated.namespace ?? "",
			specifications: this.registry.pythonSpecifications(activated.namespace),
		});
	}

	private async connect(serverName: string, config: McpServerConfig, state: McpServerState): Promise<McpServerState> {
		state.status = "connecting";
		try {
			const transport = this.createTransport(serverName, config, state);
			const client = new Client({ name: "riemann-agent", version: "0.1.0" }, { capabilities: {} });
			state.transport = transport;
			state.client = client;
			client.onerror = (error) => {
				state.error = error.message;
			};
			client.onclose = () => {
				if (!this.closed && state.status !== "failed") state.status = "failed";
			};
			const timeout = config.startupTimeoutMs ?? 15_000;
			await client.connect(transport, { timeout, maxTotalTimeout: timeout });
			state.tools = this.filterTools(await this.listTools(client, timeout), config);
			state.status = "ready";
			state.error = undefined;
			this.installTools(serverName, state);
			return state;
		} catch (error) {
			state.status = "failed";
			state.error = errorMessage(error);
			await state.client?.close().catch(() => undefined);
			throw new RiemannHostError(
				"mcp_error",
				`MCP server ${serverName} failed: ${state.error}${state.stderr ? `\n${state.stderr}` : ""}`,
			);
		} finally {
			this.startups.delete(serverName);
		}
	}

	promptInventory(capabilities: ReadonlySet<string>): string {
		if (!hasCapability(capabilities, "mcp.activate", "mcp")) return "";
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
				name: "activate",
				namespace: "mcp",
				description:
					"Activate one MCP server and install its tools in a Python namespace derived from the configured server name.",
				promptSnippet: "Lazily activate a server and install its functions.",
				parameters: [{ name: "name", description: "Configured server name", type: "str", required: true }],
				returns: "Python namespace",
				capability: "mcp.activate",
				handler: async (args, signal) => {
					if (typeof args.name !== "string" || args.name.length === 0)
						throw new RiemannHostError("invalid_arguments", "name must be a non-empty string");
					return this.activate(args.name, signal);
				},
			},
		];
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await Promise.allSettled(
			[...this.states.values()].flatMap((state) => (state.client ? [state.client.close()] : [])),
		);
		for (const state of this.states.values()) state.status = "closed";
	}
}
