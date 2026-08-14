import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ShellFunctions } from "../src/riemann/functions/shell.ts";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];
const systemSandboxAvailable =
	(process.platform === "linux" && existsSync(process.env.RIEMANN_BWRAP_PATH ?? "/usr/bin/bwrap")) ||
	(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"));

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(value: JsonValue): Record<string, JsonValue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected record");
	return value;
}

describe("Riemann shell command resolution", () => {
	test("returns a structured command-not-found process result", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-missing-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const store = new RiemannStore(join(root, "agent"));
		try {
			const run = store.openRun("shell-missing", workspace);
			const shell = new ShellFunctions(workspace, new ArtifactStore(store, run.id), 100_000, {
				agentDir: join(root, "agent"),
				filesystemScope: "workspace",
				workspaceWritable: false,
				networkAllowed: false,
			});
			const definition = shell.definitions().find((item) => item.name === "run");
			if (!definition) throw new Error("shell.run is unavailable");
			const result = record(
				await definition.handler(
					{ command: "riemann-command-that-does-not-exist", timeout: 10 },
					new AbortController().signal,
				),
			);
			expect(result).toMatchObject({
				command: "riemann-command-that-does-not-exist",
				exit_code: 127,
				stdout: "",
				stderr: "riemann-command-that-does-not-exist: command not found\n",
				timed_out: false,
				artifact: null,
			});
		} finally {
			store.close();
		}
	});
});

describe.skipIf(!systemSandboxAvailable)("Riemann shell system sandbox", () => {
	test("enforces read-only workspace, host filesystem, and environment boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-sandbox-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const outside = join(root, "secret.txt");
		await mkdir(workspace);
		await writeFile(join(workspace, "inside.txt"), "inside");
		await writeFile(outside, "secret");
		const store = new RiemannStore(join(root, "agent"));
		try {
			const run = store.openRun("shell-sandbox", workspace);
			const shell = new ShellFunctions(workspace, new ArtifactStore(store, run.id), 100_000, {
				agentDir: join(root, "agent"),
				filesystemScope: "workspace",
				workspaceWritable: false,
				networkAllowed: false,
			});
			const definition = shell.definitions().find((item) => item.name === "run");
			if (!definition) throw new Error("shell.run is unavailable");
			process.env.RIEMANN_HOST_SECRET_TEST = "hidden";
			const script = `const fs=require("node:fs");const out={inside:fs.readFileSync("inside.txt","utf8"),hostSecret:process.env.RIEMANN_HOST_SECRET_TEST??null,explicit:process.env.EXPLICIT_VALUE??null};try{fs.writeFileSync("write.txt","bad");out.write="allowed"}catch(e){out.write=e.code}try{fs.readFileSync(${JSON.stringify(outside)},"utf8");out.outside="allowed"}catch(e){out.outside=e.code}console.log(JSON.stringify(out))`;
			const result = record(
				await definition.handler(
					{ command: process.execPath, args: ["-e", script], env: { EXPLICIT_VALUE: "visible" }, timeout: 10 },
					new AbortController().signal,
				),
			);
			const output = JSON.parse(String(result.stdout).trim()) as Record<string, string | null>;
			expect(output).toMatchObject({ inside: "inside", hostSecret: null, explicit: "visible" });
			expect(output.write).not.toBe("allowed");
			expect(output.outside).not.toBe("allowed");
			await expect(readFile(join(workspace, "write.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			delete process.env.RIEMANN_HOST_SECRET_TEST;
			store.close();
		}
	}, 30_000);

	test("resolves commands from an explicit call-level PATH", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-path-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const bin = join(workspace, "tools");
		await mkdir(bin, { recursive: true });
		const executable = join(bin, "path-probe");
		await writeFile(executable, "#!/bin/sh\nprintf 'path-ok\\n'\n");
		await chmod(executable, 0o755);
		const store = new RiemannStore(join(root, "agent"));
		try {
			const run = store.openRun("shell-path", workspace);
			const shell = new ShellFunctions(workspace, new ArtifactStore(store, run.id), 100_000, {
				agentDir: join(root, "agent"),
				filesystemScope: "workspace",
				workspaceWritable: false,
				networkAllowed: false,
			});
			const definition = shell.definitions().find((item) => item.name === "run");
			if (!definition) throw new Error("shell.run is unavailable");
			const result = record(
				await definition.handler(
					{ command: "path-probe", env: { PATH: bin }, timeout: 10 },
					new AbortController().signal,
				),
			);
			expect(result).toMatchObject({ exit_code: 0, stdout: "path-ok\n" });
		} finally {
			store.close();
		}
	});
	test("masks nested Riemann state without blocking normal workspace commands", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-nested-state-"));
		roots.push(root);
		const agentDir = join(root, ".riemann", "agent");
		await mkdir(agentDir, { recursive: true });
		await Promise.all([
			writeFile(join(root, "visible.txt"), "visible"),
			writeFile(join(agentDir, "auth.json"), "RIEMANN_PRIVATE_CREDENTIAL"),
		]);
		const store = new RiemannStore(agentDir);
		try {
			const run = store.openRun("shell-nested-state", root);
			const shell = new ShellFunctions(root, new ArtifactStore(store, run.id), 100_000, {
				agentDir,
				filesystemScope: "workspace",
				workspaceWritable: false,
				networkAllowed: false,
			});
			const definition = shell.definitions().find((item) => item.name === "run");
			if (!definition) throw new Error("shell.run is unavailable");
			const script = `const fs=require("node:fs");const out={visible:fs.readFileSync("visible.txt","utf8")};try{fs.readFileSync(${JSON.stringify(join(agentDir, "auth.json"))},"utf8");out.state="allowed"}catch(error){out.state=error.code}console.log(JSON.stringify(out))`;
			const result = record(
				await definition.handler(
					{ command: process.execPath, args: ["-e", script], timeout: 10 },
					new AbortController().signal,
				),
			);
			const output = JSON.parse(String(result.stdout).trim()) as Record<string, string>;
			expect(output.visible).toBe("visible");
			expect(output.state).not.toBe("allowed");
			await expect(
				definition.handler(
					{ command: process.execPath, args: ["-e", ""], cwd: ".riemann/agent", timeout: 10 },
					new AbortController().signal,
				),
			).rejects.toMatchObject({ code: "permission_denied" });
		} finally {
			store.close();
		}
	}, 30_000);

	test("allows a main Agent with host scope to access paths outside its workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-host-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const outsideDirectory = join(root, "outside");
		const outside = join(outsideDirectory, "secret.txt");
		await Promise.all([mkdir(workspace), mkdir(outsideDirectory)]);
		await writeFile(outside, "secret");
		const store = new RiemannStore(join(root, "agent"));
		try {
			const run = store.openRun("shell-host", workspace);
			const shell = new ShellFunctions(workspace, new ArtifactStore(store, run.id), 100_000, {
				agentDir: join(root, "agent"),
				filesystemScope: "host",
				workspaceWritable: true,
				networkAllowed: false,
			});
			const definition = shell.definitions().find((item) => item.name === "run");
			if (!definition) throw new Error("shell.run is unavailable");
			const script = `const fs=require("node:fs");fs.writeFileSync("created.txt","created");console.log(fs.readFileSync("secret.txt","utf8"))`;
			const result = record(
				await definition.handler(
					{ command: process.execPath, args: ["-e", script], cwd: outsideDirectory, timeout: 10 },
					new AbortController().signal,
				),
			);
			expect(String(result.stdout).trim()).toBe("secret");
			expect(await readFile(join(outsideDirectory, "created.txt"), "utf8")).toBe("created");
		} finally {
			store.close();
		}
	}, 30_000);
});
