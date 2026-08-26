import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentSessionEventListener } from "../src/core/agent-session.ts";
import { execCommand } from "../src/core/exec.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { FULL_FILESYSTEM } from "../src/riemann/access-policy.ts";
import {
	type AgentEventDelivery,
	AgentSupervisor,
	type ChildAgentSession,
	type ChildRiemannRuntime,
} from "../src/riemann/agents/supervisor.ts";
import { type RiemannConfig, updateGlobalRiemannSetting } from "../src/riemann/config.ts";
import type { FunctionDefinition } from "../src/riemann/functions/registry.ts";
import { IPythonSchema } from "../src/riemann/ipython.ts";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { DatabaseSync } from "../src/riemann/state/database.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function objectValue(value: JsonValue): Record<string, JsonValue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object result");
	return value;
}

function functionByName(definitions: FunctionDefinition[], name: string): FunctionDefinition {
	const definition = definitions.find((candidate) => candidate.name === name);
	if (!definition) throw new Error(`Missing function: ${name}`);
	return definition;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Agent state");
		await delay(5);
	}
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execCommand("git", ["-C", cwd, ...args], cwd, { timeout: 30_000 });
	if (result.code !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

class FakeChildSession implements ChildAgentSession {
	readonly state: { messages: unknown[] } = { messages: [] };
	readonly model: Model<any> | undefined;
	readonly sessionManager: Pick<SessionManager, "getBranch">;
	isStreaming = true;
	steerFailure: Error | undefined;
	readonly steering: string[] = [];
	readonly prompts: string[] = [];
	private aborted = false;
	private resolveCompletion!: () => void;
	private readonly completion = new Promise<void>((resolve) => {
		this.resolveCompletion = resolve;
	});

	constructor(model: Model<any> | undefined = getModel("openai", "gpt-4o-mini")) {
		this.model = model;
		this.sessionManager = { getBranch: () => [] };
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.state.messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		await this.completion;
		this.isStreaming = false;
		if (!this.aborted) this.state.messages.push(fauxAssistantMessage(`child completed: ${text}`));
	}

	async steer(text: string): Promise<void> {
		if (this.steerFailure) throw this.steerFailure;
		this.steering.push(text);
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.resolveCompletion();
	}

	dispose(): void {}

	getSessionStats() {
		return {
			sessionFile: undefined,
			sessionId: "fake-child",
			userMessages: 1,
			assistantMessages: 2,
			toolCalls: 3,
			toolResults: 3,
			totalMessages: 6,
			tokens: { input: 800, output: 434, cacheRead: 0, cacheWrite: 0, total: 1_234 },
			cost: 0,
		};
	}

	finish(): void {
		this.resolveCompletion();
	}
}

class ObservableChildSession extends FakeChildSession {
	statsReads = 0;
	tokenTotal = 1_234;
	private listener: AgentSessionEventListener | undefined;

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listener = listener;
		return () => {
			if (this.listener === listener) this.listener = undefined;
		};
	}

	override getSessionStats() {
		this.statsReads += 1;
		const stats = super.getSessionStats();
		return { ...stats, tokens: { ...stats.tokens, total: this.tokenTotal } };
	}

	emitMessageDelta(): void {
		const message = fauxAssistantMessage("partial child response");
		this.listener?.({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: message },
		});
	}

	get subscribed(): boolean {
		return this.listener !== undefined;
	}
}

function fakeRuntime(close: () => Promise<void> = async () => undefined): ChildRiemannRuntime {
	return {
		tool: {
			name: "ipython",
			label: "IPython",
			description: "test kernel",
			parameters: IPythonSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: { status: "ok", durationMs: 0 } };
			},
		},
		systemPrompt: "child system prompt",
		async compact(preparation) {
			return {
				summary: "compacted",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
			};
		},
		async snapshot() {},
		close,
	};
}

const config: RiemannConfig = {
	maxAgents: 4,
	maxConcurrentAgents: 4,
	limits: {
		maxCellOutputChars: 100_000,
		maxArtifactPreviewChars: 12_000,
	},
	retention: {
		maxAgeDays: 30,
		maxArtifactBytes: 1_000_000,
		maxSnapshotBytes: 1_000_000,
		maxWorktreeBytes: 1_000_000,
	},
	compaction: { strategy: "snapshot" },
	mainAgent: { network: "inherit" },
	agentDefaults: { workspace: "shared", network: "inherit" },
	profiles: {
		privileged: { filesystem: { read: ["/"], write: ["/"] } },
		isolated: { workspace: "worktree" },
	},
	mcpServers: {},
	web: { searchBackend: "disabled" },
	files: [],
	projectOverrides: new Set(),
};

interface SupervisorHarness {
	root: string;
	agentDir: string;
	store: RiemannStore;
	runId: string;
	mainId: string;
	supervisor: AgentSupervisor;
	sessions: Map<string, FakeChildSession[]>;
	resumeFlags: Map<string, boolean[]>;
	deliveries: AgentEventDelivery[];
	modelIds: string[];
}

interface SupervisorHarnessOptions {
	defaultSession?: boolean;
	rootModel?: Model<any>;
	modelRegistry?: ModelRegistry;
	createSession?: (model: Model<any>) => FakeChildSession;
	warningSink?: (message: string) => void | Promise<void>;
	rootNetwork?: "allow" | "deny";
}

async function createHarness(
	overrides: Partial<
		Pick<
			RiemannConfig,
			"maxAgents" | "maxConcurrentAgents" | "agentDefaults" | "profiles" | "compaction" | "projectOverrides"
		>
	> = {},
	deliver?: (delivery: AgentEventDelivery) => Promise<void>,
	configuredChildModel?: Model<any>,
	options: SupervisorHarnessOptions = {},
): Promise<SupervisorHarness> {
	const root = await mkdtemp(join(tmpdir(), "riemann-agent-"));
	roots.push(root);
	const agentDir = join(root, ".agent");
	const store = new RiemannStore(agentDir);
	const run = store.openRun(`run-${roots.length}`, root);
	const main = store.ensureRootAgent(run.id, root, FULL_FILESYSTEM, options.rootNetwork ?? "deny");
	const model = options.rootModel ?? getModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Built-in test model is unavailable");
	const sessions = new Map<string, FakeChildSession[]>();
	const resumeFlags = new Map<string, boolean[]>();
	const deliveries: AgentEventDelivery[] = [];
	const modelIds: string[] = [];
	const supervisor = new AgentSupervisor({
		store,
		artifacts: new ArtifactStore(store, run.id),
		runId: run.id,
		rootAgent: main,
		rootContext: {
			cwd: root,
			model,
			modelRegistry:
				options.modelRegistry ??
				({
					find: (provider: string, id: string) =>
						configuredChildModel?.provider === provider && configuredChildModel.id === id
							? configuredChildModel
							: undefined,
				} as unknown as ModelRegistry),
			thinkingLevel: "off",
		},
		agentDir,
		config: { ...config, ...overrides },
		createChildRuntime: async () => fakeRuntime(),
		...(options.defaultSession
			? {}
			: {
					createChildSession: async (agent, childModel, _runtime, resume) => {
						const session = options.createSession?.(childModel) ?? new FakeChildSession(childModel);
						sessions.set(agent.id, [...(sessions.get(agent.id) ?? []), session]);
						resumeFlags.set(agent.id, [...(resumeFlags.get(agent.id) ?? []), resume]);
						modelIds.push(`${childModel.provider}/${childModel.id}`);
						return session;
					},
				}),
		deliverAgentEvents: async (delivery) => {
			deliveries.push(delivery);
			await deliver?.(delivery);
		},
		warningSink: options.warningSink,
	});
	return {
		root,
		agentDir,
		store,
		runId: run.id,
		mainId: main.id,
		supervisor,
		sessions,
		resumeFlags,
		deliveries,
		modelIds,
	};
}

describe("Riemann reusable Agent slots", () => {
	test("exposes the actor API, delivers completion, and reuses one durable identity", async () => {
		const harness = await createHarness({ maxAgents: 2, maxConcurrentAgents: 1 });
		const { supervisor, store, mainId, sessions, resumeFlags, deliveries } = harness;
		try {
			const definitions = supervisor.definitions(mainId);
			expect(definitions.map((definition) => definition.name)).toEqual([
				"list",
				"start",
				"info",
				"wait",
				"steer",
				"stop",
				"release",
			]);
			expect(
				definitions.filter((definition) => definition.visibility === "public").map((definition) => definition.name),
			).toEqual(["list", "start"]);
			expect(
				definitions
					.filter((definition) => definition.visibility === "handle-method")
					.map((definition) => definition.name),
			).toEqual(["info", "wait", "steer", "stop", "release"]);
			const startDefinition = functionByName(definitions, "start");
			expect(startDefinition.abiVersion).toBe(2);
			expect(Object.keys(startDefinition.inputSchema.properties)).toEqual(["task", "name", "profile", "reuse"]);
			expect(startDefinition.inputSchema).toMatchObject({ additionalProperties: false });
			expect(startDefinition.pythonReturnType).toBe("AgentTurnHandle");
			expect(startDefinition.outputSchema).toMatchObject({
				type: "object",
				additionalProperties: false,
				properties: { $riemann: { const: "agent_turn_handle.v1" }, status: { anyOf: expect.any(Array) } },
			});
			expect(startDefinition.inputSchema.properties.profile).toMatchObject({
				anyOf: [{ description: 'Exact configured policy key: "isolated", "privileged"' }, { type: "null" }],
			});
			await expect(
				supervisor.start(mainId, { task: "invalid profile", name: "invalid-profile", profile: "explore" }),
			).rejects.toMatchObject({
				code: "not_found",
				message:
					'Agent profile not found: "explore". Available profiles: "isolated", "privileged". Omit profile to use child defaults.',
			});
			expect(store.listAgents(harness.runId).filter((agent) => agent.parentId !== null)).toHaveLength(0);

			const firstHandle = objectValue(
				await supervisor.start(mainId, { task: "Produce a bounded result", name: "reviewer" }),
			);
			const childId = firstHandle.id;
			if (typeof childId !== "string") throw new Error("Start did not return an Agent id");
			const firstTurnId = firstHandle.turn_id;
			if (typeof firstTurnId !== "string") throw new Error("Start did not return a Turn id");
			expect(firstHandle).toMatchObject({
				$riemann: "agent_turn_handle.v1",
				status: "running",
			});
			expect(supervisor.definitions(childId)).toEqual([]);
			await waitFor(() => supervisor.listSubagentsForUi().find((agent) => agent.id === childId)?.live === true);
			expect(store.getAgent(childId)).toMatchObject({
				workspace: harness.root,
				filesystem: FULL_FILESYSTEM,
				capabilities: ["fs.read", "fs.write", "shell.run", "web.search", "web.fetch", "mcp.*"],
			});
			expect(supervisor.listSubagentsForUi()).toContainEqual(
				expect.objectContaining({
					id: childId,
					status: "running",
					task: "Produce a bounded result",
					turnCount: 2,
					toolUses: 3,
					tokens: 1_234,
					live: true,
				}),
			);

			sessions.get(childId)?.at(-1)?.finish();
			await waitFor(() => store.getAgent(childId)?.status === "idle");
			await supervisor.flushAgentEvents();
			const settled = store.getAgent(childId);
			expect(settled).toMatchObject({
				id: childId,
				status: "idle",
				lastOutcome: "ok",
				result: "child completed: Produce a bounded result",
			});
			expect(settled?.transcriptHandle).toMatch(/^artifact:\/\//);
			expect(deliveries.at(-1)?.events).toEqual([
				{
					id: expect.any(String),
					agentId: childId,
					name: "reviewer",
					turnId: firstTurnId,
					outcome: "ok",
				},
			]);
			expect(JSON.stringify(deliveries.at(-1))).not.toContain("child completed: Produce a bounded result");
			expect(JSON.stringify(deliveries.at(-1))).not.toContain(settled?.transcriptHandle);
			expect(store.listPendingAgentEvents(mainId)).toHaveLength(0);
			await waitFor(() => supervisor.listSubagentsForUi().find((agent) => agent.id === childId)?.live === false);
			expect(supervisor.listSubagentsForUi().find((agent) => agent.id === childId)?.messages).not.toHaveLength(0);
			await expect(
				supervisor.start(mainId, { task: "accidental collision", name: "reviewer", reuse: "never" }),
			).rejects.toMatchObject({ code: "conflict" });
			await expect(
				supervisor.start(mainId, {
					task: "incompatible reuse",
					name: "reviewer",
					profile: "privileged",
					reuse: "exact",
				}),
			).rejects.toMatchObject({ code: "conflict" });

			const reusedHandle = objectValue(
				await supervisor.start(mainId, { task: "Review the regression test", name: "reviewer", reuse: "exact" }),
			);
			expect(reusedHandle.id).toBe(childId);
			expect(reusedHandle.turn_id).not.toBe(firstTurnId);
			await waitFor(() => store.getAgent(childId)?.status === "running");
			expect(resumeFlags.get(childId)).toEqual([false, true]);
			expect(sessions.get(childId)?.at(-1)?.prompts).toEqual(["Review the regression test"]);
			sessions.get(childId)?.at(-1)?.finish();
			await waitFor(() => store.getAgent(childId)?.status === "idle");

			await supervisor.start(mainId, { task: "Inspect the final diff", name: "reviewer", reuse: "exact" });
			await waitFor(() => store.getAgent(childId)?.status === "running");
			expect(store.listAgents(harness.runId).filter((agent) => agent.parentId !== null)).toHaveLength(1);
			expect(resumeFlags.get(childId)).toEqual([false, true, true]);
			expect(sessions.get(childId)?.at(-1)?.prompts[0]).toContain("Inspect the final diff");
			await supervisor.stopSubagentFromUi(childId);
			expect(store.getAgent(childId)).toMatchObject({ status: "stopped", lastOutcome: "cancelled" });

			await expect(
				supervisor.start(childId, { task: "Attempt recursive delegation", name: "nested" }),
			).rejects.toMatchObject({ code: "limit_exceeded" });
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("coalesces session stat scans during message deltas and flushes final stats", async () => {
		const session = new ObservableChildSession();
		const harness = await createHarness({}, undefined, undefined, { createSession: () => session });
		const { supervisor, store, mainId } = harness;
		try {
			const handle = objectValue(await supervisor.start(mainId, { task: "stream a response", name: "worker" }));
			if (typeof handle.id !== "string") throw new Error("Missing Agent id");
			await waitFor(() => supervisor.listSubagentsForUi().find((agent) => agent.id === handle.id)?.live === true);
			expect(session.statsReads).toBe(1);

			for (let index = 0; index < 50; index += 1) session.emitMessageDelta();
			expect(session.statsReads).toBe(1);
			await waitFor(() => session.statsReads === 2);

			session.tokenTotal = 9_876;
			session.emitMessageDelta();
			session.finish();
			await waitFor(() => store.getAgent(handle.id as string)?.status === "idle");
			expect(supervisor.listSubagentsForUi().find((agent) => agent.id === handle.id)?.tokens).toBe(9_876);
			expect(session.statsReads).toBe(3);
			expect(session.subscribed).toBe(false);
			await delay(40);
			expect(session.statsReads).toBe(3);
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("removes profile from the Agent API when no policy profiles are available", async () => {
		const harness = await createHarness({ profiles: {} });
		const { supervisor, store, mainId, sessions } = harness;
		try {
			const definitions = supervisor.definitions(mainId);
			expect(Object.keys(functionByName(definitions, "start").inputSchema.properties)).toEqual([
				"task",
				"name",
				"reuse",
			]);
			expect(supervisor.profileInventory(mainId)).toBe("");

			await expect(
				supervisor.start(mainId, { task: "invalid profile", name: "invalid-profile", profile: "explore" }),
			).rejects.toMatchObject({
				code: "not_found",
				message:
					'Agent profile not found: "explore". No Agent profiles are configured; omit profile to use child defaults.',
			});
			expect(store.listAgents(harness.runId).filter((agent) => agent.parentId !== null)).toHaveLength(0);

			const handle = objectValue(
				await supervisor.start(mainId, { task: "Inspect the repository", name: "project-inspector" }),
			);
			if (typeof handle.id !== "string") throw new Error("Start did not return an Agent id");
			const childId = handle.id;
			await waitFor(() => store.getAgent(childId)?.status === "running");
			sessions.get(childId)?.at(-1)?.finish();
			await waitFor(() => store.getAgent(childId)?.status === "idle");
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("waits for one exact Turn and claims its completion without an automatic wake", async () => {
		const harness = await createHarness();
		const { supervisor, store, mainId, sessions, deliveries } = harness;
		const definitions = supervisor.definitions(mainId);
		const waitDefinition = functionByName(definitions, "wait");
		const steerDefinition = functionByName(definitions, "steer");
		const stopDefinition = functionByName(definitions, "stop");
		try {
			const first = objectValue(await supervisor.start(mainId, { task: "first turn", name: "worker" }));
			if (typeof first.id !== "string" || typeof first.turn_id !== "string") throw new Error("Missing first handle");
			await waitFor(() => store.getAgent(first.id as string)?.status === "running");
			await expect(
				supervisor.start(mainId, { task: "cannot start over active", name: "worker", reuse: "exact" }),
			).rejects.toMatchObject({ code: "conflict" });
			expect(
				objectValue(
					await steerDefinition.handler(
						{ agent_id: first.id, turn_id: first.turn_id, message: "inspect the edge case" },
						new AbortController().signal,
					),
				),
			).toMatchObject({
				$riemann: "agent_turn_handle.v1",
				turn_id: first.turn_id,
				status: "running",
			});
			expect(sessions.get(first.id)?.at(-1)?.steering).toHaveLength(1);
			const firstWait = waitDefinition.handler(
				{ agent_id: first.id, turn_id: first.turn_id },
				new AbortController().signal,
			);
			sessions.get(first.id)?.at(-1)?.finish();
			const firstResult = objectValue(await firstWait);
			expect(firstResult).toMatchObject({
				$riemann: "agent_result.v1",
				id: first.id,
				turn_id: first.turn_id,
				status: "idle",
				outcome: "ok",
				output: "child completed: first turn",
			});
			expect(store.listPendingAgentEvents(mainId)).toHaveLength(0);
			expect(deliveries).toHaveLength(0);
			await expect(
				steerDefinition.handler(
					{ agent_id: first.id, turn_id: first.turn_id, message: "settled steering" },
					new AbortController().signal,
				),
			).rejects.toMatchObject({ code: "conflict" });

			const second = objectValue(
				await supervisor.start(mainId, { task: "second turn", name: "worker", reuse: "exact" }),
			);
			if (typeof second.turn_id !== "string") throw new Error("Missing second Turn id");
			expect(second.turn_id).not.toBe(first.turn_id);
			expect(
				objectValue(
					await waitDefinition.handler(
						{ agent_id: first.id, turn_id: first.turn_id },
						new AbortController().signal,
					),
				).turn_id,
			).toBe(first.turn_id);
			await expect(
				steerDefinition.handler(
					{ agent_id: first.id, turn_id: first.turn_id, message: "stale steering" },
					new AbortController().signal,
				),
			).rejects.toMatchObject({ code: "conflict" });
			await expect(
				waitDefinition.handler(
					{ agent_id: second.id, turn_id: second.turn_id, timeout: 0.01 },
					new AbortController().signal,
				),
			).rejects.toMatchObject({ code: "timeout" });
			expect(store.getAgent(second.id as string)?.status).toBe("running");

			const stopped = objectValue(
				await stopDefinition.handler(
					{ agent_id: second.id, turn_id: second.turn_id, timeout: 1 },
					new AbortController().signal,
				),
			);
			expect(stopped).toMatchObject({
				$riemann: "agent_result.v1",
				turn_id: second.turn_id,
				status: "stopped",
				outcome: "cancelled",
			});
			expect(store.listPendingAgentEvents(mainId)).toHaveLength(0);
			expect(deliveries).toHaveLength(0);
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("delivers unclaimed completion immediately without waiting for the parent to become idle", async () => {
		const harness = await createHarness();
		const { supervisor, store, mainId, sessions, deliveries } = harness;
		try {
			const handle = objectValue(await supervisor.start(mainId, { task: "background turn", name: "worker" }));
			if (typeof handle.id !== "string") throw new Error("Missing Agent id");
			await waitFor(() => store.getAgent(handle.id as string)?.status === "running");
			sessions.get(handle.id)?.at(-1)?.finish();
			await waitFor(() => deliveries.length === 1);
			expect(store.getAgent(handle.id as string)?.status).toBe("idle");
			expect(store.listPendingAgentEvents(mainId)).toHaveLength(0);
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("starts independently and interrupting a wait does not stop the Turn", async () => {
		const harness = await createHarness();
		const { supervisor, store, mainId, sessions, deliveries } = harness;
		const definitions = supervisor.definitions(mainId);
		const startDefinition = functionByName(definitions, "start");
		const waitDefinition = functionByName(definitions, "wait");
		try {
			const startSignal = new AbortController();
			startSignal.abort(new Error("cell already interrupted"));
			const handle = objectValue(
				await startDefinition.handler(
					{ task: "independent turn", name: "worker", reuse: "never" },
					startSignal.signal,
				),
			);
			if (typeof handle.id !== "string" || typeof handle.turn_id !== "string") {
				throw new Error("Missing Agent Turn handle");
			}
			expect(handle).toMatchObject({
				$riemann: "agent_turn_handle.v1",
				status: "running",
			});

			const waitController = new AbortController();
			const interrupted = waitDefinition.handler(
				{ agent_id: handle.id, turn_id: handle.turn_id },
				waitController.signal,
			);
			waitController.abort(new Error("interrupt only the wait"));
			await expect(interrupted).rejects.toMatchObject({ code: "cancelled" });
			expect(store.getAgent(handle.id)?.status).toBe("running");

			const completed = waitDefinition.handler(
				{ agent_id: handle.id, turn_id: handle.turn_id },
				new AbortController().signal,
			);
			sessions.get(handle.id)?.at(-1)?.finish();
			expect(objectValue(await completed)).toMatchObject({
				$riemann: "agent_result.v1",
				id: handle.id,
				turn_id: handle.turn_id,
				status: "idle",
				outcome: "ok",
				output: "child completed: independent turn",
			});
			expect(store.listPendingAgentEvents(mainId)).toHaveLength(0);
			expect(deliveries).toHaveLength(0);
		} finally {
			await supervisor.close();
			store.close();
		}
	});
	test("uses the configured default child model without requiring a profile", async () => {
		const childModel = getModel("openai", "gpt-4o");
		if (!childModel) throw new Error("Configured test model is unavailable");
		const harness = await createHarness(
			{
				agentDefaults: {
					workspace: "shared",
					network: "inherit",
					model: `${childModel.provider}/${childModel.id}`,
				},
			},
			undefined,
			childModel,
		);
		const { supervisor, store, mainId, sessions, modelIds } = harness;
		try {
			const handle = objectValue(await supervisor.start(mainId, { task: "Use the default model", name: "worker" }));
			if (typeof handle.id !== "string") throw new Error("Start did not return an Agent id");
			const childId = handle.id;
			await waitFor(() => modelIds.length === 1);
			expect(modelIds).toEqual([`${childModel.provider}/${childModel.id}`]);
			sessions.get(childId)?.at(-1)?.finish();
			await waitFor(() => store.getAgent(childId)?.status === "idle");
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("runs an inherited extension provider in the default child session", async () => {
		const faux = fauxProvider({
			provider: "faux-child",
			models: [{ id: "faux-child-model", name: "Faux child model", reasoning: false }],
		});
		faux.setResponses([fauxAssistantMessage("child session ready")]);
		const childModel = faux.getModel();
		const modelRegistry = {
			find: (provider: string, id: string) =>
				provider === childModel.provider && id === childModel.id ? childModel : undefined,
			getRegisteredProviderIds: () => [faux.provider.id],
			getRegisteredNativeProvider: (provider: string) => (provider === faux.provider.id ? faux.provider : undefined),
			getRegisteredProviderConfig: () => undefined,
		} as unknown as ModelRegistry;
		const harness = await createHarness({}, undefined, undefined, {
			defaultSession: true,
			rootModel: childModel,
			modelRegistry,
		});
		const { supervisor, store, mainId, agentDir } = harness;
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ [faux.provider.id]: { type: "api_key", key: "faux-key" } }),
		);
		try {
			const handle = objectValue(
				await supervisor.start(mainId, { task: "Complete the child turn", name: "worker" }),
			);
			if (typeof handle.id !== "string") throw new Error("Start did not return an Agent id");
			const childId = handle.id;
			await waitFor(() => store.getAgent(childId)?.status === "idle", 10_000);
			expect(store.getAgent(childId)).toMatchObject({
				status: "idle",
				lastOutcome: "ok",
				result: expect.stringContaining("child session ready"),
			});
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("warns a new text-only child when snapshot compaction is configured", async () => {
		const faux = fauxProvider({
			provider: "faux-snapshot-child",
			models: [{ id: "text-only", name: "Text-only child", reasoning: false, input: ["text"] }],
		});
		faux.setResponses([fauxAssistantMessage("child session ready")]);
		const childModel = faux.getModel();
		expect(childModel.input).not.toContain("image");
		const warnings: string[] = [];
		const modelRegistry = {
			find: (provider: string, id: string) =>
				provider === childModel.provider && id === childModel.id ? childModel : undefined,
			getRegisteredProviderIds: () => [faux.provider.id],
			getRegisteredNativeProvider: (provider: string) => (provider === faux.provider.id ? faux.provider : undefined),
			getRegisteredProviderConfig: () => undefined,
			isUsingOAuth: () => false,
		} as unknown as ModelRegistry;
		const harness = await createHarness({}, undefined, undefined, {
			defaultSession: true,
			rootModel: childModel,
			modelRegistry,
			warningSink: (message) => {
				warnings.push(message);
			},
		});
		const { supervisor, store, mainId, agentDir } = harness;
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "config.yaml"), "version: 1\ncompaction:\n  strategy: snapshot\n");
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ [faux.provider.id]: { type: "api_key", key: "faux-key" } }),
		);
		try {
			const handle = objectValue(await supervisor.start(mainId, { task: "Complete", name: "snapshot-worker" }));
			if (typeof handle.id !== "string") throw new Error("Missing Agent id");
			await waitFor(() => store.getAgent(handle.id as string)?.status === "idle", 10_000);
			expect(warnings).toContainEqual(
				expect.stringContaining("Snapshot compaction requires an image-capable model"),
			);
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("warns incompatible live children after a global strategy write even when the root is compatible", async () => {
		const rootModel = getModel("openai", "gpt-4o-mini");
		if (!rootModel) throw new Error("Built-in root model is unavailable");
		expect(rootModel.input).toContain("image");
		const childModel = {
			provider: "faux",
			id: "text-only",
			name: "Text only",
			api: "faux:test",
			input: ["text"],
		} as Model<any>;
		const warnings: string[] = [];
		const modelRegistry = {
			find: (provider: string, id: string) =>
				provider === childModel.provider && id === childModel.id ? childModel : undefined,
			isUsingOAuth: () => false,
		} as unknown as ModelRegistry;
		const harness = await createHarness(
			{
				compaction: { strategy: "automatic" },
				agentDefaults: {
					workspace: "shared",
					network: "inherit",
					model: `${childModel.provider}/${childModel.id}`,
				},
			},
			undefined,
			childModel,
			{
				rootModel,
				modelRegistry,
				warningSink: (message) => {
					warnings.push(message);
				},
			},
		);
		const { supervisor, store, mainId, sessions, agentDir } = harness;
		try {
			const handle = objectValue(await supervisor.start(mainId, { task: "Wait", name: "live-worker" }));
			if (typeof handle.id !== "string") throw new Error("Missing Agent id");
			await waitFor(() => supervisor.listSubagentsForUi().some((agent) => agent.id === handle.id && agent.live));

			await updateGlobalRiemannSetting(agentDir, "compaction.strategy", "snapshot");

			expect(warnings).toEqual([expect.stringContaining("Snapshot compaction requires an image-capable model")]);
			sessions.get(handle.id)?.at(-1)?.finish();
			await waitFor(() => store.getAgent(handle.id as string)?.status === "idle");
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("does not warn live children for a global strategy hidden by a project override", async () => {
		const childModel = {
			provider: "faux",
			id: "text-only",
			name: "Text only",
			api: "faux:test",
			input: ["text"],
		} as Model<any>;
		const warnings: string[] = [];
		const modelRegistry = {
			find: (provider: string, id: string) =>
				provider === childModel.provider && id === childModel.id ? childModel : undefined,
			isUsingOAuth: () => false,
		} as unknown as ModelRegistry;
		const harness = await createHarness(
			{
				compaction: { strategy: "default" },
				projectOverrides: new Set(["compaction.strategy"]),
				agentDefaults: {
					workspace: "shared",
					network: "inherit",
					model: `${childModel.provider}/${childModel.id}`,
				},
			},
			undefined,
			childModel,
			{
				modelRegistry,
				warningSink: (message) => {
					warnings.push(message);
				},
			},
		);
		const { supervisor, store, mainId, sessions, agentDir, root } = harness;
		await mkdir(join(root, ".riemann"), { recursive: true });
		await writeFile(join(root, ".riemann", "config.yaml"), "version: 1\ncompaction:\n  strategy: default\n");
		try {
			const handle = objectValue(await supervisor.start(mainId, { task: "Wait", name: "project-worker" }));
			if (typeof handle.id !== "string") throw new Error("Missing Agent id");
			await waitFor(() => supervisor.listSubagentsForUi().some((agent) => agent.id === handle.id && agent.live));

			await updateGlobalRiemannSetting(agentDir, "compaction.strategy", "snapshot");

			expect(warnings).toEqual([]);
			sessions.get(handle.id)?.at(-1)?.finish();
			await waitFor(() => store.getAgent(handle.id as string)?.status === "idle");
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("enforces the global slot cap across idle and stopped Agents until the user releases one", async () => {
		const harness = await createHarness({ maxAgents: 2, maxConcurrentAgents: 1 });
		const { supervisor, store, mainId, sessions } = harness;
		const steerDefinition = functionByName(supervisor.definitions(mainId), "steer");
		try {
			const first = objectValue(await supervisor.start(mainId, { task: "first", name: "first" }));
			const second = objectValue(await supervisor.start(mainId, { task: "second", name: "second" }));
			if (typeof first.id !== "string" || typeof second.id !== "string") throw new Error("Missing Agent ids");
			const firstId = first.id;
			const secondId = second.id;
			await waitFor(() => store.getAgent(firstId)?.status === "running");
			expect(store.getAgent(secondId)?.status).toBe("queued");
			expect(second).toMatchObject({ $riemann: "agent_turn_handle.v1", status: "queued" });
			await expect(
				steerDefinition.handler(
					{ agent_id: secondId, turn_id: second.turn_id, message: "queued steering" },
					new AbortController().signal,
				),
			).rejects.toMatchObject({ code: "conflict" });
			expect(store.listInbox(secondId)).toHaveLength(0);
			await expect(supervisor.start(mainId, { task: "third", name: "third" })).rejects.toMatchObject({
				code: "limit_exceeded",
			});

			await supervisor.stopSubagentFromUi(secondId);
			expect(store.getAgent(secondId)?.status).toBe("stopped");
			await expect(supervisor.start(mainId, { task: "third", name: "third" })).rejects.toMatchObject({
				code: "limit_exceeded",
			});

			await supervisor.releaseSubagentFromUi(secondId);
			expect(store.getAgent(secondId)?.releasedAt).not.toBeNull();
			expect(supervisor.listSubagentsForUi().some((agent) => agent.id === secondId)).toBe(false);
			const replacement = objectValue(await supervisor.start(mainId, { task: "replacement", name: "second" }));
			if (typeof replacement.id !== "string") throw new Error("Missing replacement Agent id");
			expect(replacement.id).not.toBe(secondId);
			expect(store.listAgents(harness.runId).filter((agent) => agent.parentId !== null)).toHaveLength(2);

			sessions.get(firstId)?.at(-1)?.finish();
			await waitFor(() => store.getAgent(replacement.id as string)?.status === "running");
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("keeps failed delivery events durable and emits each completion payload once on retry", async () => {
		let attempts = 0;
		const harness = await createHarness({}, async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("delivery unavailable");
		});
		const { supervisor, store, mainId, sessions } = harness;
		try {
			const handle = objectValue(await supervisor.start(mainId, { task: "complete once", name: "worker" }));
			if (typeof handle.id !== "string") throw new Error("Missing Agent id");
			const childId = handle.id;
			await waitFor(() => store.getAgent(childId)?.status === "running");
			sessions.get(childId)?.at(-1)?.finish();
			await waitFor(() => store.getAgent(childId)?.status === "idle");
			await waitFor(() => attempts >= 1);
			expect(store.listPendingAgentEvents(mainId)).toHaveLength(1);

			await supervisor.flushAgentEvents();
			expect(attempts).toBe(2);
			expect(store.listPendingAgentEvents(mainId)).toHaveLength(0);
			expect(
				new Set(harness.deliveries.map((delivery) => delivery.events.map((event) => event.id).join(","))).size,
			).toBe(1);
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("backfills immutable Turns and pending completion events from the pre-Turn database", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-agent-turn-migration-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		const stateDir = join(agentDir, "state");
		await mkdir(stateDir, { recursive: true });
		const database = new DatabaseSync(join(stateDir, "riemann.db"));
		const timestamp = "2026-08-14T00:00:00.000Z";
		database.exec(`
			CREATE TABLE schema_version (version INTEGER NOT NULL);
			INSERT INTO schema_version(version) VALUES(2);
			CREATE TABLE runs (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL UNIQUE,
				cwd TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE agents (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				parent_id TEXT,
				name TEXT NOT NULL,
				status TEXT NOT NULL,
				prompt TEXT NOT NULL,
				model_role TEXT NOT NULL,
				workspace TEXT NOT NULL,
				workspace_mode TEXT NOT NULL,
				permissions TEXT NOT NULL,
				depth INTEGER NOT NULL,
				capabilities_json TEXT NOT NULL,
				result TEXT,
				error TEXT,
				last_outcome TEXT,
				transcript_handle TEXT,
				patch_handle TEXT,
				released_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(run_id, name)
			);
			CREATE TABLE agent_events (
				id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				recipient_id TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				created_at TEXT NOT NULL,
				delivered_at TEXT
			);
		`);
		database
			.prepare("INSERT INTO runs VALUES(?, ?, ?, 'active', ?, ?)")
			.run("legacy-run", "legacy-session", root, timestamp, timestamp);
		const insertAgent = database.prepare(
			"INSERT INTO agents VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		insertAgent.run(
			"legacy-main",
			"legacy-run",
			null,
			"Main",
			"running",
			"",
			"main",
			root,
			"shared",
			"host",
			0,
			JSON.stringify(["*"]),
			null,
			null,
			null,
			null,
			null,
			null,
			timestamp,
			timestamp,
		);
		insertAgent.run(
			"legacy-child",
			"legacy-run",
			"legacy-main",
			"worker",
			"idle",
			"legacy task",
			"inherit",
			root,
			"shared",
			"workspace",
			1,
			JSON.stringify(["workspace.read"]),
			"legacy result",
			null,
			"ok",
			"artifact://legacy-transcript",
			null,
			null,
			timestamp,
			timestamp,
		);
		database.prepare("INSERT INTO agent_events VALUES(?, ?, ?, ?, ?, NULL)").run(
			"legacy-event",
			"legacy-run",
			"legacy-main",
			JSON.stringify({
				agentId: "legacy-child",
				name: "worker",
				outcome: "ok",
				resultPreview: "legacy result",
				transcriptHandle: "artifact://legacy-transcript",
				patchHandle: null,
			}),
			timestamp,
		);
		database.close();

		const store = new RiemannStore(agentDir);
		try {
			const child = store.getAgent("legacy-child");
			expect(child?.activeTurnId).toBeNull();
			expect(child?.lastTurnId).toEqual(expect.any(String));
			const turn = child?.lastTurnId ? store.getAgentTurn(child.lastTurnId) : undefined;
			expect(turn).toMatchObject({
				agentId: "legacy-child",
				task: "legacy task",
				status: "settled",
				outcome: "ok",
				result: "legacy result",
			});
			expect(store.listPendingAgentEvents("legacy-main")).toEqual([
				expect.objectContaining({
					id: "legacy-event",
					payload: {
						agentId: "legacy-child",
						name: "worker",
						turnId: child?.lastTurnId,
						outcome: "ok",
					},
				}),
			]);
		} finally {
			store.close();
		}
	});

	test("loads a settled conversation from its persisted child Session", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-agent-transcript-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		const store = new RiemannStore(agentDir);
		const run = store.openRun("persisted-transcript", root);
		const main = store.ensureRootAgent(run.id, root);
		const child = store.createAgent({
			runId: run.id,
			parentId: main.id,
			name: "persisted",
			status: "idle",
			prompt: "persisted task",
			modelRole: "inherit",
			workspace: root,
			workspaceMode: "shared",
			filesystem: FULL_FILESYSTEM,
			network: "deny",
			depth: 1,
			capabilities: ["fs.read"],
		});
		const sessionDir = join(agentDir, "state", "child-sessions", child.id);
		await mkdir(sessionDir, { recursive: true });
		const session = SessionManager.create(root, sessionDir);
		session.appendMessage(fauxAssistantMessage("persisted child answer"));
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in test model is unavailable");
		const supervisor = new AgentSupervisor({
			store,
			artifacts: new ArtifactStore(store, run.id),
			runId: run.id,
			rootAgent: main,
			rootContext: {
				cwd: root,
				model,
				modelRegistry: { find: () => undefined } as unknown as ModelRegistry,
				thinkingLevel: "off",
			},
			agentDir,
			config,
			createChildRuntime: async () => fakeRuntime(),
		});
		try {
			const messages = supervisor.listSubagentsForUi().find((agent) => agent.id === child.id)?.messages ?? [];
			expect(JSON.stringify(messages)).toContain("persisted child answer");
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("captures an isolated worktree patch artifact and removes the worktree only on release", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-agent-worktree-"));
		roots.push(root);
		const repository = join(root, "repository");
		const agentDir = join(root, "agent");
		await mkdir(repository);
		await git(repository, ["init"]);
		await git(repository, ["config", "user.email", "riemann@example.invalid"]);
		await git(repository, ["config", "user.name", "Riemann Test"]);
		await writeFile(join(repository, "tracked.txt"), "tracked\n");
		await git(repository, ["add", "tracked.txt"]);
		await git(repository, ["commit", "-m", "initial"]);

		const store = new RiemannStore(agentDir);
		const run = store.openRun("worktree-test", repository);
		const main = store.ensureRootAgent(run.id, repository, FULL_FILESYSTEM);
		const artifacts = new ArtifactStore(store, run.id);
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in test model is unavailable");
		const sessions = new Map<string, FakeChildSession>();
		const deliveries: AgentEventDelivery[] = [];
		const supervisor = new AgentSupervisor({
			store,
			artifacts,
			runId: run.id,
			rootAgent: main,
			rootContext: {
				cwd: repository,
				model,
				modelRegistry: { find: () => undefined } as unknown as ModelRegistry,
				thinkingLevel: "off",
			},
			agentDir,
			config: { ...config, maxAgents: 1, maxConcurrentAgents: 1 },
			createChildRuntime: async () => fakeRuntime(),
			createChildSession: async (agent) => {
				const childSession = new FakeChildSession();
				sessions.set(agent.id, childSession);
				return childSession;
			},
			deliverAgentEvents: async (delivery) => {
				deliveries.push(delivery);
			},
		});
		try {
			const handle = objectValue(
				await supervisor.start(main.id, { task: "work independently", name: "worker", profile: "isolated" }),
			);
			if (typeof handle.id !== "string") throw new Error("Missing Agent id");
			const childId = handle.id;
			await waitFor(() => store.getAgent(childId)?.status === "running");
			const child = store.getAgent(childId);
			if (!child) throw new Error("Missing stored Agent");
			expect(child.workspace).not.toBe(repository);
			await writeFile(join(child.workspace, "tracked.txt"), "changed in child\n");
			sessions.get(child.id)?.finish();
			await waitFor(() => store.getAgent(child.id)?.status === "idle");
			await supervisor.flushAgentEvents();

			const settled = store.getAgent(child.id);
			if (!settled?.patchHandle) throw new Error("Missing patch artifact");
			const patch = objectValue(await artifacts.get(settled.patchHandle));
			expect(patch.content).toContain("changed in child");
			expect(JSON.stringify(deliveries.at(-1))).not.toContain(settled.patchHandle);

			await supervisor.releaseSubagentFromUi(child.id);
			await expect(access(child.workspace)).rejects.toThrow();
		} finally {
			await supervisor.close();
			store.close();
		}
	}, 30_000);
	test("failed exact-Turn steering cannot become a later Turn", async () => {
		const harness = await createHarness();
		const { supervisor, store, mainId, sessions } = harness;
		const steerDefinition = functionByName(supervisor.definitions(mainId), "steer");
		try {
			const handle = objectValue(await supervisor.start(mainId, { task: "active turn", name: "steer-race" }));
			if (typeof handle.id !== "string" || typeof handle.turn_id !== "string") throw new Error("Missing handle");
			await waitFor(() => store.getAgent(handle.id as string)?.status === "running");
			const session = sessions.get(handle.id)?.at(-1);
			if (!session) throw new Error("Missing child session");
			session.steerFailure = new Error("stream settled concurrently");
			await expect(
				steerDefinition.handler(
					{ agent_id: handle.id, turn_id: handle.turn_id, message: "must not become a task" },
					new AbortController().signal,
				),
			).rejects.toThrow("stream settled concurrently");
			expect(store.listInbox(handle.id, { unreadOnly: true })).toEqual([]);
			session.finish();
			await waitFor(() => store.getAgent(handle.id as string)?.status === "idle");
			expect(store.listAgentTurns(handle.id)).toHaveLength(1);
		} finally {
			await supervisor.close();
			store.close();
		}
	});

	test("inherits one network policy for child IPython and shell without allowing elevation", async () => {
		const inherited = await createHarness(
			{ agentDefaults: { workspace: "shared", network: "inherit" } },
			undefined,
			undefined,
			{ rootNetwork: "allow" },
		);
		const denied = await createHarness({
			profiles: { offline: { network: "deny" }, elevated: { network: "allow" } },
			agentDefaults: { workspace: "shared", network: "inherit" },
		});
		try {
			const inheritedHandle = objectValue(
				await inherited.supervisor.start(inherited.mainId, { task: "inherit network", name: "inherited" }),
			);
			expect(inherited.store.getAgent(String(inheritedHandle.id))?.network).toBe("allow");

			const offlineHandle = objectValue(
				await denied.supervisor.start(denied.mainId, {
					task: "deny network",
					name: "offline",
					profile: "offline",
				}),
			);
			expect(denied.store.getAgent(String(offlineHandle.id))?.network).toBe("deny");
			await expect(
				denied.supervisor.start(denied.mainId, {
					task: "invalid elevation",
					name: "elevated",
					profile: "elevated",
				}),
			).rejects.toMatchObject({ code: "permission_denied" });
		} finally {
			await inherited.supervisor.close();
			inherited.store.close();
			await denied.supervisor.close();
			denied.store.close();
		}
	});
});
