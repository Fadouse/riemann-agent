import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadRiemannConfig, updateGlobalRiemannSetting } from "../src/riemann/config.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Riemann configuration", () => {
	test("bounds trusted project Agent slots by the global limit", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		await mkdir(join(project, ".riemann"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			"version: 1\nagents:\n  maxAgents: 8\n  defaults:\n    model: openai/global-agent\nweb:\n  searchBackend: disabled\n",
		);
		await writeFile(
			join(project, ".riemann", "config.yaml"),
			'version: 1\nagents:\n  maxAgents: 12\n  main:\n    filesystem:\n      read: ["/"]\n      write: ["/tmp/riemann-bounded"]\n  defaults:\n    model: anthropic/project-agent\n    workspace: worktree\n    filesystem:\n      read: inherit\n      write: inherit\ncompaction:\n  strategy: openai\n',
		);

		const untrusted = await loadRiemannConfig({ cwd: project, agentDir, projectTrusted: false });
		expect(untrusted.maxAgents).toBe(8);
		expect(untrusted.maxConcurrentAgents).toBe(4);
		expect(untrusted.compaction.strategy).toBe("default");
		expect(untrusted.mainAgent.filesystem).toBeUndefined();
		expect(untrusted.files).toEqual([join(agentDir, "config.yaml")]);
		expect(untrusted.agentDefaults.model).toBe("openai/global-agent");

		const bounded = await loadRiemannConfig({ cwd: project, agentDir, projectTrusted: true });
		expect(bounded.maxAgents).toBe(8);
		expect(bounded.compaction.strategy).toBe("openai");
		expect(bounded.mainAgent.filesystem).toEqual({ read: ["/"], write: ["/tmp/riemann-bounded"] });
		expect(bounded.agentDefaults).toEqual({
			model: "anthropic/project-agent",
			workspace: "worktree",
			filesystem: { read: "inherit", write: "inherit" },
		});
		expect(bounded.web.searchBackend).toBe("disabled");
		expect(bounded.projectOverrides.has("agents.maxAgents")).toBe(false);

		await writeFile(
			join(project, ".riemann", "config.yaml"),
			'version: 1\nagents:\n  maxAgents: 2\n  main:\n    filesystem:\n      readExclude: ["~/.ssh"]\n  defaults:\n    model: anthropic/project-agent\n    workspace: worktree\n    filesystem:\n      write: ["/tmp/riemann-lowered"]\ncompaction:\n  strategy: openai\n',
		);
		const lowered = await loadRiemannConfig({ cwd: project, agentDir, projectTrusted: true });
		expect(lowered.maxAgents).toBe(2);
		expect(lowered.maxConcurrentAgents).toBe(2);
		expect(lowered.files).toEqual([join(agentDir, "config.yaml"), join(project, ".riemann", "config.yaml")]);
		expect([...lowered.projectOverrides]).toEqual([
			"agents.maxAgents",
			"compaction.strategy",
			"agents.main.filesystem",
			"agents.defaults.model",
			"agents.defaults.workspace",
			"agents.defaults.filesystem",
		]);
	});

	test("uses four reusable Agent slots by default and allows delegation to be disabled", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-defaults-"));
		roots.push(root);
		const agentDir = join(root, "agent");

		const defaults = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(defaults.maxAgents).toBe(4);
		expect(defaults.maxConcurrentAgents).toBe(4);

		await updateGlobalRiemannSetting(agentDir, "agents.maxAgents", 0);
		const disabled = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(disabled.maxAgents).toBe(0);
		expect(disabled.maxConcurrentAgents).toBe(0);
	});

	test("requires descriptions for enabled MCP servers visible by default", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-mcp-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			"version: 1\nmcp:\n  servers:\n    docs:\n      command: docs-server\n",
		);

		await expect(loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false })).rejects.toThrow(
			"model-visible MCP server docs requires a description",
		);
	});

	test("allows descriptions to be omitted for hidden or disabled MCP servers", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-hidden-mcp-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			"version: 1\nmcp:\n  servers:\n    hidden:\n      exposeToModel: false\n      command: hidden-server\n    disabled:\n      enabled: false\n      command: disabled-server\n",
		);

		const config = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(Object.keys(config.mcpServers)).toEqual(["hidden", "disabled"]);
	});

	test("updates only the selected global setting while preserving connection definitions", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-write-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			"version: 1\nmcp:\n  servers:\n    docs:\n      description: Documentation\n      command: docs-server\n",
		);

		await updateGlobalRiemannSetting(agentDir, "agents.maxAgents", 8);
		await updateGlobalRiemannSetting(agentDir, "mcp.servers.docs.enabled", false);
		await updateGlobalRiemannSetting(agentDir, "mcp.servers.docs.enabledTools", ["search", "fetch"]);
		await updateGlobalRiemannSetting(agentDir, "agents.defaults.model", "openai/worker");

		const config = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(config.maxAgents).toBe(8);
		expect(config.mcpServers.docs).toMatchObject({
			command: "docs-server",
			enabled: false,
			enabledTools: ["search", "fetch"],
		});
		expect(config.agentDefaults.model).toBe("openai/worker");
		await updateGlobalRiemannSetting(agentDir, "agents.defaults.model", undefined);
		expect(
			(await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false })).agentDefaults.model,
		).toBeUndefined();

		await updateGlobalRiemannSetting(agentDir, "mcp.servers.docs.v2.enabled", false);
		const dotted = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(dotted.mcpServers["docs.v2"]?.enabled).toBe(false);
	});

	test("creates the version-one global config when it does not exist", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-create-"));
		roots.push(root);
		const agentDir = join(root, "agent");

		await updateGlobalRiemannSetting(agentDir, "compaction.strategy", "snapshot");
		await updateGlobalRiemannSetting(agentDir, "agents.maxAgents", 1);
		await updateGlobalRiemannSetting(agentDir, "agents.main.filesystem", {
			read: ["/"],
			write: ["/tmp/riemann-created"],
		});
		await updateGlobalRiemannSetting(agentDir, "agents.defaults.workspace", "worktree");
		await updateGlobalRiemannSetting(agentDir, "agents.defaults.filesystem", {
			read: "inherit",
			write: ["."],
		});

		const config = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(config.compaction.strategy).toBe("snapshot");
		expect(config.maxAgents).toBe(1);
		expect(config.mainAgent.filesystem).toEqual({ read: ["/"], write: ["/tmp/riemann-created"] });
		expect(config.agentDefaults).toEqual({
			workspace: "worktree",
			filesystem: { read: "inherit", write: ["."] },
		});
		expect(await readFile(join(agentDir, "config.yaml"), "utf8")).toContain("version: 1");
	});

	test("rejects the removed permissions field and accepts filesystem policies", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-filesystem-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "config.yaml"), "version: 1\nagents:\n  main:\n    permissions: host\n");
		await expect(loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false })).rejects.toThrow(
			"Invalid Riemann config",
		);

		await writeFile(
			join(agentDir, "config.yaml"),
			'version: 1\nagents:\n  main:\n    filesystem:\n      read: ["/"]\n      readExclude: ["~/.ssh"]\n      write: ["."]\n      writeExclude: []\n  defaults:\n    filesystem:\n      write: inherit\n',
		);
		const config = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(config.mainAgent.filesystem).toEqual({
			read: ["/"],
			readExclude: ["~/.ssh"],
			write: ["."],
			writeExclude: [],
		});
		expect(config.agentDefaults.filesystem).toEqual({ write: "inherit" });
	});

	test("rejects removed limits and profile lifecycle settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-legacy-agent-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			"version: 1\nlimits:\n  maxAgentsPerRun: 8\nagents:\n  profiles:\n    legacy:\n      maxDepth: 3\n      parkOnComplete: true\n",
		);

		await expect(loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false })).rejects.toThrow(
			"Invalid Riemann config",
		);
	});
});
