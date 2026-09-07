import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FULL_FILESYSTEM, fileAccessPolicy } from "../src/riemann/access-policy.ts";
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

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function findProcessWithExactArgument(argument: string): number | undefined {
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
			if (args.includes(argument)) return Number.parseInt(entry, 10);
		} catch {
			// Process exited or is not inspectable.
		}
	}
	return undefined;
}

async function shellDefinition(
	workspace: string,
	root: string,
	read: string[],
	write: string[],
	readExclude: string[] = [],
	writeExclude: string[] = [],
) {
	const store = new RiemannStore(join(root, "agent"));
	const run = store.openRun("shell-test", workspace);
	const shell = new ShellFunctions(
		fileAccessPolicy(workspace, { read, readExclude, write, writeExclude }),
		new ArtifactStore(store, run.id),
		100_000,
		false,
	);
	const definition = shell.definitions().find((item) => item.name === "run");
	if (!definition) throw new Error("shell.run is unavailable");
	return { definition, store };
}

describe("Riemann shell argument validation", () => {
	test("rejects invalid script, timeout, env, and cwd arguments before spawning", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-args-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const outside = join(root, "outside");
		await Promise.all([mkdir(workspace), mkdir(outside)]);
		const { definition, store } = await shellDefinition(workspace, root, [workspace], []);
		const signal = new AbortController().signal;
		try {
			await expect(definition.handler({}, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(definition.handler({ script: "" }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(definition.handler({ script: "true", timeout: 0 }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(definition.handler({ script: "true", timeout: 1.5 }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(definition.handler({ script: "true", env: { VALUE: null } }, signal)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(definition.handler({ script: "true", cwd: outside }, signal)).rejects.toMatchObject({
				code: "permission_denied",
			});
		} finally {
			store.close();
		}
	});

	test("rejects cancellation before resolving cwd or launching side effects", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-cancel-"));
		roots.push(root);
		const { definition, store } = await shellDefinition(root, root, [root], [root]);
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(
				definition.handler({ script: "touch marker", cwd: "missing" }, controller.signal),
			).rejects.toMatchObject({ code: "cancelled" });
			expect(existsSync(join(root, "marker"))).toBe(false);
		} finally {
			store.close();
		}
	});

	test("publishes the exact tool contract", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-contract-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const { definition, store } = await shellDefinition(workspace, root, [workspace], []);
		try {
			expect(definition).toMatchObject({
				pythonReturnType: "ProcessResult",
				idempotency: "non-idempotent",
				visibility: "public",
				inputSchema: { type: "object", additionalProperties: false },
				outputSchema: { type: "object", additionalProperties: false },
			});
			expect(definition).not.toHaveProperty("parameters");
			expect(definition).not.toHaveProperty("returns");
			expect(definition.prompt.example).not.toMatch(/npm test|tail/);
			expect(definition.prompt.example).toContain("output.show");
			expect(definition.outputSchema).toMatchObject({
				properties: {
					$riemann: {},
					exit_code: {},
					stdout: {},
					stderr: {},
					duration_ms: {},
					termination: {},
					stdout_truncated: {},
					stderr_truncated: {},
					stdout_capture_truncated: {},
					stderr_capture_truncated: {},
					stdout_artifact: {},
					stderr_artifact: {},
				},
			});
		} finally {
			store.close();
		}
	});
});

describe.skipIf(!systemSandboxAvailable)("Riemann shell system sandbox", () => {
	test("persists separate pure stream artifacts without markers", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-artifact-parts-"));
		roots.push(root);
		const store = new RiemannStore(join(root, "agent"));
		const run = store.openRun("shell-artifact-parts", root);
		const artifacts = new ArtifactStore(store, run.id);
		const shell = new ShellFunctions(fileAccessPolicy(root, FULL_FILESYSTEM), artifacts, 4, false);
		const definition = shell.definitions().find((item) => item.name === "run");
		if (!definition) throw new Error("shell.run is unavailable");
		const putText = vi.spyOn(artifacts, "putText");
		const script = "printf '完整😀stdout'; printf 'stderr😀完整' >&2";
		try {
			const result = record(await definition.handler({ script }, new AbortController().signal));
			expect(result).toMatchObject({ exit_code: 0, stdout_truncated: true, stderr_truncated: true });
			expect(result).toMatchObject({
				stdout: "完",
				stderr: "stde",
				stdout_capture_truncated: false,
				stderr_capture_truncated: false,
			});
			const stdoutArtifact = record(result.stdout_artifact);
			const stderrArtifact = record(result.stderr_artifact);
			expect(await artifacts.readBuffer(String(stdoutArtifact.handle))).toEqual(Buffer.from("完整😀stdout"));
			expect(await artifacts.readBuffer(String(stderrArtifact.handle))).toEqual(Buffer.from("stderr😀完整"));
			expect(stdoutArtifact.handle).toMatch(/^r[0-9a-z]+$/);
			expect(stderrArtifact.handle).toMatch(/^r[0-9a-z]+$/);
			expect(stdoutArtifact.mime_type).toBe("text/plain; charset=utf-8");
			expect(stderrArtifact.mime_type).toBe("text/plain; charset=utf-8");
			const stdoutBytes = await artifacts.readBuffer(String(stdoutArtifact.handle));
			expect(stdoutBytes.subarray(Buffer.byteLength(String(result.stdout))).toString("utf8")).toBe("整😀stdout");
			const binary = record(
				await definition.handler(
					{ script: `${process.execPath} -e "process.stdout.write(Buffer.from([255,97,98,99,100]))"` },
					new AbortController().signal,
				),
			);
			expect(binary).toMatchObject({ stdout: "�a", stdout_truncated: true, stdout_capture_truncated: false });
			const binaryArtifact = record(binary.stdout_artifact);
			expect(binaryArtifact.mime_type).toBe("application/octet-stream");
			expect(await artifacts.readBuffer(String(binaryArtifact.handle))).toEqual(Buffer.from([255, 97, 98, 99, 100]));
			expect(putText).not.toHaveBeenCalled();
		} finally {
			putText.mockRestore();
			store.close();
		}
	});

	test("reports capture loss independently of inline omission at the capture cap", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-capture-"));
		roots.push(root);
		const store = new RiemannStore(join(root, "agent"));
		const run = store.openRun("capture", root);
		const artifacts = new ArtifactStore(store, run.id);
		const cap = 16 * 1024 * 1024;
		const definition = new ShellFunctions(
			fileAccessPolicy(root, FULL_FILESYSTEM),
			artifacts,
			cap + 100,
			false,
		).definitions()[0];
		try {
			const result = record(
				await definition.handler(
					{
						script: `${process.execPath} -e "process.stdout.write('x'.repeat(${cap + 1})); process.stderr.write('err')"`,
					},
					new AbortController().signal,
				),
			);
			expect(result).toMatchObject({
				stdout_truncated: false,
				stdout_capture_truncated: true,
				stderr: "err",
				stderr_truncated: false,
				stderr_capture_truncated: false,
				stderr_artifact: null,
				termination: "exited",
				exit_code: 0,
			});
			expect(String(result.stdout)).toHaveLength(cap);
			expect(
				(await artifacts.readBuffer(String(record(result.stdout_artifact).handle))).equals(Buffer.alloc(cap, "x")),
			).toBe(true);
		} finally {
			store.close();
		}
	}, 30_000);

	test("returns a structured command-not-found process result", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-missing-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const store = new RiemannStore(join(root, "agent"));
		try {
			const run = store.openRun("shell-missing", workspace);
			const shell = new ShellFunctions(
				fileAccessPolicy(workspace, FULL_FILESYSTEM),
				new ArtifactStore(store, run.id),
				100_000,
				false,
			);
			const definition = shell.definitions().find((item) => item.name === "run");
			if (!definition) throw new Error("shell.run is unavailable");
			const result = record(
				await definition.handler(
					{ script: "riemann-command-that-does-not-exist", timeout: 10 },
					new AbortController().signal,
				),
			);
			expect(result).toEqual({
				$riemann: "process_result",
				exit_code: 127,
				stdout: "",
				stderr: expect.stringContaining("command not found"),
				duration_ms: expect.any(Number),
				termination: "exited",
				stdout_truncated: false,
				stderr_truncated: false,
				stdout_capture_truncated: false,
				stderr_capture_truncated: false,
				stdout_artifact: null,
				stderr_artifact: null,
			});
			expect(String(result.stderr)).toContain("command not found");
		} finally {
			store.close();
		}
	});

	test("enforces read-only workspace, host filesystem, and environment boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-sandbox-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const outside = join(root, "secret.txt");
		await mkdir(workspace);
		await writeFile(join(workspace, "inside.txt"), "inside");
		await writeFile(outside, "secret");
		const { definition, store } = await shellDefinition(workspace, root, [workspace], []);
		try {
			process.env.RIEMANN_HOST_SECRET_TEST = "hidden";
			const script = `${process.execPath} - <<'PROBE'
const fs=require("node:fs");const out={inside:fs.readFileSync("inside.txt","utf8"),hostSecret:process.env.RIEMANN_HOST_SECRET_TEST??null,explicit:process.env.EXPLICIT_VALUE??null};try{fs.writeFileSync("write.txt","bad");out.write="allowed"}catch(e){out.write=e.code}try{fs.readFileSync(${JSON.stringify(outside)},"utf8");out.outside="allowed"}catch(e){out.outside=e.code}console.log(JSON.stringify(out))
PROBE`;
			const result = record(
				await definition.handler(
					{ script, env: { EXPLICIT_VALUE: "visible" }, timeout: 10 },
					new AbortController().signal,
				),
			);
			expect(result.exit_code).toBe(0);
			const output = JSON.parse(String(result.stdout).trim()) as Record<string, string | null>;
			expect(output).toMatchObject({
				inside: "inside",
				hostSecret: null,
				explicit: "visible",
			});
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
		const { definition, store } = await shellDefinition(workspace, root, ["/"], ["/"]);
		try {
			const result = record(
				await definition.handler(
					{ script: "path-probe", env: { PATH: bin }, timeout: 10 },
					new AbortController().signal,
				),
			);
			expect(result).toMatchObject({ exit_code: 0, stdout: "path-ok\n" });
		} finally {
			store.close();
		}
	});
	test("preserves the requested cwd and environment without precreating fake directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-launch-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const { definition, store } = await shellDefinition(workspace, root, ["/"], ["/"]);
		try {
			const script = `${process.execPath} - <<'PROBE'
console.log(JSON.stringify({ cwdMatches: process.cwd().endsWith(${JSON.stringify(workspace)}), value: process.env.RIEMANN_TEST_VALUE, home: process.env.HOME ?? null, tmp: process.env.TMPDIR ?? null }));
PROBE`;
			const result = record(
				await definition.handler(
					{ script, env: { RIEMANN_TEST_VALUE: "visible" }, timeout: 10 },
					new AbortController().signal,
				),
			);
			expect(result.exit_code).toBe(0);
			expect(JSON.parse(String(result.stdout).trim())).toEqual({
				cwdMatches: true,
				value: "visible",
				home: process.env.HOME ?? null,
				tmp: process.env.TMPDIR ?? null,
			});
		} finally {
			store.close();
		}
	});

	test.skipIf(process.platform !== "linux")(
		"keeps runtime IPC writable through an excluded temp ancestor",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-shell-runtime-carve-"));
			roots.push(root);
			const workspace = process.cwd();
			const { definition, store } = await shellDefinition(workspace, root, ["/"], ["/"], [tmpdir()]);
			try {
				const result = record(
					await definition.handler({ script: "pwd", timeout: 10 }, new AbortController().signal),
				);
				expect(result).toMatchObject({
					exit_code: 0,
					stdout: `${workspace}\n`,
				});
			} finally {
				store.close();
			}
		},
		30_000,
	);

	test("applies user-configured read exclusions without blocking normal commands", async () => {
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
			const shell = new ShellFunctions(
				fileAccessPolicy(root, {
					read: ["/"],
					readExclude: [agentDir],
					write: ["/"],
					writeExclude: [],
				}),
				new ArtifactStore(store, run.id),
				100_000,
				false,
			);
			const definition = shell.definitions().find((item) => item.name === "run");
			if (!definition) throw new Error("shell.run is unavailable");
			const script = `${process.execPath} - <<'PROBE'
const fs=require("node:fs");const out={visible:fs.readFileSync("visible.txt","utf8")};try{fs.readFileSync(${JSON.stringify(join(agentDir, "auth.json"))},"utf8");out.state="allowed"}catch(error){out.state=error.code}console.log(JSON.stringify(out))
PROBE`;
			const result = record(await definition.handler({ script, timeout: 10 }, new AbortController().signal));
			expect(result.exit_code).toBe(0);
			const output = JSON.parse(String(result.stdout).trim()) as Record<string, string>;
			expect(output.visible).toBe("visible");
			expect(output.state).not.toBe("allowed");
		} finally {
			store.close();
		}
	}, 30_000);

	test("terminates timed-out and aborted scripts", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-terminate-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const { definition, store } = await shellDefinition(workspace, root, ["/"], ["/"]);
		try {
			const timeoutResult = record(
				await definition.handler({ script: "sleep 30", timeout: 1 }, new AbortController().signal),
			);
			expect(timeoutResult).toMatchObject({
				termination: "timeout",
				exit_code: null,
			});

			const controller = new AbortController();
			setTimeout(() => controller.abort(), 300);
			const abortedResult = record(await definition.handler({ script: "sleep 30", timeout: 30 }, controller.signal));
			expect(abortedResult).toMatchObject({
				termination: "cancelled",
				exit_code: null,
			});
		} finally {
			store.close();
		}
	}, 30_000);

	test.skipIf(process.platform !== "linux")(
		"kills signal-resistant detached descendants through the Bubblewrap PID namespace",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-shell-descendant-"));
			roots.push(root);
			const workspace = join(root, "workspace");
			const daemonFile = join(workspace, "daemon.cjs");
			const daemonLog = join(workspace, "daemon.log");
			await mkdir(workspace);
			await writeFile(
				daemonFile,
				`process.on("SIGHUP", () => {});
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
			);
			const { definition, store } = await shellDefinition(workspace, root, ["/"], ["/"]);
			let daemonPid: number | undefined;
			try {
				const execution = definition.handler(
					{
						script: `/run/current-system/sw/bin/setsid ${JSON.stringify(process.execPath)} ${JSON.stringify(daemonFile)} >${JSON.stringify(daemonLog)} 2>&1 & sleep 30`,
						timeout: 1,
					},
					new AbortController().signal,
				);
				for (let attempt = 0; attempt < 40 && daemonPid === undefined; attempt++) {
					daemonPid = findProcessWithExactArgument(daemonFile);
					if (daemonPid === undefined) await delay(25);
				}
				expect(daemonPid).toBeDefined();

				const result = record(await execution);
				expect(result).toMatchObject({
					termination: "timeout",
					exit_code: null,
				});
				for (let attempt = 0; attempt < 40 && processExists(daemonPid!); attempt++) await delay(25);
				expect(processExists(daemonPid!)).toBe(false);
			} finally {
				if (daemonPid && processExists(daemonPid)) process.kill(daemonPid, "SIGKILL");
				store.close();
			}
		},
		30_000,
	);

	test("allows an unrestricted policy to access paths outside its workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-host-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const outsideDirectory = join(root, "outside");
		const outside = join(outsideDirectory, "secret.txt");
		await Promise.all([mkdir(workspace), mkdir(outsideDirectory)]);
		await writeFile(outside, "secret");
		const { definition, store } = await shellDefinition(workspace, root, ["/"], ["/"]);
		try {
			const script = `${process.execPath} - <<'PROBE'
const fs=require("node:fs");fs.writeFileSync("created.txt","created");console.log(fs.readFileSync("secret.txt","utf8"))
PROBE`;
			const result = record(
				await definition.handler({ script, cwd: outsideDirectory, timeout: 10 }, new AbortController().signal),
			);
			expect(result.exit_code).toBe(0);
			expect(String(result.stdout).trim()).toBe("secret");
			expect(await readFile(join(outsideDirectory, "created.txt"), "utf8")).toBe("created");
		} finally {
			store.close();
		}
	}, 30_000);

	test("marks stream updates when the update window drops bytes", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-stream-limit-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const { definition, store } = await shellDefinition(workspace, root, ["/"], ["/"]);
		try {
			const updates: Array<Record<string, JsonValue>> = [];
			const script = `${process.execPath} -e "process.stdout.write('x'.repeat(70000))"`;
			const result = record(
				await definition.handler({ script, timeout: 10 }, new AbortController().signal, (update) => {
					updates.push(record(update));
				}),
			);
			expect(result).toMatchObject({
				stdout_truncated: false,
				termination: "exited",
			});
			expect(String(result.stdout)).toHaveLength(70_000);
			expect(updates.some((update) => update.kind === "stdout" && update.truncated === true)).toBe(true);
		} finally {
			store.close();
		}
	}, 30_000);

	test("streams split UTF-8 sequences across timed updates and flushes incomplete EOF input", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-shell-stream-unicode-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const { definition, store } = await shellDefinition(workspace, root, ["/"], ["/"]);
		try {
			const updates: Array<Record<string, JsonValue>> = [];
			const script = `${process.execPath} - <<'PROBE'
const first=Buffer.from([0xf0,0x9f]);process.stdout.write(first);process.stderr.write(first);setTimeout(()=>process.stdout.write(Buffer.from([0x98,0x80])),150)
PROBE`;
			const result = record(
				await definition.handler({ script, timeout: 10 }, new AbortController().signal, (update) => {
					updates.push(record(update));
				}),
			);
			expect(result).toMatchObject({
				exit_code: 0,
				stdout: "😀",
				stderr: "�",
				termination: "exited",
			});
			expect(updates.map((update) => update.sequence)).toEqual(updates.map((_, index) => index));
			expect(updates.every((update) => typeof update.truncated === "boolean")).toBe(true);
			expect(definition.updateSchema).toBeDefined();
			expect(updates.every((update) => Value.Check(definition.updateSchema!, update))).toBe(true);
			expect(
				updates
					.filter((update) => update.kind === "stdout")
					.map((update) => update.value)
					.join(""),
			).toBe("😀");
			expect(
				updates
					.filter((update) => update.kind === "stderr")
					.map((update) => update.value)
					.join(""),
			).toBe("�");
		} finally {
			store.close();
		}
	}, 30_000);
});
