import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, test } from "vitest";
import { IPythonKernelManager } from "../src/riemann/kernel/manager.ts";
import type { JsonValue, KernelSandboxConfiguration } from "../src/riemann/kernel/types.ts";
import { ensureManagedPython } from "../src/riemann/python/runtime.ts";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function stage<T>(name: string, operation: Promise<T>): Promise<T> {
	return Promise.race([
		operation,
		delay(15_000).then(() => {
			throw new Error(`Stage timed out: ${name}`);
		}),
	]);
}

async function createKernel(
	root: string,
	snapshotPath: string,
	onBlock?: (signal: AbortSignal) => Promise<JsonValue>,
	onProcess?: (process: ChildProcess | undefined) => void,
	sandbox: KernelSandboxConfiguration | false = false,
): Promise<IPythonKernelManager> {
	process.env.RIEMANN_CODING_AGENT_DIR = join(root, "agent");
	const python = await ensureManagedPython();
	const prelude = await readFile(join(import.meta.dirname, "..", "src", "riemann", "python", "prelude.py"), "utf8");
	const specifications = JSON.stringify([
		{
			name: "echo",
			namespace: "testing",
			qualified_name: "testing.echo",
			description: "Return the supplied value through the host bridge.",
			parameters: [{ name: "value", required: true }],
		},
		{
			name: "optional_echo",
			namespace: "testing",
			qualified_name: "testing.optional_echo",
			description: "Report whether an optional value was supplied.",
			parameters: [{ name: "value", required: false }],
		},
		{
			name: "block",
			namespace: "testing",
			qualified_name: "testing.block",
			description: "Wait until the host request is cancelled.",
			parameters: [],
		},
	]);
	return new IPythonKernelManager({
		python,
		cwd: root,
		sessionId: "kernel-test",
		bootstrapCode: `${prelude}\n\n_install_functions(_json.loads(${JSON.stringify(specifications)}))`,
		sandbox,
		snapshotPath,
		onProcess,
		hostRequest: async (request, signal, onUpdate) => {
			if (request.type === "testing.echo") onUpdate?.({ echoed: request.args.value ?? null });
			if (request.type === "testing.echo") return request.args.value ?? null;
			if (request.type === "testing.optional_echo") {
				return { has_value: Object.hasOwn(request.args, "value"), value: request.args.value ?? null };
			}
			if (request.type === "testing.block" && onBlock) return onBlock(signal);
			throw new Error(`Unexpected request: ${request.type}`);
		},
	});
}

describe("Riemann IPython kernel", () => {
	test("reports ordered host request lifecycle and streaming updates", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-events-"));
		roots.push(root);
		const kernel = await stage("create event kernel", createKernel(root, join(root, "snapshot.dill")));
		const phases: string[] = [];
		try {
			const result = await stage(
				"execute observed request",
				kernel.execute("await testing.echo(value=7)", {
					onHostRequest: (event) => {
						const echoed =
							event.phase === "update" &&
							typeof event.update === "object" &&
							event.update !== null &&
							!Array.isArray(event.update)
								? event.update.echoed
								: "";
						phases.push(event.phase === "update" ? `${event.phase}:${echoed}` : event.phase);
					},
				}),
			);
			expect(result.status).toBe("ok");
			expect(phases).toEqual(["start", "update:7", "end"]);
		} finally {
			await stage("close event kernel", kernel.close());
		}
	}, 30_000);
	test("persists variables, restores after crashes, preserves optional nulls, and cancels host functions", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-test-"));
		roots.push(root);
		const snapshotPath = join(root, "snapshot.dill");
		let resolveBlockStarted!: () => void;
		const blockStarted = new Promise<void>((resolve) => {
			resolveBlockStarted = resolve;
		});
		let hostRequestAborted = false;
		let kernelProcess: ChildProcess | undefined;
		const first = await stage(
			"create first",
			createKernel(
				root,
				snapshotPath,
				(signal) =>
					new Promise<JsonValue>((_resolve, reject) => {
						resolveBlockStarted();
						const onAbort = () => {
							hostRequestAborted = true;
							reject(signal.reason);
						};
						if (signal.aborted) onAbort();
						else signal.addEventListener("abort", onAbort, { once: true });
					}),
				(process) => {
					if (process) kernelProcess = process;
				},
			),
		);
		try {
			const result = await stage(
				"execute first",
				first.execute("answer = await testing.echo(value=41)\nanswer + 1"),
			);
			expect(result.status).toBe("ok");
			expect(result.result?.data["text/plain"]).toBe("42");
			expect(result.stderr).toBe("");
			const explicitNull = await stage("explicit null", first.execute("await testing.optional_echo(value=None)"));
			expect(explicitNull.result?.data["text/plain"]).toContain("'has_value': True");
			const omitted = await stage("omitted optional", first.execute("await testing.optional_echo()"));
			expect(omitted.result?.data["text/plain"]).toContain("'has_value': False");

			const cellAbort = new AbortController();
			const blockedCell = first.execute("await testing.block()", { signal: cellAbort.signal });
			await stage("host request start", blockStarted);
			cellAbort.abort();
			const interrupted = await stage("interrupt host request", blockedCell);
			expect(["aborted", "error"]).toContain(interrupted.status);
			expect(hostRequestAborted).toBe(true);

			const snapshot = await stage("snapshot first", first.snapshot());
			expect(snapshot.error).toBeUndefined();
			expect(snapshot.restored).toContain("answer");

			const processToKill = kernelProcess;
			if (!processToKill) throw new Error("Kernel process was not observed");
			const exited = new Promise<void>((resolve) => processToKill.once("exit", () => resolve()));
			processToKill.kill("SIGKILL");
			await stage("kernel crash", exited);
			const recovered = await stage("kernel restart", first.execute("answer"));
			expect(recovered.status).toBe("ok");
			expect(recovered.result?.data["text/plain"]).toBe("41");
		} finally {
			await stage("close first", first.close());
		}

		const second = await stage("create second", createKernel(root, snapshotPath));
		try {
			const result = await stage("execute second", second.execute("answer"));
			expect(result.status).toBe("ok");
			expect(result.result?.data["text/plain"]).toBe("41");
			const echoed = await stage("echo second", second.execute("await testing.echo(value={'restored': answer})"));
			expect(echoed.result?.data["text/plain"]).toContain("'restored': 41");
		} finally {
			await stage("close second", second.close());
		}
	}, 60_000);
	test.skipIf(
		!(
			(process.platform === "linux" && existsSync(process.env.RIEMANN_BWRAP_PATH ?? "/usr/bin/bwrap")) ||
			(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
		),
	)(
		"enforces filesystem and network isolation in the native system sandbox",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-kernel-sandbox-"));
			roots.push(root);
			const workspace = join(root, "workspace");
			const state = join(root, "state");
			const outside = join(root, "secret.txt");
			await Promise.all([mkdir(workspace), mkdir(state), writeFile(outside, "secret")]);
			await writeFile(join(workspace, "read.txt"), "ok");
			const sandbox: KernelSandboxConfiguration = {
				agentDir: join(root, "agent"),
				workspaceWritable: false,
				...(process.platform === "linux"
					? { bubblewrapPath: process.env.RIEMANN_BWRAP_PATH ?? "/usr/bin/bwrap" }
					: {}),
			};
			const kernel = await stage(
				"create sandboxed kernel",
				createKernel(workspace, join(state, "kernel.dill"), undefined, undefined, sandbox),
			);
			try {
				const code = `import json, pathlib, socket
out = {"workspace_read": pathlib.Path("read.txt").read_text()}
try:
    pathlib.Path("write.txt").write_text("bad")
    out["workspace_write"] = "allowed"
except Exception as error:
    out["workspace_write"] = type(error).__name__
try:
    pathlib.Path(${JSON.stringify(outside)}).read_text()
    out["outside_read"] = "allowed"
except Exception as error:
    out["outside_read"] = type(error).__name__
try:
    socket.create_connection(("1.1.1.1", 53), timeout=0.2)
    out["network"] = "allowed"
except Exception as error:
    out["network"] = type(error).__name__
print(json.dumps(out, sort_keys=True))`;
				const result = await stage("execute sandbox probes", kernel.execute(code));
				expect(result.status).toBe("ok");
				const probe = JSON.parse(result.stdout.trim()) as Record<string, string>;
				expect(probe).toMatchObject({ workspace_read: "ok" });
				expect(probe.workspace_write).not.toBe("allowed");
				expect(probe.outside_read).not.toBe("allowed");
				expect(probe.network).not.toBe("allowed");
			} finally {
				await stage("close sandboxed kernel", kernel.close());
			}
		},
		60_000,
	);
});
