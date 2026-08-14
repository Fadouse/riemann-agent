import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadRiemannConfig, updateGlobalRiemannSetting } from "../src/riemann/config.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Riemann configuration", () => {
	test("merges trusted project values over global values and ignores untrusted project config", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		await mkdir(join(project, ".riemann"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			"version: 1\nlimits:\n  maxAgentsPerRun: 5\nweb:\n  searchBackend: disabled\n",
		);
		await writeFile(
			join(project, ".riemann", "config.yaml"),
			"version: 1\nlimits:\n  maxAgentsPerRun: 7\ncompaction:\n  strategy: openai\nagents:\n  main:\n    permissions: workspace\n  defaults:\n    workspace: worktree\n    permissions: workspace\n",
		);

		const untrusted = await loadRiemannConfig({ cwd: project, agentDir, projectTrusted: false });
		expect(untrusted.limits.maxAgentsPerRun).toBe(5);
		expect(untrusted.compaction.strategy).toBe("default");
		expect(untrusted.mainAgent.permissions).toBe("host");
		expect(untrusted.files).toEqual([join(agentDir, "config.yaml")]);

		const trusted = await loadRiemannConfig({ cwd: project, agentDir, projectTrusted: true });
		expect(trusted.limits.maxAgentsPerRun).toBe(7);
		expect(trusted.compaction.strategy).toBe("openai");
		expect(trusted.mainAgent.permissions).toBe("workspace");
		expect(trusted.agentDefaults).toEqual({ workspace: "worktree", permissions: "workspace" });
		expect(trusted.web.searchBackend).toBe("disabled");
		expect(trusted.files).toEqual([join(agentDir, "config.yaml"), join(project, ".riemann", "config.yaml")]);
		expect([...trusted.projectOverrides]).toEqual([
			"limits.maxAgentsPerRun",
			"compaction.strategy",
			"agents.main.permissions",
			"agents.defaults.workspace",
			"agents.defaults.permissions",
		]);
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

		await updateGlobalRiemannSetting(agentDir, "limits.maxDepth", 6);
		await updateGlobalRiemannSetting(agentDir, "mcp.servers.docs.enabled", false);
		await updateGlobalRiemannSetting(agentDir, "mcp.servers.docs.enabledTools", ["search", "fetch"]);

		const config = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(config.limits.maxDepth).toBe(6);
		expect(config.mcpServers.docs).toMatchObject({
			command: "docs-server",
			enabled: false,
			enabledTools: ["search", "fetch"],
		});

		await updateGlobalRiemannSetting(agentDir, "mcp.servers.docs.v2.enabled", false);
		const dotted = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(dotted.mcpServers["docs.v2"]?.enabled).toBe(false);
	});

	test("creates the global config when it does not exist", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-create-"));
		roots.push(root);
		const agentDir = join(root, "agent");

		await updateGlobalRiemannSetting(agentDir, "compaction.strategy", "snapshot");
		await updateGlobalRiemannSetting(agentDir, "agents.main.permissions", "workspace");
		await updateGlobalRiemannSetting(agentDir, "agents.defaults.workspace", "worktree");
		await updateGlobalRiemannSetting(agentDir, "agents.defaults.permissions", "host");

		const config = await loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false });
		expect(config.compaction.strategy).toBe("snapshot");
		expect(config.mainAgent.permissions).toBe("workspace");
		expect(config.agentDefaults).toEqual({ workspace: "worktree", permissions: "host" });
	});

	test("rejects legacy mixed workspace and permission modes", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-config-legacy-agent-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "config.yaml"),
			"version: 1\nagents:\n  profiles:\n    legacy:\n      workspace: isolated\n",
		);

		await expect(loadRiemannConfig({ cwd: root, agentDir, projectTrusted: false })).rejects.toThrow(
			"Invalid Riemann config",
		);
	});
});
