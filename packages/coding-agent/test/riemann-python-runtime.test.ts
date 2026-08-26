import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureManagedPython, resetManagedPythonCacheForTests } from "../src/riemann/python/runtime.ts";

const roots: string[] = [];
const originalAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
const originalPath = process.env.PATH;
const originalCxx = process.env.CXX;
const originalLdLibraryPath = process.env.LD_LIBRARY_PATH;

afterEach(async () => {
	resetManagedPythonCacheForTests();
	if (originalAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
	else process.env.RIEMANN_CODING_AGENT_DIR = originalAgentDir;
	process.env.PATH = originalPath;
	if (originalCxx === undefined) delete process.env.CXX;
	else process.env.CXX = originalCxx;
	if (originalLdLibraryPath === undefined) delete process.env.LD_LIBRARY_PATH;
	else process.env.LD_LIBRARY_PATH = originalLdLibraryPath;
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
		expect(first.python).toBe(join(agentDir, "runtime", "python", "bin", "python"));
		const firstLog = await readFile(log, "utf8");
		expect(firstLog.match(/^venv /gm)).toHaveLength(1);
		expect(firstLog.match(/^pip install /gm)).toHaveLength(1);
		const marker = JSON.parse(
			await readFile(join(agentDir, "runtime", "python", "riemann-runtime.json"), "utf8"),
		) as { requirementsSha256: string };
		expect(Object.keys(marker)).toEqual(["requirementsSha256"]);
		expect(marker.requirementsSha256).toMatch(/^[a-f0-9]{64}$/);

		resetManagedPythonCacheForTests();
		expect((await ensureManagedPython()).python).toBe(first.python);
		expect(await readFile(log, "utf8")).toBe(firstLog);
	});

	test.skipIf(process.platform !== "linux")(
		"supplies the compiler C++ runtime when Python cannot load it",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-python-libstdcxx-"));
			roots.push(root);
			const bin = join(root, "bin");
			const agentDir = join(root, "agent");
			const libraryDir = join(root, "gcc-lib");
			const existingLibraryDir = join(root, "existing-lib");
			const library = join(libraryDir, "libstdc++.so.6");
			const uv = join(bin, "uv");
			const cxx = join(bin, "c++");
			await Promise.all([mkdir(bin), mkdir(libraryDir), mkdir(existingLibraryDir)]);
			await writeFile(library, "");
			const pythonScript = `#!/bin/sh
case ":$LD_LIBRARY_PATH:" in
  *:${libraryDir}:*) exit 0 ;;
  *) exit 1 ;;
esac
`;
			await writeFile(
				uv,
				`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "venv") {
  const target = process.argv[3];
  fs.mkdirSync(path.join(target, "bin"), { recursive: true });
  fs.writeFileSync(path.join(target, "bin", "python"), ${JSON.stringify(pythonScript)}, { mode: 0o755 });
}
`,
			);
			await writeFile(cxx, `#!/bin/sh\nprintf "%s\\n" ${JSON.stringify(library)}\n`);
			await Promise.all([chmod(uv, 0o755), chmod(cxx, 0o755)]);
			process.env.RIEMANN_CODING_AGENT_DIR = agentDir;
			process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
			process.env.CXX = cxx;
			process.env.LD_LIBRARY_PATH = existingLibraryDir;

			const runtime = await ensureManagedPython();

			expect(runtime.python).toBe(join(agentDir, "runtime", "python", "bin", "python"));
			expect(runtime.environment).toEqual({
				LD_LIBRARY_PATH: `${libraryDir}${delimiter}${existingLibraryDir}`,
			});
		},
	);
});
