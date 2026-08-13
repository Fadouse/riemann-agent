import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe.skipIf(!systemSandboxAvailable)("Riemann shell system sandbox", () => {
	test("enforces read-only workspace, host filesystem, network, and environment boundaries", async () => {
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
				workspaceWritable: false,
				networkAllowed: false,
			});
			const definition = shell.definitions().find((item) => item.name === "run");
			if (!definition) throw new Error("shell.run is unavailable");
			process.env.RIEMANN_HOST_SECRET_TEST = "hidden";
			const script = `(async()=>{const fs=require("node:fs"); const net=require("node:net"); const out={inside:fs.readFileSync("inside.txt","utf8"),hostSecret:process.env.RIEMANN_HOST_SECRET_TEST??null,explicit:process.env.EXPLICIT_VALUE??null}; try{fs.writeFileSync("write.txt","bad");out.write="allowed"}catch(e){out.write=e.code} try{fs.readFileSync(${JSON.stringify(outside)},"utf8");out.outside="allowed"}catch(e){out.outside=e.code} await new Promise(r=>{const s=net.createConnection({host:"1.1.1.1",port:53}); s.on("connect",()=>{out.network="allowed";s.destroy();r()});s.on("error",e=>{out.network=e.code;r()})}); console.log(JSON.stringify(out))})()`;
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
			expect(output.network).not.toBe("allowed");
			await expect(readFile(join(workspace, "write.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			delete process.env.RIEMANN_HOST_SECRET_TEST;
			store.close();
		}
	}, 30_000);
});
