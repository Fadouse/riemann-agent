import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { FilesystemConfig } from "./access-policy.ts";
import type { ConfiguredCompactionStrategy } from "./compaction-strategy.ts";

const FilesystemFieldSchema = Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Literal("inherit")]);
const FilesystemSchema = Type.Object(
	{
		read: Type.Optional(FilesystemFieldSchema),
		readExclude: Type.Optional(FilesystemFieldSchema),
		write: Type.Optional(FilesystemFieldSchema),
		writeExclude: Type.Optional(FilesystemFieldSchema),
	},
	{ additionalProperties: false },
);
const SubagentWorkspaceSchema = Type.Union([Type.Literal("shared"), Type.Literal("worktree")]);
const AgentNetworkSchema = Type.Union([Type.Literal("allow"), Type.Literal("deny"), Type.Literal("inherit")]);
const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);
const CompactionStrategySchema = Type.Union([
	Type.Literal("automatic"),
	Type.Literal("default"),
	Type.Literal("openai"),
	Type.Literal("snapshot"),
]);
const AgentProfileSchema = Type.Object(
	{
		description: Type.Optional(Type.String()),
		prompt: Type.Optional(Type.String()),
		promptFile: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
		network: Type.Optional(AgentNetworkSchema),
		capabilities: Type.Optional(Type.Array(Type.String())),
		workspace: Type.Optional(SubagentWorkspaceSchema),
		filesystem: Type.Optional(FilesystemSchema),
	},
	{ additionalProperties: false },
);
const McpServerSchema = Type.Object(
	{
		description: Type.Optional(Type.String()),
		exposeToModel: Type.Optional(Type.Boolean()),
		enabled: Type.Optional(Type.Boolean()),
		command: Type.Optional(Type.String()),
		args: Type.Optional(Type.Array(Type.String())),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		cwd: Type.Optional(Type.String()),
		url: Type.Optional(Type.String()),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		startupTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		toolTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		enabledTools: Type.Optional(Type.Array(Type.String())),
		disabledTools: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);
const ConfigSchema = Type.Object(
	{
		compaction: Type.Optional(
			Type.Object({ strategy: Type.Optional(CompactionStrategySchema) }, { additionalProperties: false }),
		),
		agents: Type.Optional(
			Type.Object(
				{
					maxAgents: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
					main: Type.Optional(
						Type.Object(
							{ filesystem: Type.Optional(FilesystemSchema), network: Type.Optional(AgentNetworkSchema) },
							{ additionalProperties: false },
						),
					),
					defaults: Type.Optional(
						Type.Object(
							{
								model: Type.Optional(Type.String({ minLength: 1 })),
								network: Type.Optional(AgentNetworkSchema),
								workspace: Type.Optional(SubagentWorkspaceSchema),
								filesystem: Type.Optional(FilesystemSchema),
							},
							{ additionalProperties: false },
						),
					),
					profiles: Type.Optional(Type.Record(Type.String(), AgentProfileSchema)),
				},
				{ additionalProperties: false },
			),
		),
		mcp: Type.Optional(
			Type.Object(
				{ servers: Type.Optional(Type.Record(Type.String(), McpServerSchema)) },
				{ additionalProperties: false },
			),
		),
		web: Type.Optional(
			Type.Object(
				{
					exaApiKey: Type.Optional(Type.String()),
					searchBackend: Type.Optional(Type.Union([Type.Literal("exa"), Type.Literal("disabled")])),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type RiemannConfigFile = Static<typeof ConfigSchema>;
export type AgentProfileConfig = Static<typeof AgentProfileSchema>;
export type McpServerConfig = Static<typeof McpServerSchema>;
export type RiemannFilesystemConfig = Static<typeof FilesystemSchema>;
export type SubagentWorkspace = Static<typeof SubagentWorkspaceSchema>;
export type AgentNetworkPolicy = Static<typeof AgentNetworkSchema>;
export type EffectiveAgentNetwork = Exclude<AgentNetworkPolicy, "inherit">;

export type RiemannSettingPath =
	| "agents.maxAgents"
	| "agents.defaults.model"
	| "compaction.strategy"
	| "agents.main.filesystem"
	| "agents.main.network"
	| "agents.defaults.workspace"
	| "agents.defaults.network"
	| "agents.defaults.filesystem"
	| `mcp.servers.${string}.enabled`
	| `mcp.servers.${string}.exposeToModel`
	| `mcp.servers.${string}.startupTimeoutMs`
	| `mcp.servers.${string}.toolTimeoutMs`
	| `mcp.servers.${string}.enabledTools`
	| `mcp.servers.${string}.disabledTools`;

export interface RiemannConfig {
	maxAgents: number;
	maxConcurrentAgents: number;
	limits: {
		maxCellOutputChars: number;
		maxArtifactPreviewChars: number;
	};
	retention: {
		maxAgeDays: number;
		maxArtifactBytes: number;
		maxSnapshotBytes: number;
		maxWorktreeBytes: number;
	};
	compaction: {
		strategy: ConfiguredCompactionStrategy;
	};
	mainAgent: {
		filesystem?: FilesystemConfig;
		network: AgentNetworkPolicy;
	};
	agentDefaults: {
		workspace: SubagentWorkspace;
		filesystem?: FilesystemConfig;
		model?: string;
		network: AgentNetworkPolicy;
	};
	profiles: Record<string, AgentProfileConfig>;
	mcpServers: Record<string, McpServerConfig>;
	web: {
		exaApiKey?: string;
		searchBackend: "exa" | "disabled";
	};
	files: string[];
	projectOverrides: ReadonlySet<RiemannSettingPath>;
}

const DEFAULTS: Omit<RiemannConfig, "files"> = {
	maxAgents: 4,
	maxConcurrentAgents: 4,
	limits: {
		maxCellOutputChars: 100_000,
		maxArtifactPreviewChars: 12_000,
	},
	retention: {
		maxAgeDays: 30,
		maxArtifactBytes: 1_073_741_824,
		maxSnapshotBytes: 536_870_912,
		maxWorktreeBytes: 5_368_709_120,
	},
	compaction: { strategy: "automatic" },
	mainAgent: { network: "inherit" },
	agentDefaults: { workspace: "shared", network: "inherit" },
	profiles: {},
	mcpServers: {},
	web: { searchBackend: "exa" },
	projectOverrides: new Set<RiemannSettingPath>(),
};

function mergeConfig(base: RiemannConfig, next: RiemannConfigFile, path: string): RiemannConfig {
	const maxAgents = next.agents?.maxAgents ?? base.maxAgents;
	return {
		...base,
		maxAgents,
		maxConcurrentAgents: Math.min(maxAgents, 4),
		compaction: { ...base.compaction, ...next.compaction },
		mainAgent: { ...base.mainAgent, ...next.agents?.main },
		agentDefaults: { ...base.agentDefaults, ...next.agents?.defaults },
		profiles: { ...base.profiles, ...next.agents?.profiles },
		mcpServers: { ...base.mcpServers, ...next.mcp?.servers },
		web: { ...base.web, ...next.web },
		files: [...base.files, path],
		projectOverrides: base.projectOverrides,
	};
}

function configuredSettingPaths(config: RiemannConfigFile): Set<RiemannSettingPath> {
	const paths = new Set<RiemannSettingPath>();
	if (config.agents?.maxAgents !== undefined) paths.add("agents.maxAgents");
	if (config.compaction?.strategy !== undefined) paths.add("compaction.strategy");
	if (config.agents?.main?.filesystem !== undefined) paths.add("agents.main.filesystem");
	if (config.agents?.main?.network !== undefined) paths.add("agents.main.network");
	if (config.agents?.defaults?.model !== undefined) paths.add("agents.defaults.model");
	if (config.agents?.defaults?.network !== undefined) paths.add("agents.defaults.network");
	if (config.agents?.defaults?.workspace !== undefined) paths.add("agents.defaults.workspace");
	if (config.agents?.defaults?.filesystem !== undefined) paths.add("agents.defaults.filesystem");
	for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
		for (const key of [
			"enabled",
			"exposeToModel",
			"startupTimeoutMs",
			"toolTimeoutMs",
			"enabledTools",
			"disabledTools",
		] as const) {
			if (server[key] !== undefined) paths.add(`mcp.servers.${name}.${key}`);
		}
	}
	return paths;
}

export interface CompactionStrategySettingCommit {
	agentDir: string;
	previousStrategy: ConfiguredCompactionStrategy;
	committedStrategy: ConfiguredCompactionStrategy;
}

export type CompactionStrategySettingCommitListener = (commit: CompactionStrategySettingCommit) => void | Promise<void>;

const compactionStrategySettingCommitListeners = new Set<CompactionStrategySettingCommitListener>();

/** Subscribe to successful process-local compaction strategy writes. This does not observe external processes. */
export function subscribeCompactionStrategySettingCommits(
	listener: CompactionStrategySettingCommitListener,
): () => void {
	compactionStrategySettingCommitListeners.add(listener);
	return () => compactionStrategySettingCommitListeners.delete(listener);
}

function notifyCompactionStrategySettingCommit(commit: CompactionStrategySettingCommit): void {
	for (const listener of compactionStrategySettingCommitListeners) {
		try {
			const notified = listener(commit);
			if (notified) void notified.catch(() => undefined);
		} catch {}
	}
}

const pendingConfigWrites = new Map<string, Promise<void>>();

async function waitForPendingConfigWrites(path: string): Promise<void> {
	const key = resolve(path);
	while (true) {
		const pending = pendingConfigWrites.get(key);
		if (!pending) return;
		await pending.catch(() => undefined);
		if (pendingConfigWrites.get(key) === pending) return;
	}
}

async function parseConfigFileNow(path: string): Promise<RiemannConfigFile | undefined> {
	if (!existsSync(path)) return undefined;
	let value: unknown;
	try {
		value = parseYaml(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`Cannot parse Riemann config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Value.Check(ConfigSchema, value)) {
		const errors = [...Value.Errors(ConfigSchema, value)]
			.slice(0, 8)
			.map((error) => error.message)
			.join("; ");
		throw new Error(`Invalid Riemann config ${path}: ${errors}`);
	}
	validateMcpDescriptions(value, path);
	return value;
}

async function parseConfigFile(path: string): Promise<RiemannConfigFile | undefined> {
	await waitForPendingConfigWrites(path);
	return parseConfigFileNow(path);
}

export async function loadRiemannConfig(options: {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): Promise<RiemannConfig> {
	let config: RiemannConfig = {
		...DEFAULTS,
		limits: { ...DEFAULTS.limits },
		retention: { ...DEFAULTS.retention },
		compaction: { ...DEFAULTS.compaction },
		mainAgent: { ...DEFAULTS.mainAgent },
		agentDefaults: { ...DEFAULTS.agentDefaults },
		files: [],
		projectOverrides: new Set<RiemannSettingPath>(),
	};
	const globalPath = join(options.agentDir, "config.yaml");
	const globalConfig = await parseConfigFile(globalPath);
	if (globalConfig) config = mergeConfig(config, globalConfig, globalPath);
	const globalMaxAgents = config.maxAgents;
	if (options.projectTrusted) {
		const projectPath = join(options.cwd, ".riemann", "config.yaml");
		const projectConfig = await parseConfigFile(projectPath);
		if (projectConfig) {
			config = mergeConfig(config, projectConfig, projectPath);
			config.maxAgents = Math.min(globalMaxAgents, projectConfig.agents?.maxAgents ?? globalMaxAgents);
			config.maxConcurrentAgents = Math.min(config.maxAgents, 4);
			const projectOverrides = configuredSettingPaths(projectConfig);
			if ((projectConfig.agents?.maxAgents ?? globalMaxAgents) >= globalMaxAgents) {
				projectOverrides.delete("agents.maxAgents");
			}
			config.projectOverrides = projectOverrides;
		}
	}
	return config;
}

function settingPathSegments(path: RiemannSettingPath): string[] {
	if (!path.startsWith("mcp.servers.")) return path.split(".");
	for (const field of [
		"enabled",
		"exposeToModel",
		"startupTimeoutMs",
		"toolTimeoutMs",
		"enabledTools",
		"disabledTools",
	] as const) {
		const suffix = `.${field}`;
		if (path.endsWith(suffix)) return ["mcp", "servers", path.slice("mcp.servers.".length, -suffix.length), field];
	}
	throw new Error(`Unsupported Riemann setting path: ${path}`);
}

function validateMcpDescriptions(config: RiemannConfigFile, path: string): void {
	for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
		const exposed = server.enabled !== false && server.exposeToModel !== false;
		if (exposed && (!server.description || server.description.trim().length === 0)) {
			throw new Error(`Invalid Riemann config ${path}: model-visible MCP server ${name} requires a description`);
		}
	}
}

function setNestedValue(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let current = target;
	for (const segment of path.slice(0, -1)) {
		const existing = current[segment];
		if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
			const created: Record<string, unknown> = {};
			current[segment] = created;
			current = created;
		} else {
			current = existing as Record<string, unknown>;
		}
	}
	const key = path.at(-1);
	if (!key) throw new Error("Riemann setting path must not be empty");
	if (value === undefined) delete current[key];
	else current[key] = value;
}

export function updateGlobalRiemannSetting(agentDir: string, path: RiemannSettingPath, value: unknown): Promise<void> {
	const configPath = resolve(agentDir, "config.yaml");
	const preceding = pendingConfigWrites.get(configPath) ?? Promise.resolve();
	const write = preceding
		.catch(() => undefined)
		.then(async () => {
			await mkdir(dirname(configPath), { recursive: true });
			let compactionStrategyCommit: CompactionStrategySettingCommit | undefined;
			const release = await lockfile.lock(configPath, {
				realpath: false,
				retries: {
					retries: 10,
					factor: 1.5,
					minTimeout: 10,
					maxTimeout: 100,
					maxRetryTime: 2_000,
					randomize: true,
				},
			});
			try {
				const existing = (await parseConfigFileNow(configPath)) ?? {};
				const previousStrategy = existing.compaction?.strategy ?? "automatic";
				const next = structuredClone(existing) as Record<string, unknown>;
				setNestedValue(next, settingPathSegments(path), value);
				if (!Value.Check(ConfigSchema, next)) {
					const errors = [...Value.Errors(ConfigSchema, next)]
						.slice(0, 8)
						.map((error) => `${error.instancePath || path}: ${error.message}`)
						.join("; ");
					throw new Error(`Invalid Riemann setting ${path}: ${errors}`);
				}
				validateMcpDescriptions(next as RiemannConfigFile, configPath);
				const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporaryPath, stringifyYaml(next), { encoding: "utf8", mode: 0o600 });
					await rename(temporaryPath, configPath);
					if (path === "compaction.strategy") {
						const committed = next as RiemannConfigFile;
						compactionStrategyCommit = {
							agentDir: dirname(configPath),
							previousStrategy,
							committedStrategy: committed.compaction?.strategy ?? "automatic",
						};
					}
				} catch (error) {
					await rm(temporaryPath, { force: true });
					throw error;
				}
			} finally {
				await release();
			}
			if (compactionStrategyCommit) notifyCompactionStrategySettingCommit(compactionStrategyCommit);
		});
	pendingConfigWrites.set(configPath, write);
	const clear = (): void => {
		if (pendingConfigWrites.get(configPath) === write) pendingConfigWrites.delete(configPath);
	};
	write.then(clear, clear);
	return write;
}

export function expandConfigSecret(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		const replacement = process.env[name];
		if (replacement === undefined) throw new Error(`Environment variable ${name} is not set`);
		return replacement;
	});
}

export function resolveConfigPath(value: string, sourceFile: string | undefined, cwd: string): string {
	if (isAbsolute(value)) return value;
	return resolve(sourceFile ? join(sourceFile, "..", value) : cwd, value);
}

export function getRiemannAgentDir(): string {
	return process.env.RIEMANN_CODING_AGENT_DIR ?? join(homedir(), ".riemann", "agent");
}
