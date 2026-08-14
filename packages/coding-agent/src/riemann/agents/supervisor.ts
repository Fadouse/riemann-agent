import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEventListener, SessionStats } from "../../core/agent-session.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import type { CompactionPreparation, CompactionResult } from "../../core/compaction/index.ts";
import { execCommand } from "../../core/exec.ts";
import { defineTool, type ExtensionContext, type ToolDefinition } from "../../core/extensions/types.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { createAgentSession } from "../../core/sdk.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { AgentProfileConfig, RiemannConfig, SubagentWorkspace } from "../config.ts";
import { RiemannHostError } from "../errors.ts";
import type { FunctionDefinition } from "../functions/registry.ts";
import type { IPythonSchema, IPythonToolDetails } from "../ipython.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { ArtifactStore } from "../state/artifacts.ts";
import type { AgentStatus, RiemannStore, StoredAgent, StoredMessage } from "../state/store.ts";
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
	session?: ChildAgentSession;
	runtime?: ChildRiemannRuntime;
	modelKey: string;
	requestedStatus?: "parked" | "stopped";
	unsubscribeUi?: () => void;
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
	status: AgentStatus;
	task: string;
	modelRole: string;
	workspace: string;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	result?: string;
	error?: string;
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
	modelKey: string;
	resolve: (admitted: boolean) => void;
}
const DEFAULT_CHILD_CAPABILITIES = [
	"workspace.read",
	"workspace.write",
	"shell.run",
	"web.search",
	"web.fetch",
	"agents.*",
	"mcp.*",
];

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

function parseCapabilities(value: JsonValue | undefined): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
		throw new RiemannHostError("invalid_arguments", "capabilities must be a list of non-empty strings");
	}
	return canonicalCapabilities(value as string[]);
}

function agentWire(agent: StoredAgent): JsonValue {
	return {
		$riemann: "agent_info",
		id: agent.id,
		name: agent.name,
		status: agent.status,
		parent_id: agent.parentId,
		depth: agent.depth,
		model_role: agent.modelRole,
		workspace: agent.workspace,
		workspace_mode: agent.workspaceMode,
		permissions: agent.permissions,
	};
}

function messageWire(message: StoredMessage): JsonValue {
	return {
		$riemann: "agent_message",
		id: message.id,
		sender_id: message.senderId,
		recipient_id: message.recipientId,
		body: message.body,
		created_at: message.createdAt,
		reply_to: message.replyTo,
	};
}

function finalAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			typeof message !== "object" ||
			message === null ||
			!("role" in message) ||
			message.role !== "assistant" ||
			!("content" in message)
		)
			continue;
		if (!Array.isArray(message.content)) continue;
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
	return "";
}

export interface AgentSupervisorOptions {
	store: RiemannStore;
	artifacts: ArtifactStore;
	runId: string;
	rootAgent: StoredAgent;
	rootContext: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "thinkingLevel">;
	agentDir: string;
	config: RiemannConfig;
	createChildRuntime: ChildRuntimeFactory;
	createChildSession?: (
		agent: StoredAgent,
		model: Model<any>,
		runtime: ChildRiemannRuntime,
		resume: boolean,
	) => Promise<ChildAgentSession>;
}

export class AgentSupervisor {
	private readonly events = new EventEmitter();
	private readonly live = new Map<string, LiveChild>();
	private readonly queue: Admission[] = [];
	private running = 0;
	private readonly runningByModel = new Map<string, number>();
	private closed = false;
	private readonly cancelled = new Set<string>();
	private readonly options: AgentSupervisorOptions;
	private readonly subagentUi = new Map<string, SubagentRuntimeUi>();
	constructor(options: AgentSupervisorOptions) {
		this.options = options;
		this.events.setMaxListeners(100);
		this.options.store.markInterruptedAgents(options.runId);
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
					status: agent.status,
					task: runtime?.task ?? agent.prompt,
					modelRole: agent.modelRole,
					workspace: agent.workspace,
					createdAt: agent.createdAt,
					updatedAt: agent.updatedAt,
					...(runtime?.startedAt ? { startedAt: runtime.startedAt } : {}),
					...(agent.result ? { result: agent.result } : {}),
					...(agent.error ? { error: agent.error } : {}),
					turnCount: runtime?.turnCount ?? 0,
					toolUses: runtime?.toolUses ?? 0,
					tokens: runtime?.tokens ?? 0,
					...(runtime?.currentTool ? { currentTool: runtime.currentTool } : {}),
					messages: live?.session?.state.messages ?? [],
					...(live?.session?.state.streamingMessage
						? { streamingMessage: live.session.state.streamingMessage }
						: {}),
					live: live?.session !== undefined,
				};
			});
	}

	subscribeSubagentUi(listener: () => void): () => void {
		const guarded = () => {
			try {
				listener();
			} catch {}
		};
		this.events.on("subagents", guarded);
		return () => this.events.removeListener("subagents", guarded);
	}

	async steerSubagentFromUi(agentId: string, message: string): Promise<void> {
		await this.sendMessage(this.options.rootAgent.id, agentId, message);
	}

	async stopSubagentFromUi(agentId: string): Promise<void> {
		await this.stopAgent(agentId);
	}

	private notifySubagentUi(): void {
		this.events.emit("subagents");
	}

	private notify(agentId: string): void {
		this.events.emit(`agent:${agentId}`);
		this.notifySubagentUi();
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

	private resolveProfile(name: string | undefined): AgentProfileConfig | undefined {
		if (!name) return undefined;
		const profile = this.options.config.profiles[name];
		if (!profile) throw new RiemannHostError("not_found", `Agent profile not found: ${name}`);
		return profile;
	}
	private async agentPrompt(profile: AgentProfileConfig | undefined, task: string): Promise<string> {
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

	private resolveModel(profile: AgentProfileConfig | undefined, modelRole: string): Model<any> {
		const selector = profile?.model ?? this.options.config.modelRoles[profile?.modelRole ?? modelRole];
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

	private async acquire(agentId: string, modelKey: string): Promise<boolean> {
		const canRun = () =>
			this.running < this.options.config.limits.maxConcurrentPerRun &&
			(this.runningByModel.get(modelKey) ?? 0) < this.options.config.limits.maxConcurrentPerModel;
		if (canRun()) {
			this.running += 1;
			this.runningByModel.set(modelKey, (this.runningByModel.get(modelKey) ?? 0) + 1);
			return true;
		}
		return new Promise<boolean>((resolve) => {
			this.queue.push({ agentId, modelKey, resolve });
		});
	}
	private cancelAdmission(agentId: string): void {
		const queued = this.queue.findIndex((item) => item.agentId === agentId);
		if (queued < 0) return;
		const [admission] = this.queue.splice(queued, 1);
		this.cancelled.add(agentId);
		admission?.resolve(false);
	}

	private release(modelKey: string): void {
		this.running = Math.max(0, this.running - 1);
		const count = Math.max(0, (this.runningByModel.get(modelKey) ?? 1) - 1);
		if (count === 0) this.runningByModel.delete(modelKey);
		else this.runningByModel.set(modelKey, count);
		for (let index = 0; index < this.queue.length; index += 1) {
			const admission = this.queue[index];
			if (!admission) continue;
			if (
				this.running < this.options.config.limits.maxConcurrentPerRun &&
				(this.runningByModel.get(admission.modelKey) ?? 0) < this.options.config.limits.maxConcurrentPerModel
			) {
				this.queue.splice(index, 1);
				this.running += 1;
				this.runningByModel.set(admission.modelKey, (this.runningByModel.get(admission.modelKey) ?? 0) + 1);
				admission.resolve(true);
				index -= 1;
			}
		}
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
					factory: (pi) => {
						pi.on("session_before_compact", async (event, ctx) => ({
							compaction: await runtime.compact(event.preparation, event.customInstructions, event.signal, ctx),
						}));
					},
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
		});
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
		this.refreshSubagentStats(agentId, live);
		this.notifySubagentUi();
	}

	private async launch(agent: StoredAgent, model: Model<any>, resume: boolean): Promise<void> {
		const modelKey = `${model.provider}/${model.id}`;
		const admitted = await this.acquire(agent.id, modelKey);
		if (!admitted) {
			this.cancelled.delete(agent.id);
			return;
		}
		const current = this.options.store.getAgent(agent.id);
		if (this.closed || this.cancelled.delete(agent.id) || !current || current.status !== "queued") {
			this.release(modelKey);
			return;
		}
		const live: LiveChild = { agent: current, modelKey };
		this.live.set(agent.id, live);
		const runtimeUi = this.subagentUi.get(agent.id);
		if (runtimeUi) runtimeUi.startedAt = new Date().toISOString();
		this.options.store.updateAgent(agent.id, { status: "running", error: null });
		this.notify(agent.id);
		try {
			const runtime = await this.options.createChildRuntime(current);
			live.runtime = runtime;
			const session = this.options.createChildSession
				? await this.options.createChildSession(current, model, runtime, resume)
				: await this.createDefaultSession(current, model, runtime, resume);
			live.session = session;
			live.unsubscribeUi = session.subscribe?.((event) => this.observeSubagentEvent(agent.id, live, event));
			this.refreshSubagentStats(agent.id, live);
			this.notifySubagentUi();
			const prompt = resume
				? `Resume the assigned task after interruption. Inspect durable state and messages before repeating any side effect.\n\nOriginal task:\n${current.prompt}`
				: current.prompt;
			await session.prompt(prompt, { source: "rpc" });
			await runtime.snapshot();
			const result = finalAssistantText(session.state.messages);
			const profile = this.options.config.profiles[current.modelRole];
			const status: AgentStatus = live.requestedStatus ?? (profile?.parkOnComplete ? "parked" : "completed");
			this.options.store.updateAgent(agent.id, { status, result, error: null });
		} catch (error) {
			const status: AgentStatus = live.requestedStatus ?? "failed";
			this.options.store.updateAgent(agent.id, {
				status,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.refreshSubagentStats(agent.id, live);
			this.notify(agent.id);
			live.unsubscribeUi?.();
			live.unsubscribeUi = undefined;
			live.session?.dispose();
			await live.runtime?.close().catch(() => undefined);
			if (this.live.get(agent.id) === live) this.live.delete(agent.id);
			this.release(modelKey);
			this.notifySubagentUi();
		}
	}

	private resultWire(agent: StoredAgent): JsonValue {
		return {
			agent: agentWire(agent),
			result: agent.result,
			error: agent.error,
		};
	}

	private async waitForChange(
		agentId: string,
		timeoutSeconds: number | undefined,
		signal: AbortSignal,
	): Promise<void> {
		if (signal.aborted) throw signal.reason ?? new Error("Agent wait aborted");
		await new Promise<void>((resolve, reject) => {
			const event = `agent:${agentId}`;
			let timer: NodeJS.Timeout | undefined;
			let settled = false;
			const cleanup = () => {
				this.events.removeListener(event, changed);
				signal.removeEventListener("abort", aborted);
				clearTimeout(timer);
			};
			const changed = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			const aborted = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(signal.reason ?? new Error("Agent wait aborted"));
			};
			this.events.once(event, changed);
			signal.addEventListener("abort", aborted, { once: true });
			if (timeoutSeconds !== undefined) timer = setTimeout(changed, timeoutSeconds * 1_000);
			if (signal.aborted) aborted();
		});
	}

	async spawn(callerId: string, args: Record<string, JsonValue>): Promise<JsonValue> {
		const caller = this.findAgent(callerId);
		const task = requiredString(args, "task");
		const profileName = optionalString(args, "profile");
		const profile = this.resolveProfile(profileName);
		const requestedWorkspace = optionalString(args, "workspace") as SubagentWorkspace | undefined;
		if (requestedWorkspace && requestedWorkspace !== "shared" && requestedWorkspace !== "worktree") {
			throw new RiemannHostError("invalid_arguments", "workspace must be shared or worktree");
		}
		const explicitCapabilities = parseCapabilities(args.capabilities);
		const workspace = requestedWorkspace ?? profile?.workspace ?? this.options.config.agentDefaults.workspace;
		const permissions = profile?.permissions ?? this.options.config.agentDefaults.permissions;
		if (permissions === "host" && caller.permissions !== "host") {
			throw new RiemannHostError(
				"permission_denied",
				`Child host permissions exceed parent ${caller.name} workspace permissions`,
			);
		}
		let capabilities =
			explicitCapabilities ??
			(profile?.capabilities ? canonicalCapabilities(profile.capabilities) : this.defaultCapabilities(caller));
		capabilities = this.resolveCapabilities(caller, capabilities);
		const depth = caller.depth + 1;
		const maxDepth = Math.min(
			profile?.maxDepth ?? this.options.config.limits.maxDepth,
			this.options.config.limits.maxDepth,
		);
		if (depth > maxDepth)
			throw new RiemannHostError("limit_exceeded", `Agent depth ${depth} exceeds limit ${maxDepth}`);
		if (this.options.store.listAgents(this.options.runId).length - 1 >= this.options.config.limits.maxAgentsPerRun) {
			throw new RiemannHostError(
				"limit_exceeded",
				`Run agent limit ${this.options.config.limits.maxAgentsPerRun} reached`,
			);
		}
		const name = optionalString(args, "name") ?? `agent-${randomUUID().slice(0, 8)}`;
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name))
			throw new RiemannHostError(
				"invalid_arguments",
				"name must use 1-64 letters, digits, dots, dashes, or underscores",
			);
		if (this.options.store.listAgents(this.options.runId).some((candidate) => candidate.name === name)) {
			throw new RiemannHostError("conflict", `Agent name already exists in this run: ${name}`);
		}
		const requestedModelRole = profile?.modelRole ?? optionalString(args, "model_role") ?? profileName ?? "inherit";
		const model = this.resolveModel(profile, requestedModelRole);
		const modelRole = profileName ?? requestedModelRole;
		const placeholderWorkspace = caller.workspace;
		const prompt = await this.agentPrompt(profile, task);
		let agent = this.options.store.createAgent({
			runId: this.options.runId,
			parentId: caller.id,
			name,
			status: "queued",
			prompt,
			modelRole,
			workspace: placeholderWorkspace,
			workspaceMode: workspace,
			permissions,
			depth,
			capabilities,
		});
		this.subagentUi.set(agent.id, { task, turnCount: 0, toolUses: 0, tokens: 0 });
		this.notify(agent.id);
		if (workspace === "worktree") {
			try {
				const worktree = await this.worktreeWorkspace(agent.id, caller.workspace);
				agent = this.options.store.updateAgent(agent.id, { workspace: worktree });
			} catch (error) {
				this.options.store.updateAgent(agent.id, {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
				this.notify(agent.id);
				throw error;
			}
		}
		const launchAgent = agent;
		void this.launch(launchAgent, model, false);
		return { $riemann: "agent_handle", id: agent.id, name: agent.name };
	}
	async sendMessage(
		callerId: string,
		recipientSelector: string,
		body: string,
		replyTo?: string,
	): Promise<StoredMessage> {
		const recipient = this.findAgent(recipientSelector);
		const message = this.options.store.sendMessage({
			runId: this.options.runId,
			senderId: callerId,
			recipientId: recipient.id,
			body,
			replyTo,
		});
		const live = this.live.get(recipient.id);
		if (live?.session?.isStreaming) {
			const incoming = `[Agent message ${message.id} from ${this.findAgent(callerId).name}]\n${message.body}`;
			await live.session.steer(incoming);
		}
		this.notify(recipient.id);
		return message;
	}

	async parkAgent(selector: string): Promise<StoredAgent> {
		const agent = this.findAgent(selector);
		if (agent.parentId === null) throw new RiemannHostError("permission_denied", "The main agent cannot be parked");
		this.cancelAdmission(agent.id);
		const live = this.live.get(agent.id);
		if (live) {
			live.requestedStatus = "parked";
			await live.session?.abort();
			await live.runtime?.snapshot();
		}
		const parked = this.options.store.updateAgent(agent.id, { status: "parked" });
		this.notify(agent.id);
		return parked;
	}

	async reviveAgent(selector: string): Promise<StoredAgent> {
		const agent = this.findAgent(selector);
		if (this.live.has(agent.id) || this.queue.some((item) => item.agentId === agent.id)) {
			throw new RiemannHostError("conflict", `Agent is already live: ${agent.name}`);
		}
		const model = this.resolveModel(this.options.config.profiles[agent.modelRole], agent.modelRole);
		if (!this.subagentUi.has(agent.id)) {
			this.subagentUi.set(agent.id, {
				task: agent.prompt,
				turnCount: 0,
				toolUses: 0,
				tokens: 0,
			});
		}
		const queued = this.options.store.updateAgent(agent.id, { status: "queued", result: null, error: null });
		this.notify(agent.id);
		void this.launch(queued, model, true);
		return queued;
	}

	async stopAgent(selector: string): Promise<StoredAgent> {
		const agent = this.findAgent(selector);
		if (agent.parentId === null) throw new RiemannHostError("permission_denied", "The main agent cannot be stopped");
		this.cancelAdmission(agent.id);
		const live = this.live.get(agent.id);
		if (live) {
			live.requestedStatus = "stopped";
			await live.session?.abort();
		}
		const stopped = this.options.store.updateAgent(agent.id, { status: "stopped" });
		this.notify(agent.id);
		return stopped;
	}

	profileInventory(callerId: string): string {
		const caller = this.findAgent(callerId);
		return Object.entries(this.options.config.profiles)
			.filter(([, profile]) => {
				const capabilities = profile.capabilities
					? canonicalCapabilities(profile.capabilities)
					: this.defaultCapabilities(caller);
				return capabilities.every((capability) => this.canGrantCapability(caller, capability));
			})
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, profile]) => {
				const description = profile.description?.replace(/\s+/g, " ").trim();
				const summary = description ? `- ${JSON.stringify(name)}: ${description}` : `- ${JSON.stringify(name)}`;
				const workspace = profile.workspace ?? this.options.config.agentDefaults.workspace;
				const permissions = profile.permissions ?? this.options.config.agentDefaults.permissions;
				return `${summary}
  workspace: ${workspace}; permissions: ${permissions}`;
			})
			.join("\n");
	}

	definitions(callerId: string): FunctionDefinition[] {
		return [
			{
				name: "self",
				namespace: "agents",
				description: "Return this agent's durable identity and status.",
				promptSnippet: "Return this agent's durable identity and status.",
				parameters: [],
				returns: "AgentInfo",
				capability: "agents.list",
				handler: async () => agentWire(this.findAgent(callerId)),
			},
			{
				name: "list",
				namespace: "agents",
				description: "List all agents in the current run mesh with durable statuses.",
				promptSnippet: "List agents and durable statuses.",
				parameters: [],
				returns: "list[AgentInfo]",
				capability: "agents.list",
				handler: async () => this.options.store.listAgents(this.options.runId).map(agentWire),
			},
			{
				name: "spawn",
				namespace: "agents",
				description:
					"Admit an asynchronous child agent. Task and name are sufficient; without a profile, the child uses the configured default shared/worktree topology and parent-bounded standard capabilities.",
				promptSnippet: "Spawn an async child; task and name suffice with safe shared defaults.",
				parameters: [
					{ name: "task", description: "Complete, self-contained task", type: "str", required: true },
					{ name: "name", description: "Stable unique name", type: "str | None", required: false },
					{ name: "profile", description: "Configured agent profile", type: "str | None", required: false },
					{
						name: "workspace",
						description: "Optional topology override: shared or worktree; defaults to agents.defaults.workspace",
						type: "str | None",
						required: false,
					},
					{
						name: "capabilities",
						description: "Optional child allowlist; bare namespaces such as web expand to web.*",
						type: "list[str] | None",
						required: false,
					},
					{ name: "model_role", description: "Configured model role", type: "str | None", required: false },
				],
				returns: "AgentHandle",
				capability: "agents.spawn",
				promptGuidelines: [
					"Delegate only clearly bounded work with useful parallelism or specialization; the parent owns integration and verification.",
				],
				handler: (args) => this.spawn(callerId, args),
			},
			{
				name: "send",
				namespace: "agents",
				description:
					"Send a durable direct message to an agent by id or name. Running recipients receive it as steering.",
				promptSnippet: "Send durable steering or a direct message.",
				parameters: [
					{ name: "agent_id", description: "Recipient id or name", type: "str", required: true },
					{ name: "message", description: "Message body", type: "str", required: true },
					{
						name: "reply_to",
						description: "Optional message id being answered",
						type: "str | None",
						required: false,
					},
				],
				returns: "AgentMessage",
				capability: "agents.send",
				handler: async (args) =>
					messageWire(
						await this.sendMessage(
							callerId,
							requiredString(args, "agent_id"),
							requiredString(args, "message"),
							optionalString(args, "reply_to"),
						),
					),
			},
			{
				name: "inbox",
				namespace: "agents",
				description:
					"Read durable messages addressed to this agent. By default returns and marks only unread messages.",
				promptSnippet: "Read durable messages; unread messages are marked delivered.",
				parameters: [
					{
						name: "unread_only",
						description: "Return only unread messages",
						type: "bool | None",
						required: false,
					},
				],
				returns: "list[AgentMessage]",
				capability: "agents.inbox",
				handler: async (args) => {
					const unreadOnly = args.unread_only === undefined || args.unread_only === null ? true : args.unread_only;
					if (typeof unreadOnly !== "boolean")
						throw new RiemannHostError("invalid_arguments", "unread_only must be a boolean");
					return this.options.store
						.listInbox(callerId, { unreadOnly, markDelivered: unreadOnly })
						.map(messageWire);
				},
			},
			{
				name: "wait",
				namespace: "agents",
				description:
					"Wait without polling for an agent to finish or for an optional timeout, then return its durable result envelope.",
				promptSnippet: "Wait without polling for child completion or timeout.",
				parameters: [
					{ name: "agent_id", description: "Agent id or name", type: "str", required: true },
					{ name: "timeout", description: "Optional timeout in seconds", type: "float | None", required: false },
				],
				returns: "dict",
				capability: "agents.wait",
				handler: async (args, signal) => {
					if (signal.aborted) throw signal.reason ?? new Error("Agent wait aborted");
					let agent = this.findAgent(requiredString(args, "agent_id"));
					const timeout = args.timeout === undefined || args.timeout === null ? undefined : args.timeout;
					if (timeout !== undefined && (typeof timeout !== "number" || timeout < 0 || timeout > 86_400)) {
						throw new RiemannHostError("invalid_arguments", "timeout must be from 0 to 86400 seconds");
					}
					const deadline = timeout === undefined ? undefined : Date.now() + timeout * 1_000;
					while (!["completed", "failed", "stopped", "parked"].includes(agent.status)) {
						const remaining = deadline === undefined ? undefined : Math.max(0, (deadline - Date.now()) / 1_000);
						if (remaining === 0) break;
						await this.waitForChange(agent.id, remaining, signal);
						agent = this.findAgent(agent.id);
					}
					return this.resultWire(agent);
				},
			},
			{
				name: "result",
				namespace: "agents",
				description: "Return the current durable status, final response, and error for an agent.",
				promptSnippet: "Read a child's durable status, result, and error.",
				parameters: [{ name: "agent_id", description: "Agent id or name", type: "str", required: true }],
				returns: "dict",
				capability: "agents.result",
				handler: async (args) => this.resultWire(this.findAgent(requiredString(args, "agent_id"))),
			},
			{
				name: "park",
				namespace: "agents",
				description: "Checkpoint and stop a live child while retaining its session and workspace for revival.",
				promptSnippet: "Checkpoint and stop a live child for later revival.",
				parameters: [{ name: "agent_id", description: "Agent id or name", type: "str", required: true }],
				returns: "AgentInfo",
				capability: "agents.manage",
				handler: async (args) => agentWire(await this.parkAgent(requiredString(args, "agent_id"))),
			},
			{
				name: "revive",
				namespace: "agents",
				description: "Resume a parked, completed, failed, or stopped child from its durable session.",
				promptSnippet: "Resume a retained child session.",
				parameters: [{ name: "agent_id", description: "Agent id or name", type: "str", required: true }],
				returns: "AgentHandle",
				capability: "agents.manage",
				handler: async (args) => {
					const agent = await this.reviveAgent(requiredString(args, "agent_id"));
					return { $riemann: "agent_handle", id: agent.id, name: agent.name };
				},
			},
			{
				name: "stop",
				namespace: "agents",
				description: "Stop a child agent. Durable history and workspace are retained.",
				promptSnippet: "Stop a child while retaining history and workspace.",
				parameters: [{ name: "agent_id", description: "Agent id or name", type: "str", required: true }],
				returns: "AgentInfo",
				capability: "agents.manage",
				handler: async (args) => agentWire(await this.stopAgent(requiredString(args, "agent_id"))),
			},
		];
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const admission of this.queue.splice(0)) {
			this.cancelled.add(admission.agentId);
			this.options.store.updateAgent(admission.agentId, { status: "parked" });
			admission.resolve(false);
		}
		const lives = [...this.live.values()];
		for (const live of lives) {
			live.requestedStatus = "parked";
			live.session?.dispose();
		}
		await Promise.allSettled(
			lives.map(async (live) => {
				live.unsubscribeUi?.();
				live.unsubscribeUi = undefined;
				await live.runtime?.close();
				if (this.live.get(live.agent.id) === live) this.live.delete(live.agent.id);
				const current = this.options.store.getAgent(live.agent.id);
				if (current && !["completed", "failed", "stopped"].includes(current.status)) {
					this.options.store.updateAgent(live.agent.id, { status: "parked" });
				}
			}),
		);
	}
}
