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
const TEST_AGENTS = [
	{ id: "agent-1", name: "quick-env" },
	{ id: "agent-2", name: "quick-system" },
	{ id: "agent-3", name: "quick-git" },
] as const;

function testAgentWire(workspace: string, agent: (typeof TEST_AGENTS)[number]): Record<string, JsonValue> {
	return {
		$riemann: "agent_info",
		id: agent.id,
		name: agent.name,
		status: "completed",
		parent_id: "main-agent",
		depth: 1,
		model_role: "inherit",
		workspace,
		workspace_mode: "shared",
		permissions: "workspace",
	};
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
		{
			name: "invalid_agent",
			namespace: "testing",
			qualified_name: "testing.invalid_agent",
			description: "Return an incompatible AgentInfo payload.",
			parameters: [],
		},
		{
			name: "list",
			namespace: "agents",
			qualified_name: "agents.list",
			description: "Return complete AgentInfo payloads.",
			parameters: [],
		},
		{
			name: "wait",
			namespace: "agents",
			qualified_name: "agents.wait",
			description: "Return a nested AgentInfo result envelope.",
			parameters: [
				{ name: "agent_id", required: true },
				{ name: "timeout", required: false },
			],
		},
		{
			name: "result",
			namespace: "agents",
			qualified_name: "agents.result",
			description: "Return the current nested AgentInfo result envelope.",
			parameters: [{ name: "agent_id", required: true }],
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
			if (request.type === "testing.invalid_agent") {
				return { ...testAgentWire(root, TEST_AGENTS[0]), unexpected_field: "future schema field" };
			}
			if (request.type === "agents.list") {
				return TEST_AGENTS.map((agent) => testAgentWire(root, agent));
			}
			if (request.type === "agents.wait" || request.type === "agents.result") {
				const agentId = request.args.agent_id;
				const agent = TEST_AGENTS.find((candidate) => candidate.id === agentId);
				if (!agent) throw new Error(`Unknown test agent: ${agentId}`);
				return {
					agent: testAgentWire(root, agent),
					result: `${agent.name} done`,
					error: null,
				};
			}
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
	test("round-trips complete AgentInfo payloads and settles decoding failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-agent-wire-"));
		roots.push(root);
		const kernel = await stage("create agent wire kernel", createKernel(root, join(root, "snapshot.dill")));
		try {
			const listed = await stage(
				"decode agent list",
				kernel.execute(
					`listed = await agents.list()
[(item.id, item.name, item.status, item.workspace_mode, item.permissions) for item in listed]`,
				),
			);
			expect(listed.status).toBe("ok");
			expect(listed.result?.data["text/plain"]).toContain(
				"('agent-1', 'quick-env', 'completed', 'shared', 'workspace')",
			);
			expect(listed.result?.data["text/plain"]).toContain(
				"('agent-3', 'quick-git', 'completed', 'shared', 'workspace')",
			);

			const waited = await stage(
				"decode parallel agent waits",
				kernel.execute(
					`import asyncio
waits = await asyncio.gather(*(agents.wait(agent_id=item.id, timeout=1) for item in listed))
[(entry["agent"].name, entry["agent"].workspace_mode, entry["result"]) for entry in waits]`,
				),
			);
			expect(waited.status).toBe("ok");
			expect(waited.result?.data["text/plain"]).toContain("('quick-env', 'shared', 'quick-env done')");
			expect(waited.result?.data["text/plain"]).toContain("('quick-git', 'shared', 'quick-git done')");

			const result = await stage(
				"decode current agent result",
				kernel.execute(
					`outcome = await agents.result(agent_id="agent-2")
(outcome["agent"].id, outcome["agent"].permissions, outcome["result"], outcome["error"])`,
				),
			);
			expect(result.status).toBe("ok");
			expect(result.result?.data["text/plain"]).toBe("('agent-2', 'workspace', 'quick-system done', None)");

			const malformed = await stage(
				"settle incompatible agent payload",
				kernel.execute("await testing.invalid_agent()", { signal: AbortSignal.timeout(2_000) }),
			);
			expect(malformed.status).toBe("error");
			expect(malformed.error?.ename).toBe("TypeError");
			expect(malformed.error?.evalue).toContain("unexpected_field");

			const commCount = await stage(
				"inspect comm cleanup",
				kernel.execute("len(get_ipython().kernel.comm_manager.comms)"),
			);
			expect(commCount.status).toBe("ok");
			expect(commCount.result?.data["text/plain"]).toBe("0");

			const recovered = await stage(
				"execute after agent decode failure",
				kernel.execute("await testing.echo(value='still usable')"),
			);
			expect(recovered.status).toBe("ok");
			expect(recovered.result?.data["text/plain"]).toBe("'still usable'");
		} finally {
			await stage("close agent wire kernel", kernel.close());
		}
	}, 45_000);
	test("interrupts even when a host request ignores cancellation", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-noncooperative-"));
		roots.push(root);
		let releaseBlock: (() => void) | undefined;
		let resolveBlockStarted!: () => void;
		const blockStarted = new Promise<void>((resolve) => {
			resolveBlockStarted = resolve;
		});
		const blocked = new Promise<JsonValue>((resolve) => {
			releaseBlock = () => resolve(null);
		});
		const kernel = await stage(
			"create non-cooperative kernel",
			createKernel(root, join(root, "snapshot.dill"), async () => {
				resolveBlockStarted();
				return blocked;
			}),
		);
		try {
			const controller = new AbortController();
			const execution = kernel.execute("await testing.block()", { signal: controller.signal });
			await stage("non-cooperative host request start", blockStarted);
			controller.abort();
			const interrupted = await stage("interrupt non-cooperative host request", execution);
			expect(interrupted.status).toBe("aborted");
			const release = releaseBlock;
			if (!release) throw new Error("Host request release callback was not installed");
			release();
			releaseBlock = undefined;
			const next = await stage("execute after interrupted host request", kernel.execute("1 + 1"));
			expect(next.status).toBe("ok");
			expect(next.result?.data["text/plain"]).toBe("2");
		} finally {
			releaseBlock?.();
			await stage("close non-cooperative kernel", kernel.close());
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
	test("closes when a killed kernel descendant keeps inherited stdio open", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-inherited-stdio-"));
		roots.push(root);
		const snapshotPath = join(root, "snapshot.dill");
		let kernelProcess: ChildProcess | undefined;
		const kernel = await stage(
			"create inherited-stdio kernel",
			createKernel(root, snapshotPath, undefined, (process) => {
				if (process) kernelProcess = process;
			}),
		);
		try {
			const result = await stage(
				"spawn inherited-stdio descendant",
				kernel.execute(
					"import subprocess, sys\nsubprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], close_fds=False)\n'child started'",
				),
			);
			expect(result.status).toBe("ok");
			const processToKill = kernelProcess;
			if (!processToKill) throw new Error("Kernel process was not observed");
			processToKill.kill("SIGKILL");
			await stage("close kernel with inherited stdio", kernel.close());
		} finally {
			await kernel.close();
		}
	}, 30_000);

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
				filesystemScope: "workspace",
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

	test.skipIf(
		!(
			(process.platform === "linux" && existsSync(process.env.RIEMANN_BWRAP_PATH ?? "/usr/bin/bwrap")) ||
			(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
		),
	)(
		"masks nested Riemann state while staging durable snapshots outside the sandbox",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-kernel-nested-state-"));
			roots.push(root);
			const agentDir = join(root, "agent");
			const snapshotPath = join(agentDir, "state", "snapshots", "child", "kernel.dill");
			await mkdir(agentDir, { recursive: true });
			await Promise.all([
				writeFile(join(root, "visible.txt"), "visible"),
				writeFile(join(agentDir, "auth.json"), "RIEMANN_PRIVATE_CREDENTIAL"),
			]);
			const sandbox: KernelSandboxConfiguration = {
				agentDir,
				filesystemScope: "workspace",
				workspaceWritable: true,
				...(process.platform === "linux"
					? { bubblewrapPath: process.env.RIEMANN_BWRAP_PATH ?? "/usr/bin/bwrap" }
					: {}),
			};
			const first = await stage(
				"create nested-state kernel",
				createKernel(root, snapshotPath, undefined, undefined, sandbox),
			);
			try {
				const code = `import json, pathlib
state = pathlib.Path(${JSON.stringify(agentDir)})
out = {"visible": pathlib.Path("visible.txt").read_text()}
try:
    (state / "auth.json").read_text()
    out["state_read"] = "allowed"
except Exception as error:
    out["state_read"] = type(error).__name__
try:
    (state / "injected.txt").write_text("bad")
    out["state_write"] = "allowed"
except Exception as error:
    out["state_write"] = type(error).__name__
pathlib.Path("created.txt").write_text("created")
answer = 41
print(json.dumps(out, sort_keys=True))`;
				const result = await stage("probe nested state mask", first.execute(code));
				expect(result.status).toBe("ok");
				const probe = JSON.parse(result.stdout.trim()) as Record<string, string>;
				expect(probe.visible).toBe("visible");
				expect(probe.state_read).not.toBe("allowed");
				expect(probe.state_write).not.toBe("allowed");
				expect(await readFile(join(root, "created.txt"), "utf8")).toBe("created");
				await expect(readFile(join(agentDir, "injected.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

				const snapshot = await stage("persist staged nested snapshot", first.snapshot());
				expect(snapshot.error).toBeUndefined();
				expect(snapshot.restored).toContain("answer");
				expect((await readFile(snapshotPath)).byteLength).toBeGreaterThan(0);
			} finally {
				await stage("close nested-state kernel", first.close());
			}

			const second = await stage(
				"restore staged nested snapshot",
				createKernel(root, snapshotPath, undefined, undefined, sandbox),
			);
			try {
				const restored = await stage("read staged restored value", second.execute("answer"));
				expect(restored.status).toBe("ok");
				expect(restored.result?.data["text/plain"]).toBe("41");
			} finally {
				await stage("close restored nested-state kernel", second.close());
			}
		},
		90_000,
	);

	test.skipIf(
		!(
			(process.platform === "linux" && existsSync(process.env.RIEMANN_BWRAP_PATH ?? "/usr/bin/bwrap")) ||
			(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"))
		),
	)(
		"allows a main Agent with host scope to access paths outside its workspace",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-kernel-host-"));
			roots.push(root);
			const workspace = join(root, "workspace");
			const state = join(root, "state");
			const outside = join(root, "secret.txt");
			const created = join(root, "created.txt");
			await Promise.all([mkdir(workspace), mkdir(state), writeFile(outside, "secret")]);
			const sandbox: KernelSandboxConfiguration = {
				agentDir: join(root, "agent"),
				filesystemScope: "host",
				workspaceWritable: true,
				...(process.platform === "linux"
					? { bubblewrapPath: process.env.RIEMANN_BWRAP_PATH ?? "/usr/bin/bwrap" }
					: {}),
			};
			const kernel = await stage(
				"create host-scoped kernel",
				createKernel(workspace, join(state, "kernel.dill"), undefined, undefined, sandbox),
			);
			try {
				const code = `import json, pathlib
outside = pathlib.Path(${JSON.stringify(outside)})
created = pathlib.Path(${JSON.stringify(created)})
created.write_text("created")
print(json.dumps({"outside": outside.read_text(), "created": created.read_text()}))`;
				const result = await stage("execute host filesystem probes", kernel.execute(code));
				expect(result.status).toBe("ok");
				expect(JSON.parse(result.stdout.trim())).toEqual({ outside: "secret", created: "created" });
			} finally {
				await stage("close host-scoped kernel", kernel.close());
			}
		},
		60_000,
	);
});
