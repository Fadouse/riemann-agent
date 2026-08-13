import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureManagedPython, resetManagedPythonCacheForTests } from "../src/riemann/python/runtime.ts";

const roots: string[] = [];
const originalAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
const originalPath = process.env.PATH;

afterEach(async () => {
	resetManagedPythonCacheForTests();
	if (originalAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
	else process.env.RIEMANN_CODING_AGENT_DIR = originalAgentDir;
	process.env.PATH = originalPath;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("Riemann managed Python provisioning", () => {
	test("provisions once under a lock and reuses the hash-pinned runtime marker", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-python-provision-"));
		roots.push(root);
		const bin = join(root, "bin");
		const agentDir = join(root, "agent");
		const log = join(root, "uv.log");
		await mkdir(bin);
		const uv = join(bin, "uv");
		await writeFile(
			uv,
			String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\n");
if (process.argv[2] === "venv") {
  const target = process.argv[3];
  fs.mkdirSync(path.join(target, "bin"), { recursive: true });
  fs.writeFileSync(path.join(target, "bin", "python"), "fake python\n", { mode: 0o755 });
}
`,
		);
		await chmod(uv, 0o755);
		process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
		process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

		const [first, concurrent] = await Promise.all([ensureManagedPython(), ensureManagedPython()]);
		expect(concurrent).toBe(first);
		expect(first).toBe(join(agentDir, "runtime", "python-v1", "bin", "python"));
		const firstLog = await readFile(log, "utf8");
		expect(firstLog.match(/^venv /gm)).toHaveLength(1);
		expect(firstLog.match(/^pip install /gm)).toHaveLength(1);
		const marker = JSON.parse(
			await readFile(join(agentDir, "runtime", "python-v1", "riemann-runtime.json"), "utf8"),
		) as { layoutVersion: number; requirementsSha256: string };
		expect(marker.layoutVersion).toBe(1);
		expect(marker.requirementsSha256).toMatch(/^[a-f0-9]{64}$/);

		resetManagedPythonCacheForTests();
		expect(await ensureManagedPython()).toBe(first);
		expect(await readFile(log, "utf8")).toBe(firstLog);
	});
});
