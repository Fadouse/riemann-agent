import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { deliverAgentEvents, default as riemannExtension } from "../src/extensions/riemann/index.ts";
import type { AgentEventDelivery } from "../src/riemann/agents/supervisor.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Riemann session extension", () => {
	test("persists each completion receipt and sends one immediate minimal steering reminder", () => {
		const entries: Array<{ type: string; customType: string; data: unknown }> = [];
		const sent: Array<{
			customType: string;
			content: unknown;
			details: unknown;
			options: unknown;
		}> = [];
		const api = {
			appendEntry(customType: string, data: unknown) {
				entries.push({ type: "custom", customType, data });
			},
			sendMessage(message: { customType: string; content?: unknown; details?: unknown }, options: unknown) {
				sent.push({
					customType: message.customType,
					content: message.content,
					details: message.details,
					options,
				});
			},
		};
		const ctx = {
			sessionManager: { getEntries: () => entries },
		} as unknown as ExtensionContext;
		const delivery: AgentEventDelivery = {
			events: [
				{
					id: "event-1",
					agentId: "agent-1",
					name: "reviewer",
					turnId: "turn-1",
					outcome: "ok",
				},
				{
					id: "event-2",
					agentId: "agent-2",
					name: "tester",
					turnId: "turn-2",
					outcome: "ok",
				},
			],
		};

		deliverAgentEvents(api as never, ctx, delivery);
		deliverAgentEvents(api as never, ctx, delivery);

		expect(entries).toEqual([
			{
				type: "custom",
				customType: "riemann-agent-events",
				data: {
					eventIds: ["event-1", "event-2"],
					completions: [
						{ name: "reviewer", outcome: "ok" },
						{ name: "tester", outcome: "ok" },
					],
				},
			},
		]);
		expect(sent).toEqual([
			{
				customType: "riemann-agent-completion",
				content:
					"[Riemann Agent completion]\n\nAgent reviewer (agent-1) completed turn turn-1: ok.\nAgent tester (agent-2) completed turn turn-2: ok.\n\nProgress only: wait for every retained handle and read each AgentResult.output before synthesizing a batch.",
				details: { eventIds: ["event-1", "event-2"] },
				options: { triggerTurn: true, deliverAs: "steer" },
			},
		]);
	});

	test("removes profile from Agent operations and omits an empty profile inventory", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-extension-empty-profiles-"));
		roots.push(root);
		const agentDir = join(root, "agent-dir");
		const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
		process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "config.yaml"), "version: 1\nagents:\n  maxAgents: 4\n");
		let runtime: RiemannRuntime | undefined;
		try {
			runtime = await RiemannRuntime.createRoot({
				cwd: root,
				model: undefined,
				modelRegistry: { find: () => undefined },
				thinkingLevel: "off",
				sessionManager: { getSessionId: () => "empty-profile-contract" },
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext);
			const systemPrompt = runtime.systemPrompt("main");
			expect(systemPrompt).toContain("`await agents.spawn(task, name=None) -> AgentHandle`");
			expect(systemPrompt).toContain("`await agents.run(task, name=None, timeout=None) -> AgentResult`");
			expect(systemPrompt).not.toContain("profile=None");
			expect(systemPrompt).not.toContain("## Agent profiles");
			expect(systemPrompt).not.toContain("No Agent policy profiles");
		} finally {
			await runtime?.close();
			if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
			else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	test("exposes only IPython and checkpoints a session through the live runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-extension-"));
		roots.push(root);
		const agentDir = join(root, "agent-dir");
		const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
		process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			[
				"version: 1",
				"agents:",
				"  profiles:",
				"    researcher:",
				"      description: Research public sources without modifying files.",
				"      workspace: shared",
				"      filesystem:",
				"        write: []",
				"      capabilities:",
				"        - web",
				"mcp:",
				"  servers:",
				"    public_docs:",
				"      description: Search approved internal documentation.",
				`      command: ${JSON.stringify(process.execPath)}`,
				"      args:",
				`        - ${JSON.stringify(join(import.meta.dirname, "fixtures", "riemann-mcp-server.mjs"))}`,
				"      env:",
				"        PRIVATE_TOKEN: secret",
				"    hidden_docs:",
				"      description: Hidden documentation.",
				"      exposeToModel: false",
				"      command: hidden-command",
				"",
			].join("\n"),
		);
		const registered: ToolDefinition[] = [];
		const registeredCommands: string[] = [];
		let beforeStart: ((event: unknown, ctx: ExtensionContext) => Promise<unknown>) | undefined;
		let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<unknown>) | undefined;
		let shutdown: ((event: unknown, ctx: ExtensionContext) => Promise<unknown>) | undefined;
		const api = {
			registerEntryRenderer() {},
			registerTool(tool: ToolDefinition) {
				registered.push(tool);
			},
			registerCommand(name: string) {
				registeredCommands.push(name);
			},
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
				if (name === "session_start") sessionStart = handler;
				if (name === "before_agent_start") beforeStart = handler;
				if (name === "session_shutdown") shutdown = handler;
			},
			getActiveTools: () => [registered[0]?.name].filter(Boolean),
			setActiveTools() {},
		};
		const model = {
			provider: "faux",
			id: "faux-model",
			name: "Faux model",
			api: "faux:test",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_096,
			baseUrl: "https://example.invalid",
		} as Model<any>;
		const ctx = {
			cwd: root,
			model,
			modelRegistry: { find: () => undefined },
			thinkingLevel: "off",
			sessionManager: { getSessionId: () => "extension-test-session", getEntries: () => [] },
			isProjectTrusted: () => true,
			isIdle: () => true,
		} as unknown as ExtensionContext;
		const sessionStartContext = { ...ctx, model: undefined } as ExtensionContext;
		try {
			riemannExtension(api as never);
			expect(registered.map((tool) => tool.name)).toEqual(["ipython"]);
			expect(registeredCommands).toEqual(["agents"]);
			expect(registered[0]?.description).toBe(
				"Execute Python in a persistent IPython environment. The operation namespaces listed in the system prompt are preinstalled globals; calls can be assigned and composed with top-level await. Variables persist across executions.",
			);
			expect(JSON.stringify(registered[0]?.parameters)).not.toContain("IPython");
			expect(JSON.stringify(registered[0]?.parameters)).toContain("asyncio.gather");
			expect(sessionStart).toBeDefined();
			await sessionStart?.({}, sessionStartContext);
			expect(beforeStart).toBeDefined();
			const updateRootContext = vi.spyOn(RiemannRuntime.prototype, "updateRootContext");
			const prepared = await beforeStart?.({ systemPromptOptions: {} }, ctx);
			expect(updateRootContext).toHaveBeenLastCalledWith(ctx);
			expect(prepared && typeof prepared === "object" && "systemPrompt" in prepared).toBe(true);
			if (!prepared || typeof prepared !== "object" || !("systemPrompt" in prepared)) {
				throw new Error("Riemann system prompt was not prepared");
			}
			const systemPrompt = String(prepared.systemPrompt);
			expect(systemPrompt).toContain("## Environment");
			expect(systemPrompt).toContain(`Current working directory: ${JSON.stringify(root)}`);
			expect(systemPrompt).toMatch(/- OS: \S+/);
			expect(systemPrompt).toMatch(/- Kernel: \S+/);
			expect(systemPrompt).toMatch(/- Architecture: \S+/);
			expect(systemPrompt).not.toContain("- Shell:");
			expect(systemPrompt).toContain("`ipython` is a persistent Python environment");
			expect(systemPrompt).toContain("already available as globals");
			expect(systemPrompt).toContain("compose operations with normal Python");
			expect(systemPrompt).toContain("## Available operations");
			expect(systemPrompt).toContain("`await fs.read(path) -> TextSnapshot | ImageSnapshot`");
			expect(systemPrompt).toContain("`await shell.run(");
			expect(systemPrompt).not.toContain("shell.exec");
			expect(systemPrompt).not.toContain("artifacts.get");
			expect(systemPrompt).not.toContain("artifacts.view");
			expect(systemPrompt).not.toContain("artifacts.materialize");
			expect(systemPrompt).not.toContain("catalog.namespaces");
			expect(systemPrompt).not.toContain("state.checkpoint");
			expect(systemPrompt).toContain("`await state.status() -> dict`");
			expect(systemPrompt).toContain("`await agents.spawn(task, name=None, profile=None) -> AgentHandle`");
			expect(systemPrompt).toContain(
				"`await agents.run(task, name=None, profile=None, timeout=None) -> AgentResult`",
			);
			expect(systemPrompt).toContain("`await handle.wait(timeout=None) -> AgentResult`");
			expect(systemPrompt).toContain("`await agents.list() -> list[AgentInfo]`");
			expect(systemPrompt).toContain(
				"AgentInfo items are handles; inspect `name`, `status`, `task`, `last_outcome`, and `output_preview`, then use `await info.wait()` for the full `AgentResult.output`.",
			);
			expect(systemPrompt).toContain(
				"`import asyncio; handles = await asyncio.gather(agents.spawn(...), agents.spawn(...))`",
			);
			expect(systemPrompt).toContain("`results = await asyncio.gather(*(handle.wait() for handle in handles))`");
			expect(systemPrompt).not.toContain("`agents.wait(");
			expect(systemPrompt).not.toContain("`agents.result(");
			expect(systemPrompt).not.toContain("`agents.inbox(");
			expect(systemPrompt).not.toContain("workspace_policy");
			expect(systemPrompt).toContain("## Configured agent profiles");
			expect(systemPrompt).toContain('- "researcher": Research public sources without modifying files.');
			expect(systemPrompt).toContain(
				"`profile` selects an optional configured policy bundle. Use an exact key below; express the child role and objective in `task`.",
			);
			expect(systemPrompt).toContain('- "public_docs": Search approved internal documentation.');
			expect(systemPrompt).not.toContain("`mcp.list(");
			expect(systemPrompt).not.toContain("hidden_docs");
			expect(systemPrompt).not.toContain("private-docs-command");
			expect(systemPrompt).not.toContain("PRIVATE_TOKEN");

			const pixelBase64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
			await writeFile(join(root, "pixel.png"), Buffer.from(pixelBase64, "base64"));
			const updates: unknown[] = [];
			const ipython = registered[0];
			const executed = await ipython.execute(
				"cell-1",
				{
					code: [
						"assert not hasattr(mcp, 'list')",
						"assert not hasattr(agents, 'wait')",
						"assert 'artifacts' not in globals(), sorted(name for name in globals() if not name.startswith('_'))",
						"assert not hasattr(catalog, 'namespaces')",
						"assert not hasattr(state, 'checkpoint')",
						"assert hasattr(catalog, 'search')",
						"assert hasattr(state, 'status')",
						"assert hasattr(agents, 'run')",
						"assert not hasattr(agents, 'result')",
						"assert not hasattr(agents, 'inbox')",
						"assert not hasattr(agents, 'park')",
						"assert not hasattr(agents, 'revive')",
						"mesh = await agents.list()",
						"assert mesh == [], mesh",
						"snap = await fs.create(path='value.txt', text='before\\n')",
						"snap = await fs.edit(snapshot=snap, operations=[{'kind':'replace','start':0,'end':6,'text':'after'}])",
						"image = await fs.read(path='pixel.png')",
						"assert isinstance(image, ImageSnapshot), image",
						"viewed = await image.artifact.view()",
						"assert isinstance(viewed, ImageSnapshot), viewed",
						`display({"image/png": "${pixelBase64}"}, raw=True)`,
						"process = await shell.run(script=\"printf 'streamed\\n' | tail -1\")",
						"assert process.exit_code == 0 and process.stdout.strip() == 'streamed', process",
						"public_docs = await mcp.activate(name='public_docs')",
						"matches = await catalog.search(query='sum values')",
						"assert matches[0]['name'] == 'public_docs.sum_values', matches",
						"contract = await catalog.describe(name=matches[0]['name'])",
						"assert contract['name'] == 'public_docs.sum_values', contract",
						"mcp_result = await public_docs.sum_values(left=19, right=23)",
						"assert mcp_result['structuredContent']['total'] == 42, mcp_result",
						"mcp_image = await public_docs.show_pixel()",
						"assert mcp_image['content'][0]['artifact'].mime_type == 'image/png', mcp_image",
						"durable_value = 42",
						"durable_value",
					].join("\n"),
				},
				undefined,
				(update) => updates.push(update),
				ctx,
			);
			if (
				executed.details &&
				typeof executed.details === "object" &&
				"status" in executed.details &&
				executed.details.status !== "ok"
			) {
				const failure = executed.content.find((item) => item.type === "text");
				throw new Error(failure?.type === "text" ? failure.text : "IPython execution failed");
			}
			expect(executed.details).toMatchObject({ status: "ok" });
			const textOutput = executed.content.find((item) => item.type === "text");
			const modelVisibleText = textOutput?.type === "text" ? textOutput.text : "";
			expect(modelVisibleText).toContain("42");
			expect(modelVisibleText).not.toContain("[stderr]");
			expect(modelVisibleText).not.toContain("DeprecationWarning");
			const modelVisibleImages = executed.content.filter((item) => item.type === "image");
			expect(modelVisibleImages).toHaveLength(4);
			expect(modelVisibleImages.every((item) => item.mimeType === "image/png")).toBe(true);
			expect(executed.details).toMatchObject({
				media: expect.arrayContaining([
					expect.objectContaining({ type: "image", mimeType: "image/png", artifactHandle: expect.any(String) }),
				]),
			});
			expect(updates).not.toHaveLength(0);
			const serializedUpdates = JSON.stringify(updates);
			expect(serializedUpdates).toContain('"kind":"file"');
			expect(serializedUpdates).toContain('"kind":"patch"');
			expect(serializedUpdates).toContain('"kind":"shell"');
			expect(serializedUpdates).toContain("streamed");
			expect(executed.details).toMatchObject({
				activities: expect.arrayContaining([
					expect.objectContaining({ kind: "file", operation: "create", status: "ok" }),
					expect.objectContaining({ kind: "patch", operation: "edit", status: "ok" }),
					expect.objectContaining({ kind: "shell", status: "ok", exitCode: 0 }),
				]),
			});
			expect(await readFile(join(root, "value.txt"), "utf8")).toBe("after\n");

			const database = await readFile(join(agentDir, "state", "riemann.db"));
			expect(database.byteLength).toBeGreaterThan(0);
			const snapshotNames = await readdir(join(agentDir, "state", "snapshots"));
			expect(snapshotNames).toHaveLength(1);
			const snapshot = await readFile(join(agentDir, "state", "snapshots", snapshotNames[0], "kernel.dill"));
			expect(snapshot.byteLength).toBeGreaterThan(0);
		} finally {
			await shutdown?.({}, ctx);
			if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
			else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
		}
	}, 30_000);
});
