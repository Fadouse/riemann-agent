import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentSessionEventListener, SessionStats } from "../../core/agent-session.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import type { CompactionPreparation, CompactionResult } from "../../core/compaction/index.ts";
import { execCommand } from "../../core/exec.ts";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "../../core/extensions/types.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { findMostRecentSession, SessionManager, sessionEntryToContextMessages } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { graphemeSafePrefix } from "../../utils/text.ts";
import { isFilesystemSubset, resolveFilesystemSnapshot } from "../access-policy.ts";
import { resolveCompactionStrategy } from "../compaction-strategy.ts";
import {
	type CompactionWarningTrigger,
	detectCompactionWarnings,
	latestActiveCompactionHasOpenAIContext,
} from "../compaction-warning.ts";
import {
	type AgentProfileConfig,
	type CompactionStrategySettingCommit,
	loadRiemannConfig,
	type RiemannConfig,
	subscribeCompactionStrategySettingCommits,
} from "../config.ts";
import { RiemannHostError } from "../errors.ts";
import type { FunctionDefinition } from "../functions/registry.ts";
import type { IPythonSchema, IPythonToolDetails } from "../ipython.ts";
import type { JsonValue } from "../kernel/types.ts";
import { getPreservedOpenAICompaction } from "../openai-compaction-state.ts";
import type { ArtifactStore } from "../state/artifacts.ts";
import type {
	AgentDeliveryMethod,
	AgentDeliveryMode,
	AgentOutcome,
	AgentStatus,
	RiemannStore,
	StoredAgent,
	StoredAgentTurn,
} from "../state/store.ts";

export interface ChildRiemannRuntime {
	tool: ToolDefinition<typeof IPythonSchema, IPythonToolDetails>;
	systemPrompt: string;
	compact(
		preparation: CompactionPreparation,
		customInstructions: string | undefined,
		signal: AbortSignal,
		context: Pick<ExtensionContext, "model" | "modelRegistry" | "getSystemPrompt" | "thinkingLevel">,
	): Promise<CompactionResult>;
	snapshot(): Promise<void>;
	close(): Promise<void>;
}

export type ChildRuntimeFactory = (agent: StoredAgent) => Promise<ChildRiemannRuntime>;

export interface ChildAgentSession {
	readonly state: { messages: readonly unknown[]; streamingMessage?: unknown };
	readonly model: Model<any> | undefined;
	readonly sessionManager: Pick<SessionManager, "getBranch">;
	readonly isStreaming: boolean;
	prompt(text: string, options: { source: "rpc" }): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	subscribe?(listener: AgentSessionEventListener): () => void;
	getSessionStats?(): SessionStats;
	dispose(): void;
}

interface LiveChild {
	agent: StoredAgent;
	turnId: string;
	session?: ChildAgentSession;
	runtime?: ChildRiemannRuntime;
	requestedStop: boolean;
	unsubscribeUi?: () => void;
	statsRefreshTimer?: NodeJS.Timeout;
}

interface SubagentRuntimeUi {
	task: string;
	startedAt?: string;
	turnCount: number;
	toolUses: number;
	tokens: number;
	currentTool?: string;
}

export interface SubagentUiSnapshot {
	id: string;
	name: string;
	turnId: string;
	status: AgentStatus;
	lastOutcome?: AgentOutcome;
	task: string;
	modelRole: string;
	model: string;
	workspace: string;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	result?: string;
	error?: string;
	transcriptHandle?: string;
	patchHandle?: string;
	turnCount: number;
	toolUses: number;
	tokens: number;
	currentTool?: string;
	messages: readonly unknown[];
	streamingMessage?: unknown;
	live: boolean;
}

interface Admission {
	agentId: string;
	turnId: string;
	resolve: (admitted: boolean) => void;
}

export interface AgentCompletionNotice {
	id: string;
	agentId: string;
	name: string;
	turnId: string;
	outcome: AgentOutcome;
}

export interface AgentEventDelivery {
	events: AgentCompletionNotice[];
}

export type CompactionWarningSink = (message: string) => void | Promise<void>;

const DEFAULT_CHILD_CAPABILITIES = ["fs.read", "fs.write", "shell.run", "web.search", "web.fetch", "mcp.*"];
const AGENT_OUTPUT_PREVIEW_CHARS = 160;
const SUBAGENT_STATS_REFRESH_MS = 32;

interface ChildCompactionWarningConfigLocation {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

interface ChildCompactionWarningEventInput {
	trigger: CompactionWarningTrigger;
	hasEncryptedOpenAIContext: boolean;
	model: ExtensionContext["model"];
	previousModel?: ExtensionContext["model"];
}

function childActiveBranchHasEncryptedOpenAIContext(ctx: ExtensionContext): boolean {
	try {
		return latestActiveCompactionHasOpenAIContext(ctx.sessionManager.getBranch());
	} catch {
		return false;
	}
}

function childPreparationHasEncryptedOpenAIContext(preparation: {
	previousPreserveData?: Record<string, unknown>;
}): boolean {
	try {
		return getPreservedOpenAICompaction(preparation.previousPreserveData) !== undefined;
	} catch {
		return false;
	}
}

async function warnForChildCompactionEvent(
	ctx: ExtensionContext,
	location: ChildCompactionWarningConfigLocation,
	warningSink: CompactionWarningSink | undefined,
	input: ChildCompactionWarningEventInput,
): Promise<void> {
	try {
		const configured = (await loadRiemannConfig(location)).compaction.strategy;
		const resolution = resolveCompactionStrategy(configured, input.model);
		const supportsOpenAICompaction =
			input.model?.provider === "openai-codex" && input.model.api === "openai-codex-responses";
		const previousEffectiveStrategy =
			input.trigger === "model-change"
				? resolveCompactionStrategy(configured, input.previousModel).effective
				: input.hasEncryptedOpenAIContext
					? "openai"
					: resolution.effective;
		const warnings = detectCompactionWarnings({
			trigger: input.trigger,
			hasEncryptedOpenAIContext: input.hasEncryptedOpenAIContext,
			previousEffectiveStrategy,
			effectiveStrategy: resolution.effective,
			currentModel: {
				supportsImageInput: input.model?.input.includes("image") ?? false,
				supportsOpenAICompaction,
				...(input.model ? { usingOAuth: ctx.modelRegistry.isUsingOAuth(input.model) } : {}),
			},
		});
		for (const warning of warnings) {
			try {
				const emitted = warningSink?.(warning.message);
				if (emitted) void emitted.catch(() => undefined);
			} catch {}
		}
	} catch {}
}

export function registerChildCompactionHooks(
	pi: ExtensionAPI,
	runtime: ChildRiemannRuntime,
	location: ChildCompactionWarningConfigLocation,
	warningSink?: CompactionWarningSink,
): void {
	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;
		await warnForChildCompactionEvent(ctx, location, warningSink, {
			trigger: "model-change",
			hasEncryptedOpenAIContext: childActiveBranchHasEncryptedOpenAIContext(ctx),
			model: event.model,
			previousModel: event.previousModel,
		});
	});
	pi.on("session_before_compact", async (event, ctx) => {
		await warnForChildCompactionEvent(ctx, location, warningSink, {
			trigger: "compaction-dispatch",
			hasEncryptedOpenAIContext: childPreparationHasEncryptedOpenAIContext(event.preparation),
			model: ctx.model,
		});
		return {
			compaction: await runtime.compact(event.preparation, event.customInstructions, event.signal, ctx),
		};
	});
}

function canonicalCapabilities(values: readonly string[]): string[] {
	return [
		...new Set(
			values.map((capability) => (capability === "*" || capability.includes(".") ? capability : `${capability}.*`)),
		),
	];
}

function requiredString(args: Record<string, JsonValue>, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || value.trim().length === 0)
		throw new RiemannHostError("invalid_arguments", `${name} must be a non-empty string`);
	return value;
}

function optionalString(args: Record<string, JsonValue>, name: string): string | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim().length === 0)
		throw new RiemannHostError("invalid_arguments", `${name} must be a non-empty string when provided`);
	return value;
}

function optionalTimeout(args: Record<string, JsonValue>, name = "timeout"): number | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 86_400) {
		throw new RiemannHostError("invalid_arguments", `${name} must be a positive number no greater than 86400`);
	}
	return value;
}

function turnHandleWire(agent: StoredAgent, turnId: string): JsonValue {
	if (agent.activeTurnId !== turnId || (agent.status !== "queued" && agent.status !== "running")) {
		throw new RiemannHostError("conflict", `Agent Turn is no longer active: ${agent.name}/${turnId}`);
	}
	return {
		$riemann: "agent_turn_handle.v1",
		id: agent.id,
		name: agent.name,
		turn_id: turnId,
		status: agent.status,
	};
}

function assistantText(message: unknown): string | undefined {
	if (
		typeof message !== "object" ||
		message === null ||
		!("role" in message) ||
		message.role !== "assistant" ||
		!("content" in message) ||
		!Array.isArray(message.content)
	) {
		return undefined;
	}
	return message.content
		.flatMap((part) =>
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n")
		.trim();
}

function finalAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const text = assistantText(messages[index]);
		if (text !== undefined) return text;
	}
	return "";
}

function currentAssistantText(messages: readonly unknown[], streamingMessage: unknown): string {
	const streamingText = assistantText(streamingMessage);
	if (streamingText) return streamingText;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message === "object" && message !== null && "role" in message && message.role === "user") break;
		const text = assistantText(message);
		if (text !== undefined) return text;
	}
	return "";
}

function outputPreview(value: string): string | null {
	const compact = value.replace(/\s+/g, " ").trim();
	if (!compact) return null;
	return compact.length <= AGENT_OUTPUT_PREVIEW_CHARS
		? compact
		: `${graphemeSafePrefix(compact, AGENT_OUTPUT_PREVIEW_CHARS - 1)}…`;
}

function artifactHandle(value: JsonValue): string {
	if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.handle !== "string") {
		throw new Error("Artifact creation did not return a handle");
	}
	return value.handle;
}

function messageStats(messages: readonly unknown[]): Pick<SubagentRuntimeUi, "turnCount" | "toolUses" | "tokens"> {
	let turnCount = 0;
	let toolUses = 0;
	let tokens = 0;
	for (const message of messages) {
		if (typeof message !== "object" || message === null || !("role" in message)) continue;
		if (message.role === "assistant") {
			turnCount += 1;
			if ("content" in message && Array.isArray(message.content)) {
				toolUses += message.content.filter(
					(part) => typeof part === "object" && part !== null && "type" in part && part.type === "toolCall",
				).length;
			}
			if (
				"usage" in message &&
				typeof message.usage === "object" &&
				message.usage !== null &&
				"totalTokens" in message.usage &&
				typeof message.usage.totalTokens === "number"
			) {
				tokens = Math.max(tokens, message.usage.totalTokens);
			}
		}
	}
	return { turnCount, toolUses, tokens };
}

export interface AgentSupervisorOptions {
	store: RiemannStore;
	artifacts: ArtifactStore;
	runId: string;
	rootAgent: StoredAgent;
	rootContext: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "thinkingLevel">;
	agentDir: string;
	projectTrusted?: boolean;
	config: RiemannConfig;
	createChildRuntime: ChildRuntimeFactory;
	createChildSession?: (
		agent: StoredAgent,
		model: Model<any>,
		runtime: ChildRiemannRuntime,
		resume: boolean,
	) => Promise<ChildAgentSession>;
	deliverAgentEvents?: (delivery: AgentEventDelivery) => Promise<void>;
	warningSink?: CompactionWarningSink;
}

export class AgentSupervisor {
	private readonly events = new EventEmitter();
	private readonly live = new Map<string, LiveChild>();
	private readonly queue: Admission[] = [];
	private readonly launches = new Set<Promise<void>>();
	private readonly cancelled = new Set<string>();
	private readonly subagentUi = new Map<string, SubagentRuntimeUi>();
	private readonly persistedMessages = new Map<string, readonly unknown[]>();
	private readonly waiters = new Map<string, number>();
	private readonly options: AgentSupervisorOptions;
	private readonly unsubscribeCompactionStrategySettingCommits: () => void;
	private running = 0;
	private closed = false;
	private deliveryInFlight: Promise<void> | undefined;

	constructor(options: AgentSupervisorOptions) {
		this.options = options;
		this.events.setMaxListeners(100);
		this.options.store.markInterruptedAgents(options.runId);
		for (const agent of this.options.store.listAgents(options.runId)) {
			if (agent.parentId === null) continue;
			const messages = this.loadPersistedMessages(agent);
			this.persistedMessages.set(agent.id, messages);
			const latestTurn = agent.lastTurnId ? this.options.store.getAgentTurn(agent.lastTurnId) : undefined;
			this.subagentUi.set(agent.id, { task: latestTurn?.task ?? agent.prompt, ...messageStats(messages) });
		}
		this.scheduleAgentEventDelivery();
		this.unsubscribeCompactionStrategySettingCommits = subscribeCompactionStrategySettingCommits((commit) => {
			this.warnLiveChildrenForCompactionStrategyCommit(commit);
		});
	}

	private warnLiveChildrenForCompactionStrategyCommit(commit: CompactionStrategySettingCommit): void {
		if (
			this.closed ||
			resolve(commit.agentDir) !== resolve(this.options.agentDir) ||
			this.options.config.projectOverrides.has("compaction.strategy")
		) {
			return;
		}
		for (const live of this.live.values()) {
			const session = live.session;
			if (!session) continue;
			try {
				const model = session.model;
				const supportsOpenAICompaction =
					model?.provider === "openai-codex" && model.api === "openai-codex-responses";
				const warnings = detectCompactionWarnings({
					trigger: "strategy-change",
					hasEncryptedOpenAIContext: latestActiveCompactionHasOpenAIContext(session.sessionManager.getBranch()),
					previousEffectiveStrategy: resolveCompactionStrategy(commit.previousStrategy, model).effective,
					effectiveStrategy: resolveCompactionStrategy(commit.committedStrategy, model).effective,
					currentModel: {
						supportsImageInput: model?.input.includes("image") ?? false,
						supportsOpenAICompaction,
						...(model ? { usingOAuth: this.options.rootContext.modelRegistry.isUsingOAuth(model) } : {}),
					},
				});
				for (const warning of warnings) {
					try {
						const emitted = this.options.warningSink?.(warning.message);
						if (emitted) void emitted.catch(() => undefined);
					} catch {}
				}
			} catch {}
		}
	}

	listSubagentsForUi(): SubagentUiSnapshot[] {
		return this.options.store
			.listAgents(this.options.runId)
			.filter((agent) => agent.parentId !== null)
			.map((agent) => {
				const live = this.live.get(agent.id);
				const runtime = this.subagentUi.get(agent.id);
				return {
					id: agent.id,
					name: agent.name,
					turnId: agent.activeTurnId ?? agent.lastTurnId ?? "",
					status: agent.status,
					...(agent.lastOutcome ? { lastOutcome: agent.lastOutcome } : {}),
					task: runtime?.task ?? agent.prompt,
					modelRole: agent.modelRole,
					model: this.modelLabel(agent),
					workspace: agent.workspace,
					createdAt: agent.createdAt,
					updatedAt: agent.updatedAt,
					...(runtime?.startedAt ? { startedAt: runtime.startedAt } : {}),
					...(agent.result ? { result: agent.result } : {}),
					...(agent.error ? { error: agent.error } : {}),
					...(agent.transcriptHandle ? { transcriptHandle: agent.transcriptHandle } : {}),
					...(agent.patchHandle ? { patchHandle: agent.patchHandle } : {}),
					turnCount: runtime?.turnCount ?? 0,
					toolUses: runtime?.toolUses ?? 0,
					tokens: runtime?.tokens ?? 0,
					...(runtime?.currentTool ? { currentTool: runtime.currentTool } : {}),
					messages: live?.session?.state.messages ?? this.persistedMessages.get(agent.id) ?? [],
					...(live?.session?.state.streamingMessage
						? { streamingMessage: live.session.state.streamingMessage }
						: {}),
					live: live?.session !== undefined,
				};
			});
	}

	subscribeSubagentUi(listener: () => void): () => void {
		const identifiedListener: (agentId?: string) => void = listener;
		const guarded = (agentId?: string) => {
			try {
				identifiedListener(agentId);
			} catch {}
		};
		this.events.on("subagents", guarded);
		return () => this.events.removeListener("subagents", guarded);
	}

	async steerSubagentFromUi(agentId: string, message: string): Promise<void> {
		const agent = this.ownedChild(this.options.rootAgent.id, agentId);
		if (!agent.lastTurnId) throw new RiemannHostError("not_found", `Agent ${agent.name} has no Turn`);
		await this.steerMessage(this.options.rootAgent.id, agent.id, agent.lastTurnId, message);
	}

	async stopSubagentFromUi(agentId: string): Promise<void> {
		const agent = this.ownedChild(this.options.rootAgent.id, agentId);
		if (!agent.lastTurnId) throw new RiemannHostError("not_found", `Agent ${agent.name} has no Turn`);
		await this.stopTurn(this.options.rootAgent.id, agent.id, agent.lastTurnId, new AbortController().signal);
	}

	async releaseSubagentFromUi(agentId: string): Promise<void> {
		const agent = this.ownedChild(this.options.rootAgent.id, agentId);
		if (!agent.lastTurnId) throw new RiemannHostError("not_found", `Agent ${agent.name} has no Turn`);
		await this.releaseAgent(this.options.rootAgent.id, agent.id, agent.lastTurnId);
	}

	private notifySubagentUi(agentId?: string): void {
		this.events.emit("subagents", agentId);
	}

	private notify(agentId: string): void {
		this.events.emit(`agent:${agentId}`);
		this.notifySubagentUi(agentId);
	}

	private notifyTurn(agentId: string, turnId: string): void {
		this.events.emit(`turn:${turnId}`);
		this.notify(agentId);
	}

	private findAgent(selector: string): StoredAgent {
		const agents = this.options.store.listAgents(this.options.runId);
		const exactId = agents.find((agent) => agent.id === selector);
		if (exactId) return exactId;
		const named = agents.filter((agent) => agent.name === selector);
		if (named.length > 1) throw new RiemannHostError("conflict", `Agent name is ambiguous in this run: ${selector}`);
		const exact = named[0];
		if (!exact) throw new RiemannHostError("not_found", `Agent not found in this run: ${selector}`);
		return exact;
	}

	private ownedChild(callerId: string, selector: string): StoredAgent {
		const caller = this.findAgent(callerId);
		const child = this.findAgent(selector);
		if (child.parentId !== caller.id) {
			throw new RiemannHostError("permission_denied", `${child.name} is not a direct child of ${caller.name}`);
		}
		return child;
	}

	private ownedTurn(callerId: string, agentId: string, turnId: string): { agent: StoredAgent; turn: StoredAgentTurn } {
		const agent = this.ownedChild(callerId, agentId);
		const turn = this.options.store.getAgentTurn(turnId);
		if (!turn || turn.agentId !== agent.id) {
			throw new RiemannHostError("not_found", `Agent Turn not found: ${agent.name}/${turnId}`);
		}
		return { agent, turn };
	}

	private latestTurn(agent: StoredAgent): StoredAgentTurn {
		const turn = agent.lastTurnId ? this.options.store.getAgentTurn(agent.lastTurnId) : undefined;
		if (!turn) throw new RiemannHostError("not_found", `Agent ${agent.name} has no Turn`);
		return turn;
	}

	private agentInfoWire(agent: StoredAgent): JsonValue {
		const turn = this.latestTurn(agent);
		const liveSession = this.live.get(agent.id)?.session;
		const latestOutput = agent.activeTurnId
			? currentAssistantText(liveSession?.state.messages ?? [], liveSession?.state.streamingMessage)
			: (turn.result ?? "");
		return {
			$riemann: "agent_info.v1",
			id: agent.id,
			name: agent.name,
			turn_id: turn.id,
			status: agent.status,
			parent_id: agent.parentId,
			task: turn.task,
			profile: agent.modelRole === "inherit" ? null : agent.modelRole,
			model: this.modelLabel(agent),
			workspace: agent.workspace,
			active_turn_id: agent.activeTurnId,
			last_turn_id: agent.lastTurnId,
			last_outcome: agent.lastOutcome,
			output_preview: outputPreview(latestOutput),
			created_at: agent.createdAt,
			updated_at: agent.updatedAt,
		};
	}

	private agentResultWire(agent: StoredAgent, turn: StoredAgentTurn): JsonValue {
		if (turn.status !== "settled" || !turn.outcome) {
			throw new RiemannHostError("conflict", `Agent Turn has not settled: ${agent.name}/${turn.id}`);
		}
		return {
			$riemann: "agent_result.v1",
			id: agent.id,
			name: agent.name,
			turn_id: turn.id,
			status: turn.outcome === "cancelled" ? "stopped" : "idle",
			outcome: turn.outcome,
			output: turn.result ?? "",
			error: turn.error,
			transcript_handle: turn.transcriptHandle ?? "",
			patch_handle: turn.patchHandle,
			started_at: turn.startedAt ?? turn.createdAt,
			completed_at: turn.completedAt ?? turn.updatedAt,
		};
	}

	/** Inventory-time filesystem check; spawn repeats it with the resolved workspace. */
	private profileFilesystemAllowed(caller: StoredAgent, profile: AgentProfileConfig): boolean {
		if (profile.filesystem === undefined) return true;
		const mode = profile.workspace ?? this.options.config.agentDefaults.workspace;
		const snapshot = resolveFilesystemSnapshot({
			config: profile.filesystem,
			mode,
			workspace: caller.workspace,
			parent: caller.filesystem,
		});
		return isFilesystemSubset(snapshot, caller.filesystem);
	}

	private availableProfileEntries(caller: StoredAgent): Array<[string, AgentProfileConfig]> {
		return Object.entries(this.options.config.profiles)
			.filter(([, profile]) => {
				if (!this.profileFilesystemAllowed(caller, profile)) return false;
				const capabilities = profile.capabilities
					? canonicalCapabilities(profile.capabilities)
					: this.defaultCapabilities(caller);
				return capabilities.every((capability) => this.canGrantCapability(caller, capability));
			})
			.sort(([left], [right]) => left.localeCompare(right));
	}

	private resolveProfile(caller: StoredAgent, name: string | undefined): AgentProfileConfig | undefined {
		if (!name) return undefined;
		const profile = this.options.config.profiles[name];
		if (profile) return profile;
		const availableNames = this.availableProfileEntries(caller).map(([profileName]) => JSON.stringify(profileName));
		const guidance =
			availableNames.length > 0
				? `Available profiles: ${availableNames.join(", ")}. Omit profile to use child defaults.`
				: Object.keys(this.options.config.profiles).length === 0
					? "No Agent profiles are configured; omit profile to use child defaults."
					: "No Agent profiles are available to this Agent; omit profile to use child defaults.";
		throw new RiemannHostError("not_found", `Agent profile not found: ${JSON.stringify(name)}. ${guidance}`);
	}

	private async initialAgentPrompt(profile: AgentProfileConfig | undefined, task: string): Promise<string> {
		const sections: string[] = [];
		if (profile?.promptFile) {
			const candidates = isAbsolute(profile.promptFile)
				? [profile.promptFile]
				: [
						resolve(this.options.rootContext.cwd, ".riemann", profile.promptFile),
						resolve(this.options.agentDir, profile.promptFile),
					];
			let selected: string | undefined;
			for (const candidate of candidates) {
				try {
					await access(candidate);
					selected = candidate;
					break;
				} catch {}
			}
			if (!selected)
				throw new RiemannHostError("not_found", `Agent profile prompt file not found: ${profile.promptFile}`);
			sections.push((await readFile(selected, "utf8")).trim());
		}
		if (profile?.prompt) sections.push(profile.prompt.trim());
		sections.push(task);
		return sections.filter(Boolean).join("\n\n");
	}

	private resolveModel(profile: AgentProfileConfig | undefined): Model<any> {
		const selector = profile?.model ?? this.options.config.agentDefaults.model;
		if (!selector) {
			if (!this.options.rootContext.model)
				throw new RiemannHostError("not_configured", "No parent model is selected for this child");
			return this.options.rootContext.model;
		}
		const separator = selector.indexOf("/");
		if (separator <= 0 || separator === selector.length - 1)
			throw new RiemannHostError("invalid_config", `Model selector must be provider/model: ${selector}`);
		const model = this.options.rootContext.modelRegistry.find(
			selector.slice(0, separator),
			selector.slice(separator + 1),
		);
		if (!model) throw new RiemannHostError("not_found", `Configured model is unavailable: ${selector}`);
		return model;
	}

	private modelForAgent(agent: StoredAgent): Model<any> {
		const profile = agent.modelRole === "inherit" ? undefined : this.options.config.profiles[agent.modelRole];
		return this.resolveModel(profile);
	}

	private modelLabel(agent: StoredAgent): string {
		const profile = agent.modelRole === "inherit" ? undefined : this.options.config.profiles[agent.modelRole];
		const selector = profile?.model ?? this.options.config.agentDefaults.model;
		if (selector) return selector;
		const parent = this.options.rootContext.model;
		return parent ? `${parent.provider}/${parent.id}` : "unconfigured";
	}

	private canGrantCapability(caller: StoredAgent, capability: string): boolean {
		if (caller.capabilities.includes("*")) return true;
		const namespace = capability.split(".", 1)[0];
		return caller.capabilities.includes(capability) || caller.capabilities.includes(`${namespace}.*`);
	}

	private defaultCapabilities(caller: StoredAgent): string[] {
		return DEFAULT_CHILD_CAPABILITIES.filter((capability) => this.canGrantCapability(caller, capability));
	}

	private resolveCapabilities(caller: StoredAgent, requested: string[]): string[] {
		for (const capability of requested) {
			if (!this.canGrantCapability(caller, capability)) {
				throw new RiemannHostError(
					"permission_denied",
					`Child capability ${capability} is not held by parent ${caller.name}`,
				);
			}
		}
		return requested;
	}

	private async worktreeWorkspace(agentId: string, parentWorkspace: string): Promise<string> {
		const probe = await execCommand("git", ["-C", parentWorkspace, "rev-parse", "--show-toplevel"], parentWorkspace, {
			timeout: 15_000,
		});
		if (probe.code !== 0)
			throw new RiemannHostError(
				"workspace_error",
				`Isolated workspace requires a Git worktree: ${probe.stderr.trim()}`,
			);
		const repository = probe.stdout.trim();
		const workspaceRoot = join(this.options.agentDir, "state", "workspaces", this.options.runId);
		const worktree = join(workspaceRoot, agentId);
		await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
		const add = await execCommand(
			"git",
			["-C", repository, "worktree", "add", "--detach", worktree, "HEAD"],
			repository,
			{ timeout: 60_000 },
		);
		if (add.code !== 0)
			throw new RiemannHostError("workspace_error", `Could not create Git worktree: ${add.stderr.trim()}`);
		const subdirectory = relative(repository, parentWorkspace);
		return subdirectory ? join(worktree, subdirectory) : worktree;
	}

	private async removeWorktree(agent: StoredAgent): Promise<void> {
		const worktreeProbe = await execCommand(
			"git",
			["-C", agent.workspace, "rev-parse", "--show-toplevel"],
			agent.workspace,
			{ timeout: 15_000 },
		);
		if (worktreeProbe.code !== 0)
			throw new RiemannHostError(
				"workspace_error",
				`Could not resolve child worktree: ${worktreeProbe.stderr.trim()}`,
			);
		const repositoryProbe = await execCommand(
			"git",
			["-C", this.options.rootAgent.workspace, "rev-parse", "--show-toplevel"],
			this.options.rootAgent.workspace,
			{ timeout: 15_000 },
		);
		if (repositoryProbe.code !== 0)
			throw new RiemannHostError(
				"workspace_error",
				`Could not resolve parent repository: ${repositoryProbe.stderr.trim()}`,
			);
		const removed = await execCommand(
			"git",
			["-C", repositoryProbe.stdout.trim(), "worktree", "remove", "--force", worktreeProbe.stdout.trim()],
			repositoryProbe.stdout.trim(),
			{ timeout: 60_000 },
		);
		if (removed.code !== 0)
			throw new RiemannHostError("workspace_error", `Could not remove child worktree: ${removed.stderr.trim()}`);
	}

	private async acquire(agentId: string, turnId: string): Promise<boolean> {
		if (this.running < this.options.config.maxConcurrentAgents) {
			this.running += 1;
			return true;
		}
		return new Promise<boolean>((resolve) => {
			this.queue.push({ agentId, turnId, resolve });
		});
	}

	private cancelAdmission(agentId: string, turnId: string): boolean {
		const queued = this.queue.findIndex((item) => item.agentId === agentId && item.turnId === turnId);
		if (queued < 0) return false;
		const [admission] = this.queue.splice(queued, 1);
		this.cancelled.add(turnId);
		admission?.resolve(false);
		return true;
	}

	private releaseAdmission(): void {
		this.running = Math.max(0, this.running - 1);
		while (this.running < this.options.config.maxConcurrentAgents && this.queue.length > 0) {
			const admission = this.queue.shift();
			if (!admission) continue;
			this.running += 1;
			admission.resolve(true);
		}
	}

	private async warnForStartedChild(session: ChildAgentSession): Promise<void> {
		try {
			const configured = (
				await loadRiemannConfig({
					cwd: this.options.rootContext.cwd,
					agentDir: this.options.agentDir,
					projectTrusted: this.options.projectTrusted ?? true,
				})
			).compaction.strategy;
			const model = session.model;
			const resolution = resolveCompactionStrategy(configured, model);
			const hasEncryptedOpenAIContext = latestActiveCompactionHasOpenAIContext(session.sessionManager.getBranch());
			const supportsOpenAICompaction = model?.provider === "openai-codex" && model.api === "openai-codex-responses";
			const warnings = detectCompactionWarnings({
				trigger: "session-resume",
				hasEncryptedOpenAIContext,
				previousEffectiveStrategy: hasEncryptedOpenAIContext ? "openai" : resolution.effective,
				effectiveStrategy: resolution.effective,
				currentModel: {
					supportsImageInput: model?.input.includes("image") ?? false,
					supportsOpenAICompaction,
					...(model ? { usingOAuth: this.options.rootContext.modelRegistry.isUsingOAuth(model) } : {}),
				},
			});
			for (const warning of warnings) {
				try {
					const emitted = this.options.warningSink?.(warning.message);
					if (emitted) void emitted.catch(() => undefined);
				} catch {}
			}
		} catch {}
	}

	private async createDefaultSession(
		agent: StoredAgent,
		model: Model<any>,
		runtime: ChildRiemannRuntime,
		resume: boolean,
	): Promise<ChildAgentSession> {
		const sessionDir = join(this.options.agentDir, "state", "child-sessions", agent.id);
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(this.options.agentDir, "auth.json")),
			modelsPath: join(this.options.agentDir, "models.json"),
		});
		for (const providerId of this.options.rootContext.modelRegistry.getRegisteredProviderIds()) {
			const provider = this.options.rootContext.modelRegistry.getRegisteredNativeProvider(providerId);
			if (provider) {
				modelRuntime.registerNativeProvider(provider);
				continue;
			}
			const providerConfig = this.options.rootContext.modelRegistry.getRegisteredProviderConfig(providerId);
			if (providerConfig) modelRuntime.registerProvider(providerId, providerConfig);
		}
		await mkdir(sessionDir, { recursive: true, mode: 0o700 });
		const settingsManager = SettingsManager.create(agent.workspace, this.options.agentDir, { projectTrusted: true });
		const resourceLoader = new DefaultResourceLoader({
			cwd: agent.workspace,
			agentDir: this.options.agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			systemPromptOverride: () => runtime.systemPrompt,
			extensionFactories: [
				{
					name: "Riemann child compaction",
					hidden: true,
					factory: (pi) =>
						registerChildCompactionHooks(
							pi,
							runtime,
							{
								cwd: this.options.rootContext.cwd,
								agentDir: this.options.agentDir,
								projectTrusted: this.options.projectTrusted ?? true,
							},
							this.options.warningSink,
						),
				},
			],
		});
		await resourceLoader.reload();
		const sessionManager = resume
			? SessionManager.continueRecent(agent.workspace, sessionDir)
			: SessionManager.create(agent.workspace, sessionDir);
		const created = await createAgentSession({
			cwd: agent.workspace,
			agentDir: this.options.agentDir,
			model,
			modelRuntime,
			thinkingLevel:
				this.options.config.profiles[agent.modelRole]?.thinkingLevel ?? this.options.rootContext.thinkingLevel,
			tools: ["ipython"],
			customTools: [defineTool(runtime.tool)],
			resourceLoader,
			sessionManager,
			settingsManager,
			sessionStartEvent: { type: "session_start", reason: resume ? "resume" : "new" },
		});
		await this.warnForStartedChild(created.session);
		return created.session;
	}

	private refreshSubagentStats(agentId: string, live: LiveChild): void {
		const runtime = this.subagentUi.get(agentId);
		const stats = live.session?.getSessionStats?.();
		if (!runtime || !stats) return;
		runtime.turnCount = Math.max(runtime.turnCount, stats.assistantMessages);
		runtime.toolUses = Math.max(runtime.toolUses, stats.toolCalls);
		runtime.tokens = stats.tokens.total;
	}

	private scheduleSubagentStatsRefresh(agentId: string, live: LiveChild): void {
		if (live.statsRefreshTimer || !live.session?.getSessionStats) return;
		live.statsRefreshTimer = setTimeout(() => {
			live.statsRefreshTimer = undefined;
			if (this.live.get(agentId) !== live) return;
			this.refreshSubagentStats(agentId, live);
			this.notifySubagentUi(agentId);
		}, SUBAGENT_STATS_REFRESH_MS);
		live.statsRefreshTimer.unref?.();
	}

	private flushSubagentStats(agentId: string, live: LiveChild): void {
		if (live.statsRefreshTimer) {
			clearTimeout(live.statsRefreshTimer);
			live.statsRefreshTimer = undefined;
		}
		this.refreshSubagentStats(agentId, live);
	}

	private cancelSubagentStatsRefresh(live: LiveChild): void {
		if (!live.statsRefreshTimer) return;
		clearTimeout(live.statsRefreshTimer);
		live.statsRefreshTimer = undefined;
	}

	private observeSubagentEvent(
		agentId: string,
		live: LiveChild,
		event: Parameters<AgentSessionEventListener>[0],
	): void {
		const runtime = this.subagentUi.get(agentId);
		if (!runtime) return;
		if (event.type === "turn_start") runtime.turnCount += 1;
		else if (event.type === "tool_execution_start") {
			runtime.toolUses += 1;
			runtime.currentTool = event.toolName;
		} else if (event.type === "tool_execution_end" && runtime.currentTool === event.toolName) {
			runtime.currentTool = undefined;
		} else if (event.type === "agent_end" || event.type === "agent_settled") {
			runtime.currentTool = undefined;
		}
		this.scheduleSubagentStatsRefresh(agentId, live);
		this.notifySubagentUi(agentId);
	}

	private loadPersistedMessages(agent: StoredAgent): readonly unknown[] {
		const sessionDir = join(this.options.agentDir, "state", "child-sessions", agent.id);
		const sessionFile = findMostRecentSession(sessionDir, agent.workspace);
		if (!sessionFile) return [];
		try {
			const manager = SessionManager.open(sessionFile, sessionDir, agent.workspace);
			return manager.getEntries().flatMap((entry) => sessionEntryToContextMessages(entry));
		} catch {
			return [];
		}
	}

	private trackBackground(promise: Promise<void>): void {
		this.launches.add(promise);
		void promise.catch(() => undefined).finally(() => this.launches.delete(promise));
	}

	private startLaunch(
		agent: StoredAgent,
		turn: StoredAgentTurn,
		model: Model<any>,
		resume: boolean,
		prompt: string,
	): void {
		this.trackBackground(this.launch(agent, turn, model, resume, prompt));
	}

	private async launch(
		agent: StoredAgent,
		turn: StoredAgentTurn,
		model: Model<any>,
		resume: boolean,
		prompt: string,
	): Promise<void> {
		const admitted = await this.acquire(agent.id, turn.id);
		if (!admitted) {
			this.cancelled.delete(turn.id);
			return;
		}
		const current = this.options.store.getAgent(agent.id);
		const currentTurn = this.options.store.getAgentTurn(turn.id);
		if (
			this.closed ||
			this.cancelled.delete(turn.id) ||
			!current ||
			!currentTurn ||
			current.releasedAt !== null ||
			current.activeTurnId !== turn.id ||
			current.status !== "queued" ||
			currentTurn.status !== "queued"
		) {
			this.releaseAdmission();
			return;
		}
		this.options.store.markAgentTurnRunning(agent.id, turn.id);
		const runningAgent = this.options.store.getAgent(agent.id);
		if (!runningAgent) {
			this.releaseAdmission();
			return;
		}
		const live: LiveChild = { agent: runningAgent, turnId: turn.id, requestedStop: false };
		this.live.set(agent.id, live);
		const runtimeUi = this.subagentUi.get(agent.id);
		if (runtimeUi) {
			runtimeUi.startedAt = new Date().toISOString();
			runtimeUi.currentTool = undefined;
		}
		this.notifyTurn(agent.id, turn.id);
		let outcome: AgentOutcome = "ok";
		let executionError: string | null = null;
		try {
			const runtime = await this.options.createChildRuntime(runningAgent);
			live.runtime = runtime;
			const session = this.options.createChildSession
				? await this.options.createChildSession(runningAgent, model, runtime, resume)
				: await this.createDefaultSession(runningAgent, model, runtime, resume);
			live.session = session;
			live.unsubscribeUi = session.subscribe?.((event) => this.observeSubagentEvent(agent.id, live, event));
			this.refreshSubagentStats(agent.id, live);
			this.notifySubagentUi(agent.id);
			if (this.closed || live.requestedStop) {
				await session.abort();
				throw new Error("Agent stopped before its turn started");
			}
			const inbox = this.options.store.listInbox(runningAgent.id, { unreadOnly: true, markDelivered: true });
			const incoming = inbox.map(
				(message) => `[Agent message ${message.id} from ${this.findAgent(message.senderId).name}]\n${message.body}`,
			);
			const effectivePrompt = [prompt, ...incoming].filter(Boolean).join("\n\n");
			await session.prompt(effectivePrompt, { source: "rpc" });
			await runtime.snapshot();
			if (live.requestedStop) outcome = "cancelled";
		} catch (error) {
			outcome = live.requestedStop || this.closed ? "cancelled" : "error";
			if (outcome === "error") executionError = error instanceof Error ? error.message : String(error);
		} finally {
			const messages = [...(live.session?.state.messages ?? this.persistedMessages.get(agent.id) ?? [])];
			try {
				this.flushSubagentStats(agent.id, live);
				await this.settleAgent(
					runningAgent,
					turn.id,
					outcome,
					finalAssistantText(messages),
					executionError,
					messages,
				);
			} finally {
				this.cancelSubagentStatsRefresh(live);
				live.unsubscribeUi?.();
				live.unsubscribeUi = undefined;
				live.session?.dispose();
				await live.runtime?.close().catch(() => undefined);
				if (this.live.get(agent.id) === live) this.live.delete(agent.id);
				this.releaseAdmission();
				this.notifyTurn(agent.id, turn.id);
			}
		}
		if (!this.closed) await this.wakeUnreadAgent(agent.id);
	}

	private async captureWorktreePatch(agent: StoredAgent, turnId: string): Promise<string | null> {
		if (agent.workspaceMode !== "worktree") return null;
		const tracked = await execCommand(
			"git",
			["-C", agent.workspace, "diff", "--binary", "--no-ext-diff", "HEAD", "--"],
			agent.workspace,
			{ timeout: 60_000 },
		);
		if (tracked.code !== 0)
			throw new RiemannHostError("workspace_error", `Could not capture child patch: ${tracked.stderr.trim()}`);
		const untracked = await execCommand(
			"git",
			["-C", agent.workspace, "ls-files", "--others", "--exclude-standard", "-z"],
			agent.workspace,
			{ timeout: 60_000 },
		);
		if (untracked.code !== 0)
			throw new RiemannHostError("workspace_error", `Could not list child files: ${untracked.stderr.trim()}`);
		const sections = [tracked.stdout];
		for (const path of untracked.stdout.split("\0").filter(Boolean)) {
			const diff = await execCommand(
				"git",
				["-C", agent.workspace, "diff", "--binary", "--no-index", "--", "/dev/null", path],
				agent.workspace,
				{ timeout: 60_000 },
			);
			if (diff.code !== 0 && diff.code !== 1)
				throw new RiemannHostError(
					"workspace_error",
					`Could not capture new child file ${path}: ${diff.stderr.trim()}`,
				);
			sections.push(diff.stdout);
		}
		const patch = sections.join("").trim();
		if (!patch) return null;
		return artifactHandle(
			await this.options.artifacts.putText(`${patch}\n`, {
				name: `${agent.name}-${agent.id.slice(0, 8)}-${turnId.slice(0, 8)}.patch`,
				mimeType: "text/x-diff; charset=utf-8",
			}),
		);
	}

	private async settleAgent(
		agent: StoredAgent,
		turnId: string,
		requestedOutcome: AgentOutcome,
		result: string,
		error: string | null,
		messages: readonly unknown[],
	): Promise<StoredAgentTurn> {
		const currentTurn = this.options.store.getAgentTurn(turnId);
		if (!currentTurn || currentTurn.agentId !== agent.id) {
			throw new RiemannHostError("not_found", `Agent Turn not found: ${agent.name}/${turnId}`);
		}
		if (currentTurn.status === "settled") return currentTurn;
		const transcriptHandle = artifactHandle(
			await this.options.artifacts.putText(`${JSON.stringify(messages, null, 2)}\n`, {
				name: `${agent.name}-${agent.id.slice(0, 8)}-${turnId.slice(0, 8)}-transcript.json`,
				mimeType: "application/json",
			}),
		);
		let outcome = requestedOutcome;
		let settlementError = error;
		let patchHandle: string | null = null;
		try {
			patchHandle = await this.captureWorktreePatch(agent, turnId);
		} catch (patchError) {
			outcome = "error";
			settlementError = `Patch capture failed: ${patchError instanceof Error ? patchError.message : String(patchError)}`;
		}
		this.persistedMessages.set(agent.id, messages);
		const delivery: AgentDeliveryMethod =
			currentTurn.deliveryMode === "return" ? "return" : (this.waiters.get(turnId) ?? 0) > 0 ? "wait" : "notify";
		const settlement = this.options.store.settleAgentTurn({
			agentId: agent.id,
			turnId,
			outcome,
			result,
			error: settlementError,
			transcriptHandle,
			patchHandle,
			delivery,
			...(delivery === "notify"
				? {
						event: {
							recipientId: agent.parentId ?? this.options.rootAgent.id,
							payload: {
								agentId: agent.id,
								name: agent.name,
								turnId,
								outcome,
							},
						},
					}
				: {}),
		});
		if (delivery === "notify") this.scheduleAgentEventDelivery();
		this.notifyTurn(agent.id, turnId);
		return settlement.turn;
	}

	private startQueuedCancellation(agent: StoredAgent, turnId: string): void {
		this.trackBackground(
			this.settleAgent(agent, turnId, "cancelled", "", null, this.persistedMessages.get(agent.id) ?? []).then(
				() => undefined,
			),
		);
	}

	private scheduleAgentEventDelivery(): void {
		if (
			this.closed ||
			!this.options.deliverAgentEvents ||
			this.deliveryInFlight ||
			this.options.store.listPendingAgentEvents(this.options.rootAgent.id).length === 0
		)
			return;
		void this.flushAgentEvents().catch(() => undefined);
	}

	async flushAgentEvents(): Promise<void> {
		if (!this.options.deliverAgentEvents) return;
		if (this.deliveryInFlight) {
			await this.deliveryInFlight;
			return;
		}
		const events = this.options.store.listPendingAgentEvents(this.options.rootAgent.id);
		if (events.length === 0) return;
		const eventIds = events.map((event) => event.id);
		const delivery: AgentEventDelivery = {
			events: events.map((event) => ({ id: event.id, ...event.payload })),
		};
		let delivered = false;
		const deliveryInFlight = this.options.deliverAgentEvents(delivery).then(() => {
			this.options.store.markAgentEventsDelivered(eventIds);
			delivered = true;
		});
		this.deliveryInFlight = deliveryInFlight;
		try {
			await deliveryInFlight;
		} finally {
			if (this.deliveryInFlight === deliveryInFlight) this.deliveryInFlight = undefined;
			if (delivered) this.scheduleAgentEventDelivery();
		}
	}

	private async wakeUnreadAgent(agentId: string): Promise<void> {
		const agent = this.options.store.getAgent(agentId);
		if (
			this.closed ||
			!agent ||
			agent.releasedAt !== null ||
			(agent.status !== "idle" && agent.status !== "stopped") ||
			this.live.has(agentId) ||
			this.queue.some((item) => item.agentId === agentId)
		) {
			return;
		}
		const unread = this.options.store.listInbox(agentId, { unreadOnly: true });
		if (unread.length === 0) return;
		const task = unread.map((message) => message.body).join("\n\n");
		await this.queueExistingAgent(agent, task, "", "notify");
	}

	private async queueExistingAgent(
		agent: StoredAgent,
		task: string,
		prompt = task,
		deliveryMode: AgentDeliveryMode = "notify",
	): Promise<{ agent: StoredAgent; turn: StoredAgentTurn }> {
		if (
			agent.activeTurnId !== null ||
			this.live.has(agent.id) ||
			this.queue.some((item) => item.agentId === agent.id)
		) {
			throw new RiemannHostError("conflict", `Agent ${agent.name} already has an active Turn`);
		}
		const model = this.modelForAgent(agent);
		const runtime = this.subagentUi.get(agent.id) ?? {
			task,
			...messageStats(this.persistedMessages.get(agent.id) ?? []),
		};
		runtime.task = task;
		runtime.startedAt = undefined;
		runtime.currentTool = undefined;
		this.subagentUi.set(agent.id, runtime);
		let started: { agent: StoredAgent; turn: StoredAgentTurn };
		try {
			started = this.options.store.startAgentTurn({ agentId: agent.id, task, prompt, deliveryMode });
		} catch (error) {
			throw new RiemannHostError("conflict", error instanceof Error ? error.message : String(error));
		}
		this.cancelled.delete(started.turn.id);
		this.notifyTurn(agent.id, started.turn.id);
		this.startLaunch(started.agent, started.turn, model, true, prompt);
		return started;
	}

	private async startAgent(
		callerId: string,
		args: Record<string, JsonValue>,
	): Promise<{ agent: StoredAgent; turn: StoredAgentTurn }> {
		const caller = this.findAgent(callerId);
		if (caller.depth >= 1) {
			throw new RiemannHostError("limit_exceeded", "Agent recursion depth is fixed at 1");
		}
		const task = requiredString(args, "task");
		const profileName = optionalString(args, "profile");
		const requestedProfile = this.resolveProfile(caller, profileName);
		const requestedName = optionalString(args, "name");
		const reuse = args.reuse ?? "never";
		if (reuse !== "never" && reuse !== "exact") {
			throw new RiemannHostError("invalid_arguments", "reuse must be never or exact");
		}
		if (reuse === "exact" && requestedName === undefined) {
			throw new RiemannHostError("invalid_arguments", "name is required when reuse is exact");
		}
		const name = requestedName ?? `agent-${randomUUID().slice(0, 8)}`;
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
			throw new RiemannHostError(
				"invalid_arguments",
				"name must use 1-64 letters, digits, dots, dashes, or underscores",
			);
		}

		const workspaceMode = requestedProfile?.workspace ?? this.options.config.agentDefaults.workspace;
		const filesystemConfig = requestedProfile?.filesystem ?? this.options.config.agentDefaults.filesystem;
		const childFilesystem = (workspace: string, mode: "shared" | "worktree", granted: string[] = []) => {
			const snapshot = resolveFilesystemSnapshot({
				config: filesystemConfig,
				mode,
				workspace,
				parent: caller.filesystem,
			});
			if (!isFilesystemSubset(snapshot, caller.filesystem, granted)) {
				throw new RiemannHostError(
					"permission_denied",
					`Child filesystem exceeds parent ${caller.name} filesystem policy`,
				);
			}
			return snapshot;
		};
		const capabilities = this.resolveCapabilities(
			caller,
			requestedProfile?.capabilities
				? canonicalCapabilities(requestedProfile.capabilities)
				: this.defaultCapabilities(caller),
		);
		const model = this.resolveModel(requestedProfile);
		const existing = this.options.store.listAgents(this.options.runId).find((agent) => agent.name === name);
		if (existing) {
			if (existing.parentId !== caller.id) {
				throw new RiemannHostError("conflict", `Agent name already exists in this run: ${name}`);
			}
			if (reuse !== "exact") {
				throw new RiemannHostError(
					"conflict",
					`Agent name already exists: ${name}; set reuse to exact only for a compatible settled identity`,
				);
			}
			const expectedFilesystem = childFilesystem(
				existing.workspace,
				workspaceMode,
				workspaceMode === "worktree" ? [existing.workspace] : [],
			);
			const compatible =
				existing.modelRole === (profileName ?? "inherit") &&
				existing.workspaceMode === workspaceMode &&
				(workspaceMode === "worktree" || existing.workspace === caller.workspace) &&
				JSON.stringify(existing.filesystem) === JSON.stringify(expectedFilesystem) &&
				JSON.stringify(existing.capabilities) === JSON.stringify(capabilities);
			if (!compatible) {
				throw new RiemannHostError(
					"conflict",
					`Agent ${name} is not exactly compatible with the requested profile and policy`,
				);
			}
			if (existing.activeTurnId !== null || existing.status === "queued" || existing.status === "running") {
				throw new RiemannHostError("conflict", `Agent ${name} already has an active Turn`);
			}
			const prompt = await this.initialAgentPrompt(requestedProfile, task);
			return this.queueExistingAgent(existing, task, prompt, "notify");
		}

		// Worktree children resolve their default write root against their own
		// workspace, so the pre-worktree check grants the caller workspace just
		// like the host-provisioned worktree root is granted after creation.
		const filesystem = childFilesystem(
			caller.workspace,
			workspaceMode,
			workspaceMode === "worktree" ? [caller.workspace] : [],
		);
		const prompt = await this.initialAgentPrompt(requestedProfile, task);
		const reserved = this.options.store.reserveAgentSlot(
			{
				runId: this.options.runId,
				parentId: caller.id,
				name,
				status: "queued",
				prompt,
				modelRole: profileName ?? "inherit",
				workspace: caller.workspace,
				workspaceMode,
				filesystem,
				depth: 1,
				capabilities,
			},
			this.options.config.maxAgents,
		);
		if (!reserved.ok) {
			if (reserved.reason === "name") {
				throw new RiemannHostError("conflict", `Agent name already exists in this run: ${name}`);
			}
			throw new RiemannHostError(
				"limit_exceeded",
				`All ${this.options.config.maxAgents} Agent slots are occupied; reuse or release an existing Agent`,
			);
		}
		const started = this.options.store.startAgentTurn({
			agentId: reserved.agent.id,
			task,
			prompt,
			deliveryMode: "notify",
		});
		let agent = started.agent;
		this.subagentUi.set(agent.id, { task, turnCount: 0, toolUses: 0, tokens: 0 });
		this.notifyTurn(agent.id, started.turn.id);
		if (workspaceMode === "worktree") {
			try {
				const worktree = await this.worktreeWorkspace(agent.id, caller.workspace);
				agent = this.options.store.updateAgent(agent.id, {
					workspace: worktree,
					filesystem: childFilesystem(worktree, "worktree", [worktree]),
				});
			} catch (error) {
				await this.settleAgent(
					agent,
					started.turn.id,
					"error",
					"",
					error instanceof Error ? error.message : String(error),
					[],
				);
				throw error;
			}
		}
		this.startLaunch(agent, started.turn, model, false, prompt);
		return { agent, turn: started.turn };
	}

	async start(callerId: string, args: Record<string, JsonValue>): Promise<JsonValue> {
		const started = await this.startAgent(callerId, args);
		const current = this.options.store.getAgent(started.agent.id);
		if (!current) throw new RiemannHostError("not_found", `Agent not found: ${started.agent.id}`);
		return turnHandleWire(current, started.turn.id);
	}

	private async waitForTurn(
		callerId: string,
		agentId: string,
		turnId: string,
		signal: AbortSignal,
		timeout: number | undefined,
	): Promise<{ agent: StoredAgent; turn: StoredAgentTurn }> {
		const owned = this.ownedTurn(callerId, agentId, turnId);
		if (owned.turn.status === "settled") {
			const turn = this.options.store.claimAgentTurnForWait(agentId, turnId);
			return { agent: this.ownedChild(callerId, agentId), turn };
		}
		this.waiters.set(turnId, (this.waiters.get(turnId) ?? 0) + 1);
		try {
			await new Promise<void>((resolve, reject) => {
				let timer: NodeJS.Timeout | undefined;
				const cleanup = () => {
					this.events.removeListener(`turn:${turnId}`, onTurn);
					signal.removeEventListener("abort", onAbort);
					if (timer) clearTimeout(timer);
				};
				const settle = (operation: () => void) => {
					cleanup();
					operation();
				};
				const onTurn = () => {
					if (this.options.store.getAgentTurn(turnId)?.status === "settled") settle(resolve);
				};
				const onAbort = () =>
					settle(() =>
						reject(
							new RiemannHostError("cancelled", "Agent wait was interrupted by the originating IPython cell"),
						),
					);
				this.events.on(`turn:${turnId}`, onTurn);
				signal.addEventListener("abort", onAbort, { once: true });
				if (timeout !== undefined) {
					timer = setTimeout(
						() =>
							settle(() =>
								reject(new RiemannHostError("timeout", `Timed out waiting for Agent Turn after ${timeout}s`)),
							),
						timeout * 1_000,
					);
					timer.unref?.();
				}
				if (signal.aborted) onAbort();
				else onTurn();
			});
			const turn = this.options.store.claimAgentTurnForWait(agentId, turnId);
			return { agent: this.ownedChild(callerId, agentId), turn };
		} finally {
			const remaining = (this.waiters.get(turnId) ?? 1) - 1;
			if (remaining > 0) this.waiters.set(turnId, remaining);
			else this.waiters.delete(turnId);
		}
	}

	async wait(callerId: string, args: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue> {
		const agentId = requiredString(args, "agent_id");
		const turnId = requiredString(args, "turn_id");
		const settled = await this.waitForTurn(callerId, agentId, turnId, signal, optionalTimeout(args));
		return this.agentResultWire(settled.agent, settled.turn);
	}

	async steerMessage(
		callerId: string,
		recipientSelector: string,
		expectedTurnId: string,
		body: string,
	): Promise<JsonValue> {
		const { agent, turn } = this.ownedTurn(callerId, recipientSelector, expectedTurnId);
		const live = this.live.get(agent.id);
		if (
			agent.activeTurnId !== turn.id ||
			agent.status !== "running" ||
			live?.turnId !== turn.id ||
			!live.session?.isStreaming
		) {
			throw new RiemannHostError(
				"conflict",
				`Agent Turn is not the exact active streaming Turn: ${agent.name}/${turn.id}`,
			);
		}
		const message = this.options.store.sendMessage({
			runId: this.options.runId,
			senderId: callerId,
			recipientId: agent.id,
			body,
		});
		try {
			await live.session.steer(`[Agent message ${message.id}]\n${message.body}`);
		} finally {
			// A failed exact-Turn steer must never be consumed as a later Turn task.
			this.options.store.markMessageDelivered(message.id);
		}
		this.notifyTurn(agent.id, turn.id);
		return turnHandleWire(agent, turn.id);
	}

	private requestStop(callerId: string, agentId: string, turnId: string): void {
		const { agent, turn } = this.ownedTurn(callerId, agentId, turnId);
		if (agent.lastTurnId !== turnId) {
			throw new RiemannHostError(
				"conflict",
				`Agent ${agent.name} advanced from Turn ${turnId} to ${agent.lastTurnId ?? "none"}`,
			);
		}
		if (turn.status === "settled") return;
		const cancelledAdmission = this.cancelAdmission(agent.id, turn.id);
		const live = this.live.get(agent.id);
		if (live?.turnId === turn.id) live.requestedStop = true;
		const stopped = this.options.store.updateAgent(agent.id, {
			status: "stopped",
			lastOutcome: "cancelled",
			error: null,
		});
		this.notifyTurn(agent.id, turn.id);
		if (live?.turnId === turn.id && live.session) void live.session.abort().catch(() => undefined);
		if (cancelledAdmission) this.startQueuedCancellation(stopped, turn.id);
	}

	async stopTurn(
		callerId: string,
		agentId: string,
		turnId: string,
		signal: AbortSignal,
		timeout?: number,
	): Promise<JsonValue> {
		const completion = this.waitForTurn(callerId, agentId, turnId, signal, timeout);
		this.requestStop(callerId, agentId, turnId);
		const settled = await completion;
		return this.agentResultWire(settled.agent, settled.turn);
	}

	async releaseAgent(callerId: string, selector: string, expectedTurnId: string): Promise<void> {
		const agent = this.ownedChild(callerId, selector);
		if (agent.lastTurnId !== expectedTurnId) {
			throw new RiemannHostError(
				"conflict",
				`Agent ${agent.name} advanced from Turn ${expectedTurnId} to ${agent.lastTurnId ?? "none"}`,
			);
		}
		if (
			agent.status === "queued" ||
			agent.status === "running" ||
			agent.activeTurnId !== null ||
			this.live.has(agent.id)
		) {
			throw new RiemannHostError("conflict", `Stop Agent ${agent.name} before releasing its slot`);
		}
		if (agent.workspaceMode === "worktree") await this.removeWorktree(agent);
		this.options.store.releaseAgent(agent.id);
		this.persistedMessages.delete(agent.id);
		this.subagentUi.delete(agent.id);
		this.notify(agent.id);
	}

	profileInventory(callerId: string): string {
		const caller = this.findAgent(callerId);
		if (caller.depth >= 1) return "";
		return this.availableProfileEntries(caller)
			.map(([name, profile]) => {
				const description = profile.description?.replace(/\s+/g, " ").trim();
				return description ? `- ${JSON.stringify(name)}: ${description}` : `- ${JSON.stringify(name)}`;
			})
			.join("\n");
	}

	definitions(callerId: string): FunctionDefinition[] {
		const caller = this.findAgent(callerId);
		if (caller.depth >= 1) return [];
		const profileNames = this.availableProfileEntries(caller).map(([name]) => name);
		const noCancellation = {
			supported: false,
			description: "The operation does not observe cancellation.",
		} as const;
		const waitCancellation = {
			supported: true,
			description: "Cancelling the originating cell interrupts only this wait; the Agent Turn continues.",
		} as const;
		const stopCancellation = {
			supported: true,
			description: "Cancelling the originating cell interrupts the settlement wait after stop is requested.",
		} as const;
		const agentStatusSchema = Type.Union([
			Type.Literal("queued"),
			Type.Literal("running"),
			Type.Literal("idle"),
			Type.Literal("stopped"),
		]);
		const outcomeSchema = Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("cancelled")]);
		const turnHandleSchema = Type.Object(
			{
				$riemann: Type.Literal("agent_turn_handle.v1"),
				id: Type.String(),
				name: Type.String(),
				turn_id: Type.String(),
				status: Type.Union([Type.Literal("queued"), Type.Literal("running")]),
			},
			{ additionalProperties: false },
		);
		const agentInfoSchema = Type.Object(
			{
				$riemann: Type.Literal("agent_info.v1"),
				id: Type.String(),
				name: Type.String(),
				turn_id: Type.String(),
				status: agentStatusSchema,
				parent_id: Type.Union([Type.String(), Type.Null()]),
				task: Type.String(),
				profile: Type.Union([Type.String(), Type.Null()]),
				model: Type.String(),
				workspace: Type.String(),
				active_turn_id: Type.Union([Type.String(), Type.Null()]),
				last_turn_id: Type.String(),
				last_outcome: Type.Union([outcomeSchema, Type.Null()]),
				output_preview: Type.Union([Type.String(), Type.Null()]),
				created_at: Type.String(),
				updated_at: Type.String(),
			},
			{ additionalProperties: false },
		);
		const agentResultSchema = Type.Object(
			{
				$riemann: Type.Literal("agent_result.v1"),
				id: Type.String(),
				name: Type.String(),
				turn_id: Type.String(),
				status: Type.Union([Type.Literal("idle"), Type.Literal("stopped")]),
				outcome: outcomeSchema,
				output: Type.String(),
				error: Type.Union([Type.String(), Type.Null()]),
				transcript_handle: Type.String(),
				patch_handle: Type.Union([Type.String(), Type.Null()]),
				started_at: Type.String(),
				completed_at: Type.String(),
			},
			{ additionalProperties: false },
		);
		const exactTurnInput = {
			agent_id: Type.String({ minLength: 1, description: "Owned child identity id" }),
			turn_id: Type.String({ minLength: 1, description: "Exact Agent Turn id" }),
		};
		const timeoutSchema = Type.Optional(
			Type.Union([
				Type.Number({ exclusiveMinimum: 0, maximum: 86_400, description: "Timeout in seconds" }),
				Type.Null(),
			]),
		);
		const startProperties = {
			task: Type.String({ minLength: 1, description: "Complete, self-contained task" }),
			name: Type.Optional(
				Type.Union([
					Type.String({
						minLength: 1,
						maxLength: 64,
						pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$",
						description: "Stable child identity name",
					}),
					Type.Null(),
				]),
			),
			...(profileNames.length > 0
				? {
						profile: Type.Optional(
							Type.Union([
								Type.String({
									enum: profileNames,
									description: `Exact configured policy key: ${profileNames
										.map((name) => JSON.stringify(name))
										.join(", ")}`,
								}),
								Type.Null(),
							]),
						),
					}
				: {}),
			reuse: Type.Optional(
				Type.Union([Type.Literal("never"), Type.Literal("exact")], {
					default: "never",
					description: "never rejects name collisions; exact reuses only a compatible settled named identity",
				}),
			),
		};
		return [
			{
				abiVersion: 2,
				name: "list",
				namespace: "agents",
				description: "List this Agent's reusable child identities, current activity, and latest outcomes.",
				inputSchema: Type.Object({}, { additionalProperties: false }),
				outputSchema: Type.Array(agentInfoSchema),
				pythonReturnType: "list[AgentInfo]",
				errors: [],
				effects: [{ kind: "read", resource: "agent-state" }],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "List reusable child Agents and their latest Turn state.",
					example: "await agents.list()",
				},
				capability: "agents.list",
				handler: async () =>
					this.options.store
						.listAgents(this.options.runId)
						.filter((agent) => agent.parentId === callerId)
						.map((agent) => this.agentInfoWire(agent)),
			},
			{
				abiVersion: 2,
				name: "start",
				namespace: "agents",
				description:
					"Start a child Agent Turn in the background, creating a new identity or exactly reusing a compatible settled named identity.",
				inputSchema: Type.Object(startProperties, { additionalProperties: false }),
				outputSchema: turnHandleSchema,
				pythonReturnType: "AgentTurnHandle",
				errors: [
					{
						code: "invalid_arguments",
						description: "The task, name, profile, or reuse mode is invalid.",
						retryable: false,
					},
					{ code: "not_found", description: "The requested profile or model is unavailable.", retryable: false },
					{ code: "not_configured", description: "No child model is configured.", retryable: false },
					{
						code: "conflict",
						description: "The name or exact reuse request conflicts with current Agent state.",
						retryable: true,
					},
					{
						code: "permission_denied",
						description: "The requested child policy exceeds the parent policy.",
						retryable: false,
					},
					{ code: "limit_exceeded", description: "No child identity slot is available.", retryable: true },
					{ code: "workspace_error", description: "An isolated worktree could not be prepared.", retryable: true },
				],
				effects: [
					{ kind: "write", resource: "agent-state" },
					{ kind: "execute", resource: "child-agent-turn" },
				],
				idempotency: "non-idempotent",
				cancellation: noCancellation,
				visibility: "public",
				prompt: {
					inventory: "Start a queued or running background child Agent Turn and return its exact handle.",
					example: 'handle = await agents.start(task="Inspect the parser", name="parser-review", reuse="never")',
					guidelines: [
						"Agents: use `await agents.start(...)` for background work and compose independent starts with `asyncio.gather`; await every expected handle result before synthesizing.",
						'Use `reuse="never"` for a new identity or `reuse="exact"` with a stable name for a compatible settled identity. `handle.wait()` returns the exact Turn result; `handle.steer()` only applies while that Turn is actively streaming.',
					],
				},
				capability: "agents.start",
				handler: (args) => this.start(callerId, args),
			},
			{
				abiVersion: 2,
				name: "info",
				namespace: "agents",
				description: "Refresh the child identity and latest Turn state.",
				inputSchema: Type.Object(
					{ agent_id: Type.String({ minLength: 1, description: "Owned child identity id" }) },
					{ additionalProperties: false },
				),
				outputSchema: agentInfoSchema,
				pythonReturnType: "AgentInfo",
				errors: [
					{ code: "not_found", description: "The child identity does not exist.", retryable: false },
					{
						code: "permission_denied",
						description: "The child is not directly owned by the caller.",
						retryable: false,
					},
				],
				effects: [{ kind: "read", resource: "agent-state" }],
				idempotency: "idempotent",
				cancellation: noCancellation,
				visibility: "handle-method",
				prompt: { inventory: "Refresh this child identity.", example: "await handle.info()" },
				capability: "agents.manage",
				handler: async (args) => this.agentInfoWire(this.ownedChild(callerId, requiredString(args, "agent_id"))),
			},
			{
				abiVersion: 2,
				name: "wait",
				namespace: "agents",
				description: "Wait for and claim one exact child Agent Turn result.",
				inputSchema: Type.Object({ ...exactTurnInput, timeout: timeoutSchema }, { additionalProperties: false }),
				outputSchema: agentResultSchema,
				pythonReturnType: "AgentResult",
				errors: [
					{ code: "not_found", description: "The child identity or exact Turn does not exist.", retryable: false },
					{
						code: "permission_denied",
						description: "The child is not directly owned by the caller.",
						retryable: false,
					},
					{ code: "timeout", description: "The Turn did not settle before the timeout.", retryable: true },
					{ code: "cancelled", description: "The originating cell was interrupted.", retryable: true },
				],
				effects: [
					{ kind: "read", resource: "agent-state" },
					{ kind: "write", resource: "agent-result-delivery" },
				],
				idempotency: "idempotent",
				cancellation: waitCancellation,
				visibility: "handle-method",
				prompt: { inventory: "Wait for this exact Agent Turn.", example: "await handle.wait(timeout=60)" },
				capability: "agents.manage",
				handler: (args, signal) => this.wait(callerId, args, signal),
			},
			{
				abiVersion: 2,
				name: "steer",
				namespace: "agents",
				description: "Steer only this exact active streaming Agent Turn; otherwise fail with conflict.",
				inputSchema: Type.Object(
					{
						...exactTurnInput,
						message: Type.String({ minLength: 1, description: "Steering instruction" }),
					},
					{ additionalProperties: false },
				),
				outputSchema: turnHandleSchema,
				pythonReturnType: "AgentTurnHandle",
				errors: [
					{ code: "not_found", description: "The child identity or exact Turn does not exist.", retryable: false },
					{
						code: "permission_denied",
						description: "The child is not directly owned by the caller.",
						retryable: false,
					},
					{ code: "conflict", description: "The exact Turn is not actively streaming.", retryable: true },
				],
				effects: [
					{ kind: "write", resource: "agent-inbox" },
					{ kind: "execute", resource: "active-agent-turn" },
				],
				idempotency: "non-idempotent",
				cancellation: noCancellation,
				visibility: "handle-method",
				prompt: {
					inventory: "Steer this exact active streaming Turn.",
					example: 'await handle.steer(message="Check the edge case")',
				},
				capability: "agents.manage",
				handler: (args) =>
					this.steerMessage(
						callerId,
						requiredString(args, "agent_id"),
						requiredString(args, "turn_id"),
						requiredString(args, "message"),
					),
			},
			{
				abiVersion: 2,
				name: "stop",
				namespace: "agents",
				description: "Stop and settle one exact Agent Turn while retaining its identity.",
				inputSchema: Type.Object({ ...exactTurnInput, timeout: timeoutSchema }, { additionalProperties: false }),
				outputSchema: agentResultSchema,
				pythonReturnType: "AgentResult",
				errors: [
					{ code: "not_found", description: "The child identity or exact Turn does not exist.", retryable: false },
					{
						code: "permission_denied",
						description: "The child is not directly owned by the caller.",
						retryable: false,
					},
					{ code: "conflict", description: "The identity has advanced to another Turn.", retryable: false },
					{ code: "timeout", description: "The stopped Turn did not settle before the timeout.", retryable: true },
					{ code: "cancelled", description: "The settlement wait was interrupted.", retryable: true },
				],
				effects: [
					{ kind: "write", resource: "agent-state" },
					{ kind: "execute", resource: "active-agent-turn" },
				],
				idempotency: "idempotent",
				cancellation: stopCancellation,
				visibility: "handle-method",
				prompt: { inventory: "Stop and settle this exact Turn.", example: "await handle.stop(timeout=30)" },
				capability: "agents.manage",
				handler: (args, signal) =>
					this.stopTurn(
						callerId,
						requiredString(args, "agent_id"),
						requiredString(args, "turn_id"),
						signal,
						optionalTimeout(args),
					),
			},
			{
				abiVersion: 2,
				name: "release",
				namespace: "agents",
				description: "Release a settled child identity and free its run slot.",
				inputSchema: Type.Object(exactTurnInput, { additionalProperties: false }),
				outputSchema: Type.Null(),
				pythonReturnType: "None",
				errors: [
					{ code: "not_found", description: "The child identity does not exist.", retryable: false },
					{
						code: "permission_denied",
						description: "The child is not directly owned by the caller.",
						retryable: false,
					},
					{
						code: "conflict",
						description: "The identity is active or has advanced to another Turn.",
						retryable: true,
					},
					{ code: "workspace_error", description: "The isolated worktree could not be removed.", retryable: true },
				],
				effects: [
					{ kind: "write", resource: "agent-state" },
					{ kind: "delete", resource: "agent-workspace" },
				],
				idempotency: "non-idempotent",
				cancellation: noCancellation,
				visibility: "handle-method",
				prompt: { inventory: "Release this settled child identity.", example: "await handle.release()" },
				capability: "agents.manage",
				handler: async (args) => {
					await this.releaseAgent(callerId, requiredString(args, "agent_id"), requiredString(args, "turn_id"));
					return null;
				},
			},
		];
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribeCompactionStrategySettingCommits();
		for (const admission of this.queue.splice(0)) {
			this.cancelled.add(admission.turnId);
			const stopped = this.options.store.updateAgent(admission.agentId, {
				status: "stopped",
				lastOutcome: "cancelled",
				error: "host process interrupted",
			});
			admission.resolve(false);
			this.startQueuedCancellation(stopped, admission.turnId);
		}
		const lives = [...this.live.values()];
		for (const live of lives) {
			live.requestedStop = true;
			this.options.store.updateAgent(live.agent.id, {
				status: "stopped",
				lastOutcome: "cancelled",
				error: "host process interrupted",
			});
			this.notifyTurn(live.agent.id, live.turnId);
		}
		await Promise.allSettled(lives.map((live) => live.session?.abort()));
		await Promise.allSettled([...this.launches]);
		await this.deliveryInFlight?.catch(() => undefined);
	}
}
