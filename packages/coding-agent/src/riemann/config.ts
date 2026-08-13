import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";

const WorkspacePolicySchema = Type.Union([Type.Literal("shared"), Type.Literal("isolated"), Type.Literal("read-only")]);
const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);
const CompactionStrategySchema = Type.Union([
	Type.Literal("snapshot"),
	Type.Literal("default"),
	Type.Literal("openai"),
]);
const AgentProfileSchema = Type.Object(
	{
		description: Type.Optional(Type.String()),
		prompt: Type.Optional(Type.String()),
		promptFile: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		modelRole: Type.Optional(Type.String()),
		thinkingLevel: Type.Optional(ThinkingLevelSchema),
		capabilities: Type.Optional(Type.Array(Type.String())),
		workspace: Type.Optional(WorkspacePolicySchema),
		maxDepth: Type.Optional(Type.Integer({ minimum: 0 })),
		parkOnComplete: Type.Optional(Type.Boolean()),
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
		version: Type.Literal(1),
		limits: Type.Optional(
			Type.Object(
				{
					maxAgentsPerRun: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
					maxConcurrentPerRun: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
					maxConcurrentPerModel: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
					maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
					maxCellOutputChars: Type.Optional(Type.Integer({ minimum: 1_000 })),
					maxArtifactPreviewChars: Type.Optional(Type.Integer({ minimum: 1_000 })),
				},
				{ additionalProperties: false },
			),
		),
		compaction: Type.Optional(
			Type.Object({ strategy: Type.Optional(CompactionStrategySchema) }, { additionalProperties: false }),
		),
		models: Type.Optional(
			Type.Object(
				{ roles: Type.Optional(Type.Record(Type.String(), Type.String())) },
				{ additionalProperties: false },
			),
		),
		agents: Type.Optional(
			Type.Object(
				{ profiles: Type.Optional(Type.Record(Type.String(), AgentProfileSchema)) },
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
export type WorkspacePolicy = Static<typeof WorkspacePolicySchema>;

export interface RiemannConfig {
	limits: {
		maxAgentsPerRun: number;
		maxConcurrentPerRun: number;
		maxConcurrentPerModel: number;
		maxDepth: number;
		maxCellOutputChars: number;
		maxArtifactPreviewChars: number;
	};
	compaction: {
		strategy: "snapshot" | "default" | "openai";
	};
	modelRoles: Record<string, string>;
	profiles: Record<string, AgentProfileConfig>;
	mcpServers: Record<string, McpServerConfig>;
	web: {
		exaApiKey?: string;
		searchBackend: "exa" | "disabled";
	};
	files: string[];
}

const DEFAULTS: Omit<RiemannConfig, "files"> = {
	limits: {
		maxAgentsPerRun: 8,
		maxConcurrentPerRun: 4,
		maxConcurrentPerModel: 2,
		maxDepth: 3,
		maxCellOutputChars: 100_000,
		maxArtifactPreviewChars: 12_000,
	},
	compaction: { strategy: "snapshot" },
	modelRoles: {},
	profiles: {},
	mcpServers: {},
	web: { searchBackend: "exa" },
};

function mergeConfig(base: RiemannConfig, next: RiemannConfigFile, path: string): RiemannConfig {
	return {
		limits: { ...base.limits, ...next.limits },
		compaction: { ...base.compaction, ...next.compaction },
		modelRoles: { ...base.modelRoles, ...next.models?.roles },
		profiles: { ...base.profiles, ...next.agents?.profiles },
		mcpServers: { ...base.mcpServers, ...next.mcp?.servers },
		web: { ...base.web, ...next.web },
		files: [...base.files, path],
	};
}

async function parseConfigFile(path: string): Promise<RiemannConfigFile | undefined> {
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
	for (const [name, server] of Object.entries(value.mcp?.servers ?? {})) {
		const exposed = server.enabled !== false && server.exposeToModel !== false;
		if (exposed && (!server.description || server.description.trim().length === 0)) {
			throw new Error(`Invalid Riemann config ${path}: model-visible MCP server ${name} requires a description`);
		}
	}
	return value;
}

export async function loadRiemannConfig(options: {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): Promise<RiemannConfig> {
	let config: RiemannConfig = { ...DEFAULTS, limits: { ...DEFAULTS.limits }, files: [] };
	const globalPath = join(options.agentDir, "config.yaml");
	const globalConfig = await parseConfigFile(globalPath);
	if (globalConfig) config = mergeConfig(config, globalConfig, globalPath);
	if (options.projectTrusted) {
		const projectPath = join(options.cwd, ".riemann", "config.yaml");
		const projectConfig = await parseConfigFile(projectPath);
		if (projectConfig) config = mergeConfig(config, projectConfig, projectPath);
	}
	return config;
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
