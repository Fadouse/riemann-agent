import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { AgentSupervisor, type ChildAgentSession, type ChildRiemannRuntime } from "../src/riemann/agents/supervisor.ts";
import type { RiemannConfig } from "../src/riemann/config.ts";
import type { FunctionDefinition } from "../src/riemann/functions/registry.ts";
import { IPythonSchema } from "../src/riemann/ipython.ts";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
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

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execCommand("git", ["-C", cwd, ...args], cwd, { timeout: 30_000 });
	if (result.code !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

class FakeChildSession implements ChildAgentSession {
	readonly state: { messages: unknown[] } = { messages: [] };
	isStreaming = true;
	readonly steering: string[] = [];
	private resolveCompletion!: () => void;
	private readonly completion = new Promise<void>((resolve) => {
		this.resolveCompletion = resolve;
	});

	async prompt(): Promise<void> {
		await this.completion;
		this.isStreaming = false;
		this.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "child completed with evidence" }],
		});
	}

	async steer(text: string): Promise<void> {
		this.steering.push(text);
	}

	async abort(): Promise<void> {
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
	limits: {
		maxAgentsPerRun: 8,
		maxConcurrentPerRun: 4,
		maxConcurrentPerModel: 2,
		maxDepth: 3,
		maxCellOutputChars: 100_000,
		maxArtifactPreviewChars: 12_000,
	},
	retention: { maxAgeDays: 30, maxArtifactBytes: 1_000_000, maxSnapshotBytes: 1_000_000, maxWorktreeBytes: 1_000_000 },
	compaction: { strategy: "snapshot" },
	mainAgent: { permissions: "host" },
	agentDefaults: { workspace: "shared", permissions: "workspace" },
	modelRoles: {},
	profiles: { privileged: { permissions: "host" } },
	mcpServers: {},
	web: { searchBackend: "disabled" },
	files: [],
	projectOverrides: new Set(),
};

describe("Riemann agent mesh", () => {
	test("spawns asynchronously, routes durable messages, and waits for terminal completion", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-agent-mesh-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		const store = new RiemannStore(agentDir);
		const run = store.openRun("mesh-test", root);
		const main = store.ensureRootAgent(run.id, root);
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in test model is unavailable");
		const sessions = new Map<string, FakeChildSession>();
		let releaseWorkerClose!: () => void;
		const workerClose = new Promise<void>((resolve) => {
			releaseWorkerClose = resolve;
		});
		let resolveWorkerCloseStarted!: () => void;
		const workerCloseStarted = new Promise<void>((resolve) => {
			resolveWorkerCloseStarted = resolve;
		});
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
			config: { ...config, limits: { ...config.limits, maxConcurrentPerRun: 1 } },
			createChildRuntime: async (agent) =>
				fakeRuntime(
					agent.name === "worker"
						? async () => {
								resolveWorkerCloseStarted();
								await workerClose;
							}
						: undefined,
				),
			createChildSession: async (agent) => {
				const session = new FakeChildSession();
				sessions.set(agent.id, session);
				return session;
			},
		});
		const signal = new AbortController().signal;
		try {
			const spawnDefinition = functionByName(supervisor.definitions(main.id), "spawn");
			expect(spawnDefinition.parameters.map((parameter) => parameter.name)).toEqual([
				"task",
				"name",
				"profile",
				"workspace",
				"capabilities",
				"model_role",
			]);
			expect(spawnDefinition.promptSnippet).toContain("task and name suffice");
			const handle = objectValue(
				await supervisor.spawn(main.id, {
					task: "Produce a bounded result",
					name: "worker",
				}),
			);
			const childId = handle.id;
			if (typeof childId !== "string") throw new Error("Spawn did not return an agent id");
			await delay(0);
			const storedChild = store.getAgent(childId);
			expect(storedChild).toMatchObject({
				status: "running",
				workspace: root,
				permissions: "workspace",
				capabilities: [
					"workspace.read",
					"workspace.write",
					"shell.run",
					"web.search",
					"web.fetch",
					"agents.*",
					"mcp.*",
				],
			});

			expect(supervisor.listSubagentsForUi()).toContainEqual(
				expect.objectContaining({
					id: childId,
					name: "worker",
					status: "running",
					task: "Produce a bounded result",
					turnCount: 2,
					toolUses: 3,
					tokens: 1_234,
					live: true,
				}),
			);
			let uiNotifications = 0;
			const unsubscribeUi = supervisor.subscribeSubagentUi(() => {
				uiNotifications += 1;
			});
			await supervisor.steerSubagentFromUi(childId, "steer from the Agent Viewer");
			unsubscribeUi();
			expect(sessions.get(childId)?.steering[0]).toContain("steer from the Agent Viewer");
			expect(uiNotifications).toBeGreaterThan(0);

			const childFunctions = supervisor.definitions(childId);
			await functionByName(childFunctions, "send").handler(
				{ agent_id: main.id, message: "child found a concrete dependency" },
				signal,
			);
			const inbox = await functionByName(supervisor.definitions(main.id), "inbox").handler({}, signal);
			expect(Array.isArray(inbox) && objectValue(inbox[0] ?? null).body).toBe("child found a concrete dependency");

			await functionByName(supervisor.definitions(main.id), "send").handler(
				{ agent_id: childId, message: "parent steering message" },
				signal,
			);
			expect(sessions.get(childId)?.steering).toEqual(
				expect.arrayContaining([expect.stringContaining("parent steering message")]),
			);
			const waitController = new AbortController();
			const cancelledWait = functionByName(supervisor.definitions(main.id), "wait").handler(
				{ agent_id: childId },
				waitController.signal,
			);
			waitController.abort(new Error("cancelled by user"));
			await expect(cancelledWait).rejects.toThrow("cancelled by user");
			const cancelledHandle = objectValue(
				await supervisor.spawn(main.id, {
					task: "Remain queued until cancelled",
					name: "cancelled-worker",
				}),
			);
			const cancelledId = cancelledHandle.id;
			if (typeof cancelledId !== "string") throw new Error("Queued spawn did not return an agent id");
			expect(store.getAgent(cancelledId)?.status).toBe("queued");
			await supervisor.stopSubagentFromUi(cancelledId);
			expect(store.getAgent(cancelledId)?.status).toBe("stopped");

			const successorHandle = objectValue(
				await supervisor.spawn(main.id, {
					task: "Start after the active worker finishes",
					name: "successor",
				}),
			);
			const successorId = successorHandle.id;
			if (typeof successorId !== "string") throw new Error("Successor spawn did not return an agent id");
			expect(store.getAgent(successorId)?.status).toBe("queued");

			sessions.get(childId)?.finish();
			const waitedPromise = functionByName(supervisor.definitions(main.id), "wait").handler(
				{ agent_id: childId, timeout: 5 },
				signal,
			);
			await workerCloseStarted;
			const settledBeforeClose = await Promise.race([waitedPromise.then(() => true), delay(100).then(() => false)]);
			releaseWorkerClose();
			const waited = objectValue(await waitedPromise);
			expect(settledBeforeClose).toBe(true);
			const agent = objectValue(waited.agent ?? null);
			expect(agent.status).toBe("completed");
			expect(waited.result).toBe("child completed with evidence");
			await delay(0);
			expect(store.getAgent(successorId)?.status).toBe("running");
			await functionByName(supervisor.definitions(main.id), "stop").handler({ agent_id: successorId }, signal);

			const webHandle = objectValue(
				await supervisor.spawn(main.id, {
					task: "Research a public source",
					name: "web-worker",
					workspace: "shared",
					capabilities: ["web"],
				}),
			);
			const webChildId = webHandle.id;
			if (typeof webChildId !== "string") throw new Error("Spawn did not return an agent id");
			expect(store.getAgent(webChildId)).toMatchObject({
				workspace: root,
				capabilities: ["web.*"],
			});
			await functionByName(supervisor.definitions(main.id), "stop").handler({ agent_id: webChildId }, signal);

			const restrictedParent = store.createAgent({
				runId: run.id,
				parentId: main.id,
				name: "restricted-parent",
				status: "running",
				prompt: "",
				modelRole: "inherit",
				workspace: root,
				workspaceMode: "shared",
				permissions: "workspace",
				depth: 1,
				capabilities: ["agents.spawn", "web.search"],
			});
			const nestedHandle = objectValue(
				await supervisor.spawn(restrictedParent.id, {
					task: "Research within parent permissions",
					name: "nested-worker",
				}),
			);
			const nestedChildId = nestedHandle.id;
			if (typeof nestedChildId !== "string") throw new Error("Spawn did not return an agent id");
			expect(store.getAgent(nestedChildId)).toMatchObject({
				workspace: root,
				capabilities: ["web.search"],
			});
			await functionByName(supervisor.definitions(main.id), "stop").handler({ agent_id: nestedChildId }, signal);
			await expect(
				supervisor.spawn(restrictedParent.id, {
					task: "Attempt to exceed parent scope",
					name: "overprivileged-worker",
					profile: "privileged",
				}),
			).rejects.toMatchObject({ code: "permission_denied" });
		} finally {
			await supervisor.close();
			store.close();
		}
	}, 15_000);

	test("preserves a completed status when shutdown overlaps child teardown", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-agent-close-status-"));
		roots.push(root);
		const agentDir = join(root, ".agent");
		const store = new RiemannStore(agentDir);
		const run = store.openRun("close-status-test", root);
		const main = store.ensureRootAgent(run.id, root);
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in test model is unavailable");
		const sessions = new Map<string, FakeChildSession>();
		let releaseRuntimeClose!: () => void;
		const runtimeClose = new Promise<void>((resolve) => {
			releaseRuntimeClose = resolve;
		});
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
			createChildRuntime: async () => fakeRuntime(async () => runtimeClose),
			createChildSession: async (agent) => {
				const session = new FakeChildSession();
				sessions.set(agent.id, session);
				return session;
			},
		});
		try {
			const handle = objectValue(
				await supervisor.spawn(main.id, { task: "Complete during close", name: "status-race" }),
			);
			const childId = handle.id;
			if (typeof childId !== "string") throw new Error("Spawn did not return an agent id");
			await delay(0);
			sessions.get(childId)?.finish();
			await functionByName(supervisor.definitions(main.id), "wait").handler(
				{ agent_id: childId, timeout: 5 },
				new AbortController().signal,
			);
			const closing = supervisor.close();
			releaseRuntimeClose();
			await closing;
			expect(store.getAgent(childId)?.status).toBe("completed");
		} finally {
			releaseRuntimeClose();
			await supervisor.close();
			store.close();
		}
	});

	test("creates a distinct Git worktree for worktree Subagents", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-agent-worktree-"));
		roots.push(root);
		const repository = join(root, "repository");
		const agentDir = join(root, "agent");
		await mkdir(repository);
		await git(repository, ["init"]);
		await git(repository, ["config", "user.email", "riemann@example.invalid"]);
		await git(repository, ["config", "user.name", "Riemann Test"]);
		await writeFile(join(repository, "tracked.txt"), "tracked");
		await git(repository, ["add", "tracked.txt"]);
		await git(repository, ["commit", "-m", "initial"]);

		const store = new RiemannStore(agentDir);
		const run = store.openRun("worktree-test", repository);
		const main = store.ensureRootAgent(run.id, repository, "host");
		const model = getModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Built-in test model is unavailable");
		const supervisor = new AgentSupervisor({
			store,
			artifacts: new ArtifactStore(store, run.id),
			runId: run.id,
			rootAgent: main,
			rootContext: {
				cwd: repository,
				model,
				modelRegistry: { find: () => undefined } as unknown as ModelRegistry,
				thinkingLevel: "off",
			},
			agentDir,
			config: { ...config, agentDefaults: { workspace: "worktree", permissions: "workspace" } },
			createChildRuntime: async () => fakeRuntime(),
			createChildSession: async () => new FakeChildSession(),
		});
		try {
			const handle = objectValue(await supervisor.spawn(main.id, { task: "work independently", name: "worker" }));
			const childId = handle.id;
			if (typeof childId !== "string") throw new Error("Spawn did not return an agent id");
			const child = store.getAgent(childId);
			expect(child?.workspace).not.toBe(repository);
			expect(child?.workspace).toContain(join("state", "workspaces", run.id, childId));
			expect(child).toMatchObject({ workspaceMode: "worktree", permissions: "workspace" });
			expect(await git(child?.workspace ?? "", ["rev-parse", "--show-toplevel"])).toBe(child?.workspace);
			await functionByName(supervisor.definitions(main.id), "stop").handler(
				{ agent_id: childId },
				new AbortController().signal,
			);
		} finally {
			await supervisor.close();
			store.close();
		}
	}, 30_000);

	test("rejects duplicate stable agent names before starting a second child", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-agent-name-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("name-test", root);
		const main = store.ensureRootAgent(run.id, root);
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
			agentDir: join(root, ".agent"),
			config,
			createChildRuntime: async () => fakeRuntime(),
			createChildSession: async () => new FakeChildSession(),
		});
		try {
			await supervisor.spawn(main.id, {
				task: "first",
				name: "stable",
				workspace: "shared",
				capabilities: ["agents.*"],
			});
			await expect(
				supervisor.spawn(main.id, {
					task: "second",
					name: "stable",
					workspace: "shared",
					capabilities: ["agents.*"],
				}),
			).rejects.toMatchObject({ code: "conflict" });
		} finally {
			await supervisor.close();
			store.close();
		}
	});
});
