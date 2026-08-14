import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import riemannExtension from "../src/extensions/riemann/index.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Riemann session extension", () => {
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
				"      permissions: workspace",
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
			sessionManager: { getSessionId: () => "extension-test-session" },
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;
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
			await sessionStart?.({}, ctx);
			expect(beforeStart).toBeDefined();
			const prepared = await beforeStart?.({ systemPromptOptions: {} }, ctx);
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
			expect(systemPrompt).toContain("`ipython` is a persistent Python environment");
			expect(systemPrompt).toContain("already available as globals");
			expect(systemPrompt).toContain("compose operations with normal Python");
			expect(systemPrompt).toContain("## Available operations");
			expect(systemPrompt).toContain("`workspace.read(path) -> TextSnapshot`");
			expect(systemPrompt).toContain("`shell.run(");
			expect(systemPrompt).toContain("`agents.spawn(task, name=None, profile=None, workspace=None");
			expect(systemPrompt).not.toContain("workspace_policy");
			expect(systemPrompt).toContain("## Configured agent profiles");
			expect(systemPrompt).toContain('- "researcher": Research public sources without modifying files.');
			expect(systemPrompt).toContain('- "public_docs": Search approved internal documentation.');
			expect(systemPrompt).not.toContain("`mcp.list(");
			expect(systemPrompt).not.toContain("hidden_docs");
			expect(systemPrompt).not.toContain("private-docs-command");
			expect(systemPrompt).not.toContain("PRIVATE_TOKEN");

			const updates: unknown[] = [];
			const ipython = registered[0];
			const executed = await ipython.execute(
				"cell-1",
				{
					code: [
						"assert not hasattr(mcp, 'list')",
						"identity = await agents.self()",
						"mesh = await agents.list()",
						"assert len(mesh) == 1 and mesh[0].id == identity.id, mesh",
						"assert identity.workspace_mode == 'shared', identity",
						"assert identity.permissions == 'host', identity",
						"snap = await workspace.create(path='value.txt', text='before\\n')",
						"snap = await workspace.edit(snapshot=snap, operations=[{'kind':'replace','start':0,'end':6,'text':'after'}])",
						"process = await shell.run(command='node', args=['-e', \"console.log('streamed')\"])",
						"public_docs = await mcp.activate(name='public_docs')",
						"matches = await catalog.search(query='sum values')",
						"assert matches[0]['name'] == 'public_docs.sum_values', matches",
						"contract = await catalog.describe(name=matches[0]['name'])",
						"assert contract['name'] == 'public_docs.sum_values', contract",
						"mcp_result = await public_docs.sum_values(left=19, right=23)",
						"assert mcp_result['structuredContent']['total'] == 42, mcp_result",
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
