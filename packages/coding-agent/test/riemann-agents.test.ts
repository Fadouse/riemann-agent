import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test } from "vitest";
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

	finish(): void {
		this.resolveCompletion();
	}
}

function fakeRuntime(): ChildRiemannRuntime {
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
		async close() {},
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
	modelRoles: {},
	profiles: {},
	mcpServers: {},
	web: { searchBackend: "disabled" },
	files: [],
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
				"workspace_policy",
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
			expect(sessions.get(childId)?.steering[0]).toContain("parent steering message");

			sessions.get(childId)?.finish();
			const waited = objectValue(
				await functionByName(supervisor.definitions(main.id), "wait").handler(
					{ agent_id: childId, timeout: 5 },
					signal,
				),
			);
			const agent = objectValue(waited.agent ?? null);
			expect(agent.status).toBe("completed");
			expect(waited.result).toBe("child completed with evidence");

			const webHandle = objectValue(
				await supervisor.spawn(main.id, {
					task: "Research a public source",
					name: "web-worker",
					workspace_policy: "read-only",
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
		} finally {
			await supervisor.close();
			store.close();
		}
	}, 15_000);

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
				workspace_policy: "shared",
				capabilities: ["agents.*"],
			});
			await expect(
				supervisor.spawn(main.id, {
					task: "second",
					name: "stable",
					workspace_policy: "shared",
					capabilities: ["agents.*"],
				}),
			).rejects.toMatchObject({ code: "conflict" });
		} finally {
			await supervisor.close();
			store.close();
		}
	});
});
