import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolExecutionError } from "@earendil-works/pi-agent-core";
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

	test("exposes raw Python and wait, and checkpoints explicit persistent state through the live runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-extension-"));
		roots.push(root);
		const agentDir = join(root, "agent-dir");
		const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
		process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			[
				"agents:",
				"  defaults:",
				"    filesystem:",
				"      readExclude: []",
				"      writeExclude: []",
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
		let settled: ((event: unknown, ctx: ExtensionContext) => Promise<unknown>) | undefined;
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
				if (name === "agent_settled") settled = handler;
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
			expect(registered.map((tool) => tool.name)).toEqual(["ipython", "ipython_wait"]);
			expect(registered[0].constrainedSampling).toMatchObject({ type: "grammar" });
			expect(registeredCommands).toEqual(["agents"]);
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

			const pixelBase64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
			await writeFile(join(root, "pixel.png"), Buffer.from(pixelBase64, "base64"));
			const updates: unknown[] = [];
			const ipython = registered[0];
			const executed = await ipython.execute(
				"cell-1",
				{
					code: [
						'# @exec: {"persist": true}',
						"assert not hasattr(mcp, 'list')",
						"assert not hasattr(agents, 'wait')",
						"assert hasattr(artifacts, 'open')",
						"assert not hasattr(catalog, 'namespaces')",
						"assert not hasattr(state, 'checkpoint')",
						"assert hasattr(catalog, 'search')",
						"assert hasattr(state, 'status')",
						"runtime_status = await state.status()",
						"assert runtime_status.agent_slots.used == 0, runtime_status",
						"assert runtime_status.subagent_defaults.filesystem.read_exclude == [] and runtime_status.subagent_defaults.filesystem.write_exclude == [], runtime_status",
						"assert runtime_status.network.configured == 'inherit' and runtime_status.network.effective == 'deny' and runtime_status.network.source == 'builtin', runtime_status",
						"assert hasattr(agents, 'start')",
						"assert not hasattr(agents, 'result')",
						"assert not hasattr(agents, 'inbox')",
						"assert not hasattr(agents, 'park')",
						"assert not hasattr(agents, 'revive')",
						"mesh = await agents.list()",
						"assert mesh.items == [] and mesh.coverage == 'complete', mesh",
						"snap = await fs.create(path='value.txt', text='before\\n')",
						"snap = await fs.edit(snapshot=snap, operations=[{'kind':'replace','start':0,'end':6,'text':'after'}])",
						"image = await fs.read(path='pixel.png')",
						"assert isinstance(image, ImageSnapshot), image",
						"reopened = await artifacts.open(handle=image.artifact.handle)",
						"assert isinstance(reopened, Artifact) and reopened.handle == image.artifact.handle, reopened",
						"assert reopened.handle.startswith('r') and len(reopened.handle) <= 12, reopened",
						"viewed = await image.artifact.view()",
						"assert isinstance(viewed, ImageSnapshot), viewed",
						`display({"image/png": "${pixelBase64}"}, raw=True)`,
						"process = await shell.run(script=\"printf 'streamed\\n' | tail -1\")",
						"assert process.exit_code == 0 and process.stdout.strip() == 'streamed', process",
						"public_docs = await mcp.open(name='public_docs')",
						"mcp_status = await public_docs.status()",
						"assert mcp_status.status == 'ready' and mcp_status.tool_count == 6, mcp_status",
						"matches = await catalog.search(query='sum values')",
						"assert matches.items[0].name == 'public_docs.sum_values', matches",
						"contract = await catalog.describe(name=matches.items[0].name)",
						"assert contract.name == 'public_docs.sum_values', contract",
						"mcp_result = await public_docs.sum_values(input={'left': 19, 'right': 23})",
						"assert mcp_result.structured_content['total'] == 42, mcp_result",
						"mcp_image = await public_docs.show_pixel(input={})",
						"assert any(item.mime_type == 'image/png' for item in mcp_image.artifacts), mcp_image",
						"await public_docs.close()",
						"assert not hasattr(public_docs, 'sum_values')",
						"scan = await fs.glob(pattern='*')",
						"assert scan.items and scan.coverage == 'complete', scan",
						"await output.show(value=matches, fields=['name'])",
						"read_contract = await catalog.describe(name='Artifact.read')",
						"assert read_contract.signature and read_contract.python_return_type == 'ArtifactSlice', read_contract",
						"durable_value = 42",
						"print(durable_value)",
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
			expect(modelVisibleText).not.toContain("artifact://");
			let displayFailure: AgentToolExecutionError | undefined;
			try {
				await ipython.execute(
					"invalid-display",
					{
						code:
							'# @exec: {"persist": true}\n' +
							"r2 = await shell.run(script=\"printf one >> show-count.txt; printf retained\")\nawait output.show(value=r2, fields=['stdout', 'stderr'], max_items=30000)",
					},
					undefined,
					undefined,
					ctx,
				);
			} catch (error) {
				if (!(error instanceof AgentToolExecutionError)) throw error;
				displayFailure = error;
			}
			expect(displayFailure).toBeDefined();
			const failureBody = JSON.stringify(displayFailure?.result.content);
			expect(failureBody).toContain("max_items");
			expect(failureBody).toContain("30000");
			expect(failureBody).toContain("invalid_arguments");
			expect(failureBody).not.toContain("artifact://");
			expect(failureBody).toContain("details=");
			let unknownFailure: AgentToolExecutionError | undefined;
			try {
				await ipython.execute(
					"unknown-display-argument",
					{
						code:
							'# @exec: {"persist": true}\n' +
							"await output.show(value=r2, fields=['stdout', 'stderr'], limit=30000)",
					},
					undefined,
					undefined,
					ctx,
				);
			} catch (error) {
				if (!(error instanceof AgentToolExecutionError)) throw error;
				unknownFailure = error;
			}
			expect(unknownFailure).toBeDefined();
			const unknownBody = JSON.stringify(unknownFailure?.result.content);
			expect(unknownBody).toContain("30000");
			expect(unknownBody).toContain("invalid_arguments");
			expect(unknownBody).toContain("details=");
			const repaired = await ipython.execute(
				"repair-display",
				{ code: '# @exec: {"persist": true}\n' + "await output.show(value=r2, fields=['stdout', 'stderr'])" },
				undefined,
				undefined,
				ctx,
			);
			expect(JSON.stringify(repaired.content)).toContain("retained");
			expect(await readFile(join(root, "show-count.txt"), "utf8")).toBe("one");
			const modelVisibleImages = executed.content.filter((item) => item.type === "image");
			expect(modelVisibleImages).toHaveLength(2);
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
			await settled?.({}, ctx);
			const checkpointStatus = await ipython.execute(
				"checkpoint-status",
				{ code: "pass" },
				undefined,
				undefined,
				ctx,
			);
			expect(JSON.stringify(checkpointStatus.content)).not.toContain("Checkpoint warning");
			const snapshotNames = await readdir(join(agentDir, "state", "snapshots"));
			expect(snapshotNames).toHaveLength(1);
			const snapshot = await readFile(join(agentDir, "state", "snapshots", snapshotNames[0], "kernel.dill"));
			expect(snapshot.byteLength).toBeGreaterThan(0);
			await shutdown?.({}, ctx);
			await sessionStart?.({}, sessionStartContext);
			const restored = await ipython.execute(
				"restored-cell",
				{
					code: [
						'# @exec: {"persist": true}',
						"assert durable_value == 42",
						"assert snap.text == 'after\\n'",
						"assert scan.items and scan.coverage == 'complete', scan",
						"assert runtime_status.agent_slots.used == 0",
						"print('restored records and cursor')",
					].join("\n"),
				},
				undefined,
				undefined,
				ctx,
			);
			expect(restored.details, JSON.stringify(restored.content)).toMatchObject({ status: "ok" });
		} finally {
			await shutdown?.({}, ctx);
			if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
			else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
		}
	}, 30_000);
});
