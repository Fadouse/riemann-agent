import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadRiemannConfig } from "../src/riemann/config.ts";

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
			"version: 1\nlimits:\n  maxAgentsPerRun: 7\ncompaction:\n  strategy: openai\n",
		);

		const untrusted = await loadRiemannConfig({ cwd: project, agentDir, projectTrusted: false });
		expect(untrusted.limits.maxAgentsPerRun).toBe(5);
		expect(untrusted.compaction.strategy).toBe("default");
		expect(untrusted.files).toEqual([join(agentDir, "config.yaml")]);

		const trusted = await loadRiemannConfig({ cwd: project, agentDir, projectTrusted: true });
		expect(trusted.limits.maxAgentsPerRun).toBe(7);
		expect(trusted.compaction.strategy).toBe("openai");
		expect(trusted.web.searchBackend).toBe("disabled");
		expect(trusted.files).toEqual([join(agentDir, "config.yaml"), join(project, ".riemann", "config.yaml")]);
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
});
