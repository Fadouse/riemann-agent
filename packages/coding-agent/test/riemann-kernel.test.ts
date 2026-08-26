import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, describe, expect, test } from "vitest";
import { FULL_FILESYSTEM, fileAccessPolicy } from "../src/riemann/access-policy.ts";
import { IPythonKernelManager } from "../src/riemann/kernel/manager.ts";
import type { JsonValue, JupyterMessage, KernelSandboxConfiguration } from "../src/riemann/kernel/types.ts";
import { encodeJupyterMessage } from "../src/riemann/kernel/wire.ts";
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

const TEST_AGENT_TIMESTAMP = "2026-08-14T00:00:00.000Z";

function testAgentWire(agent: (typeof TEST_AGENTS)[number], status = "idle"): Record<string, JsonValue> {
	const turnId = `${agent.id}-turn`;
	return {
		$riemann: "agent_info",
		id: agent.id,
		name: agent.name,
		turn_id: turnId,
		status,
		parent_id: "main-agent",
		task: `Task for ${agent.name}`,
		profile: null,
		model: "faux/test-model",
		workspace: "/tmp/riemann-agent-test",
		network: "deny",
		active_turn_id: status === "queued" || status === "running" ? turnId : null,
		last_turn_id: turnId,
		last_outcome: status === "stopped" ? "cancelled" : "ok",
		output_preview: status === "idle" ? `Completed ${agent.name}` : null,
		created_at: TEST_AGENT_TIMESTAMP,
		updated_at: TEST_AGENT_TIMESTAMP,
	};
}

function testAgentResultWire(
	agent: (typeof TEST_AGENTS)[number],
	turnId: string,
	outcome: "ok" | "cancelled" = "ok",
): Record<string, JsonValue> {
	return {
		$riemann: "agent_result",
		id: agent.id,
		name: agent.name,
		turn_id: turnId,
		status: outcome === "cancelled" ? "stopped" : "idle",
		outcome,
		output: outcome === "ok" ? `Completed ${agent.name}` : "",
		error: null,
		transcript_handle: `artifact://${agent.id}-transcript`,
		patch_handle: null,
		started_at: TEST_AGENT_TIMESTAMP,
		completed_at: TEST_AGENT_TIMESTAMP,
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
	const { python, environment } = await ensureManagedPython();
	const prelude = await readFile(join(import.meta.dirname, "..", "src", "riemann", "python", "prelude.py"), "utf8");
	const noArguments = {
		type: "object",
		properties: {},
		required: [],
		additionalProperties: false,
	};
	const specifications = JSON.stringify([
		{
			name: "echo",
			namespace: "testing",
			qualified_name: "testing.echo",
			description: "Return the supplied value through the host bridge.",
			input_schema: {
				type: "object",
				properties: { value: { description: "Value to return" } },
				required: ["value"],
				additionalProperties: false,
			},
			return_type: "object",
		},
		{
			name: "optional_echo",
			namespace: "testing",
			qualified_name: "testing.optional_echo",
			description: "Report whether an optional value was supplied.",
			input_schema: {
				type: "object",
				properties: { value: { description: "Optional value" } },
				required: [],
				additionalProperties: false,
			},
			return_type: "dict",
		},
		{
			name: "block",
			namespace: "testing",
			qualified_name: "testing.block",
			description: "Wait until the host request is cancelled.",
			input_schema: noArguments,
			return_type: "None",
		},
		{
			name: "invalid_agent",
			namespace: "testing",
			qualified_name: "testing.invalid_agent",
			description: "Return an incompatible AgentInfo payload.",
			input_schema: noArguments,
			return_type: "AgentInfo",
		},
		{
			name: "list",
			namespace: "agents",
			qualified_name: "agents.list",
			description: "Return reusable AgentInfo payloads.",
			input_schema: noArguments,
			return_type: "list[AgentInfo]",
		},
	]);
	return new IPythonKernelManager({
		python,
		env: { ...environment, RIEMANN_TEST_VALUE: "visible" },
		cwd: root,
		sessionId: "kernel-test",
		bootstrapCode: `${prelude}\n\n_install_functions(_json.loads(${JSON.stringify(specifications)}))`,
		sandbox,
		snapshotPath,
		onProcess,
		hostRequest: async (request, signal, onUpdate) => {
			if (request.operation === "testing.echo") onUpdate?.({ echoed: request.arguments.value ?? null });
			if (request.operation === "testing.echo") return request.arguments.value ?? null;
			if (request.operation === "testing.optional_echo") {
				return { has_value: Object.hasOwn(request.arguments, "value"), value: request.arguments.value ?? null };
			}
			if (request.operation === "testing.block" && onBlock) return onBlock(signal);
			if (request.operation === "testing.invalid_agent") {
				return { ...testAgentWire(TEST_AGENTS[0]), unexpected_field: "future schema field" };
			}
			if (request.operation === "agents.list") {
				return TEST_AGENTS.map((agent) => testAgentWire(agent));
			}
			if (request.operation === "agents.info") {
				const agent = TEST_AGENTS.find((candidate) => candidate.id === request.arguments.agent_id);
				if (!agent) throw new Error(`Unknown test agent: ${request.arguments.agent_id}`);
				return testAgentWire(agent);
			}
			if (request.operation === "agents.wait") {
				const agent = TEST_AGENTS.find((candidate) => candidate.id === request.arguments.agent_id);
				if (!agent || typeof request.arguments.turn_id !== "string")
					throw new Error(`Unknown test Agent Turn: ${request.arguments.agent_id}/${request.arguments.turn_id}`);
				return testAgentResultWire(agent, request.arguments.turn_id);
			}
			if (request.operation === "agents.steer") {
				const agent = TEST_AGENTS.find((candidate) => candidate.id === request.arguments.agent_id);
				if (!agent) throw new Error(`Unknown test agent: ${request.arguments.agent_id}`);
				return {
					$riemann: "agent_turn_handle",
					id: agent.id,
					name: agent.name,
					turn_id: request.arguments.turn_id as string,
					status: "running",
				};
			}
			if (request.operation === "agents.stop") {
				const agent = TEST_AGENTS.find((candidate) => candidate.id === request.arguments.agent_id);
				if (!agent || typeof request.arguments.turn_id !== "string")
					throw new Error(`Unknown test Agent Turn: ${request.arguments.agent_id}/${request.arguments.turn_id}`);
				return testAgentResultWire(agent, request.arguments.turn_id, "cancelled");
			}
			if (request.operation === "agents.release") return null;
			throw new Error(`Unexpected request: ${request.operation}`);
		},
	});
}

describe("Riemann IPython kernel", () => {
	test("rejects values that cannot cross strict Jupyter JSON frames", () => {
		const encode = (value: unknown) =>
			encodeJupyterMessage({
				type: "test_request",
				content: { value } as Record<string, JsonValue>,
				session: "strict-json",
				username: "strict-json",
				key: "secret",
			});
		expect(() => encode(Number.NaN)).toThrowError(/non-finite float.*content\["value"\]/);
		expect(() => encode(Number.POSITIVE_INFINITY)).toThrowError(/non-finite float/);
		expect(() => encode(Number.MAX_SAFE_INTEGER + 1)).toThrowError(/unsafe integer/);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => encode(cyclic)).toThrowError(/cyclic JSON value.*content\["value"\]\["self"\]/);
		const symbolKey = { [Symbol("invalid")]: true };
		expect(() => encode(symbolKey)).toThrowError(/non-string dict key/);
	});

	test("stops rewriting stream buffers after preserving capped output", () => {
		const kernel = new IPythonKernelManager({
			python: "python",
			cwd: process.cwd(),
			sessionId: "output-cap-test",
			bootstrapCode: "",
			sandbox: false,
			maxOutputChars: 5,
			hostRequest: () => Promise.resolve(null),
		});
		const execution = {
			id: "output-cap-execution",
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
		};
		let stdout = "";
		let stderr = "";
		let stdoutWrites = 0;
		let stderrWrites = 0;
		Object.defineProperty(execution, "stdout", {
			get: () => stdout,
			set: (value: string) => {
				stdout = value;
				stdoutWrites += 1;
			},
		});
		Object.defineProperty(execution, "stderr", {
			get: () => stderr,
			set: (value: string) => {
				stderr = value;
				stderrWrites += 1;
			},
		});
		const internals = kernel as unknown as {
			execution?: typeof execution;
			handleMessage(channel: "shell" | "control" | "iopub", message: JupyterMessage): void;
		};
		const streamMessage = (name: "stdout" | "stderr", text: string): JupyterMessage => ({
			identities: [],
			header: {
				msg_id: `stream-${name}-${text}`,
				username: "output-cap-test",
				session: "output-cap-test",
				date: "2026-08-19T00:00:00.000Z",
				msg_type: "stream",
				version: "5.3",
			},
			parentHeader: { msg_id: execution.id },
			metadata: {},
			content: { name, text },
			buffers: [],
		});

		internals.execution = execution;
		internals.handleMessage("iopub", streamMessage("stdout", "abc"));
		internals.handleMessage("iopub", streamMessage("stdout", "def"));
		internals.handleMessage("iopub", streamMessage("stdout", "ignored after cap"));
		internals.handleMessage("iopub", streamMessage("stderr", "123456"));
		internals.handleMessage("iopub", streamMessage("stderr", "ignored after cap"));
		internals.execution = undefined;

		const suffix = "\n[output truncated by Riemann Agent]";
		expect(stdout).toBe(`abcde${suffix}`);
		expect(stderr).toBe(`12345${suffix}`);
		expect(stdoutWrites).toBe(2);
		expect(stderrWrites).toBe(1);
	});

	test.skipIf(process.platform === "win32")(
		"closes a sandbox broker process group",
		async () => {
			const child = spawn(
				process.execPath,
				[
					"-e",
					`const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(descendant.pid);
setInterval(() => {}, 1000);`,
				],
				{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
			);
			const descendantPid = await new Promise<number>((resolve, reject) => {
				child.once("error", reject);
				child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8").trim())));
			});
			const kernel = new IPythonKernelManager({
				python: "python",
				cwd: process.cwd(),
				sessionId: "sandbox-close-test",
				bootstrapCode: "",
				sandbox: {
					policy: fileAccessPolicy(process.cwd(), FULL_FILESYSTEM),
				},
				hostRequest: () => Promise.resolve(null),
			});
			(kernel as unknown as { process?: ChildProcess }).process = child;
			try {
				await kernel.close();
				await stage(
					"sandbox process group cleanup",
					new Promise<void>((resolve) => {
						const check = () => {
							try {
								process.kill(descendantPid, 0);
								setTimeout(check, 10);
							} catch {
								resolve();
							}
						};
						check();
					}),
				);
			} finally {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					// The process group is already gone.
				}
				await kernel.close();
			}
		},
		10_000,
	);

	test("serializes checkpoints once, diagnoses failures, and retries failed checkpoints", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-checkpoint-fast-path-"));
		roots.push(root);
		const snapshotPath = join(root, "snapshot.dill");
		const dumpCallsPath = join(root, "dump-calls.txt");
		const retryCallsPath = join(root, "retry-calls.txt");
		await Promise.all([writeFile(dumpCallsPath, ""), writeFile(retryCallsPath, "")]);
		const kernel = await stage("create checkpoint fast-path kernel", createKernel(root, snapshotPath));
		try {
			const tracking = await stage(
				"install checkpoint serialization tracker",
				kernel.execute(`import dill as _test_dill
_test_original_dump = _test_dill.dump
_test_original_dumps = _test_dill.dumps
_test_dump_calls_path = ${JSON.stringify(dumpCallsPath)}
def _test_record_dump():
    with open(_test_dump_calls_path, "a", encoding="utf-8") as _test_file:
        _test_file.write("dump\\n")
def _test_counting_dump(value, file, *args, **kwargs):
    _test_record_dump()
    return _test_original_dump(value, file, *args, **kwargs)
def _test_counting_dumps(value, *args, **kwargs):
    _test_record_dump()
    return _test_original_dumps(value, *args, **kwargs)
_test_dill.dump = _test_counting_dump
_test_dill.dumps = _test_counting_dumps
answer = 41`),
			);
			expect(tracking.status).toBe("ok");

			const first = await stage("serialize whole checkpoint", kernel.snapshot());
			expect(first.error).toBeUndefined();
			expect(first.restored).toContain("answer");
			expect(await readFile(dumpCallsPath, "utf8")).toBe("dump\n");

			const repeated = await stage("repeat checkpoint", kernel.snapshot());
			expect(repeated).toEqual(first);
			expect(await readFile(dumpCallsPath, "utf8")).toBe("dump\n".repeat(2));

			await writeFile(dumpCallsPath, "");
			const generator = await stage(
				"add unserializable checkpoint value",
				kernel.execute("bad = (value for value in range(3))"),
			);
			expect(generator.status).toBe("ok");
			const diagnosed = await stage("diagnose checkpoint serialization failure", kernel.snapshot());
			expect(diagnosed.error).toBeUndefined();
			expect(diagnosed.restored).toContain("answer");
			expect(diagnosed.skipped).toEqual([
				expect.objectContaining({ name: "bad", reason: expect.stringContaining("generator") }),
			]);
			const diagnosedDumpCalls = await readFile(dumpCallsPath, "utf8");
			expect(diagnosedDumpCalls).toBe("dump\n".repeat(diagnosed.restored.length + diagnosed.skipped.length + 2));

			const diagnosedRepeat = await stage("repeat diagnosed checkpoint", kernel.snapshot());
			expect(diagnosedRepeat).toEqual(diagnosed);
			expect(await readFile(dumpCallsPath, "utf8")).toBe(diagnosedDumpCalls.repeat(2));

			const flaky = await stage(
				"install transient checkpoint failure",
				kernel.execute(`del bad
_test_retry_calls_path = ${JSON.stringify(retryCallsPath)}
def _test_retry_dump(value, file, *args, **kwargs):
    with open(_test_retry_calls_path, "a", encoding="utf-8") as _test_file:
        _test_file.write("retry\\n")
    return _test_original_dump(value, file, *args, **kwargs)
_test_flaky_dictionary_calls = 0
def _test_flaky_dump(value, file, *args, **kwargs):
    global _test_flaky_dictionary_calls
    if isinstance(value, dict) and "answer" in value:
        _test_flaky_dictionary_calls += 1
        if _test_flaky_dictionary_calls <= 2:
            if _test_flaky_dictionary_calls == 2:
                _test_dill.dump = _test_retry_dump
            raise RuntimeError(f"forced checkpoint failure {_test_flaky_dictionary_calls}")
    return _test_original_dump(value, file, *args, **kwargs)
_test_dill.dump = _test_flaky_dump`),
			);
			expect(flaky.status).toBe("ok");
			const failed = await stage("fail transient checkpoint", kernel.snapshot());
			expect(failed.error).toContain("forced checkpoint failure 2");
			expect(await readFile(retryCallsPath, "utf8")).toBe("");

			const retried = await stage("retry dirty checkpoint", kernel.snapshot());
			expect(retried.error).toBeUndefined();
			expect(retried.restored).toContain("answer");
			expect(await readFile(retryCallsPath, "utf8")).toBe("retry\n");

			const retriedRepeat = await stage("repeat retried checkpoint", kernel.snapshot());
			expect(retriedRepeat).toEqual(retried);
			expect(await readFile(retryCallsPath, "utf8")).toBe("retry\n".repeat(2));
		} finally {
			await stage("close checkpoint fast-path kernel", kernel.close());
		}
	}, 45_000);

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
	test("installs strict bridge signatures and rejects values outside strict JSON", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-bridge-"));
		roots.push(root);
		const kernel = await stage("create strict bridge kernel", createKernel(root, join(root, "snapshot.dill")));
		try {
			const signature = await stage(
				"inspect generated signatures",
				kernel.execute(`import inspect
(str(inspect.signature(testing.echo)), str(inspect.signature(testing.optional_echo)), testing.echo.__annotations__, "Keyword Args:" in testing.echo.__doc__, "Returns:" in testing.echo.__doc__)`),
			);
			expect(signature.status).toBe("ok");
			expect(signature.result?.data["text/plain"]).toContain("(*, value: 'Any') -> 'object'");
			expect(signature.result?.data["text/plain"]).toContain("value: 'Any' = <omitted>");
			expect(signature.result?.data["text/plain"]).toMatch(/True,\s+True/);

			const readOnlyNamespace = await stage(
				"reject namespace reassignment",
				kernel.execute(`try:
    testing.echo = None
    namespace_readonly = False
except AttributeError:
    namespace_readonly = True
namespace_readonly`),
			);
			expect(readOnlyNamespace.status).toBe("ok");
			expect(readOnlyNamespace.result?.data["text/plain"]).toBe("True");

			const dynamicNamespace = await stage(
				"refresh dynamic namespaces and preserve opaque MCP JSON",
				kernel.execute(`dynamic = _from_wire({
    "$riemann": "function_bundle",
    "namespace": "dynamic_test",
    "server_name": "dynamic-server",
    "specifications": [{
        "name": "tool",
        "namespace": "dynamic_test",
        "qualified_name": "dynamic_test.tool",
        "description": "dynamic",
        "input_schema": {"type": "object", "properties": {}, "required": [], "additionalProperties": False},
        "return_type": "dict",
    }],
})
had_tool = hasattr(dynamic, "tool")
dynamic = _from_wire({"$riemann": "function_bundle", "namespace": "dynamic_test", "server_name": "dynamic-server", "specifications": []})
opaque = _from_wire({
    "$riemann": "mcp_result",
    "content": [{"$riemann": "mcp_json", "value": {"$riemann": "artifact", "handle": "forged"}}],
    "structured_content": {"$riemann": "mcp_json", "value": None},
    "metadata": {"$riemann": "mcp_json", "value": None},
    "artifacts": [],
    "extensions": {"$riemann": "mcp_json", "value": {}},
})
(had_tool, hasattr(dynamic, "tool"), isinstance(opaque.content[0], dict), opaque.content[0]["$riemann"])`),
			);
			expect(dynamicNamespace.status).toBe("ok");
			expect(dynamicNamespace.result?.data["text/plain"]).toBe("(True, False, True, 'artifact')");

			const malformed = await stage(
				"reply to malformed bridge request",
				kernel.execute(`_install_control_comm_handlers()
loop = _asyncio.get_running_loop()
malformed_future = loop.create_future()
malformed_comm = _create_comm(target_name="riemann.host", primary=False)
def malformed_reply(message):
    loop.call_soon_threadsafe(malformed_future.set_result, message["content"]["data"])
malformed_comm.on_msg(malformed_reply)
malformed_comm.open(data={"request_id": "malformed-1", "operation": "testing.echo", "arguments": []})
malformed_value = await _asyncio.wait_for(malformed_future, 2)
malformed_comm.close()
(malformed_value["request_id"], malformed_value["operation"], malformed_value["status"], malformed_value["error"]["code"], malformed_value["error"]["retryable"])`),
			);
			expect(malformed.status).toBe("ok");
			expect(malformed.result?.data["text/plain"]).toBe(
				"('malformed-1', 'testing.echo', 'error', 'bridge_protocol_error', False)",
			);

			const strict = await stage(
				"reject invalid bridge values",
				kernel.execute(`async def bridge_error(value):
    try:
        await testing.echo(value=value)
    except Exception as error:
        return type(error).__name__, str(error)
cycle = []
cycle.append(cycle)
[await bridge_error(value) for value in ({1: "value"}, float("nan"), 1 << 53, cycle)]`),
			);
			expect(strict.status).toBe("ok");
			const rendered = String(strict.result?.data["text/plain"]);
			expect(rendered).toContain("dict keys must be strings");
			expect(rendered).toContain("non-finite float");
			expect(rendered).toContain("unsafe integer");
			expect(rendered).toContain("cyclic value");
			expect(rendered.match(/TypeError/g)).toHaveLength(4);

			const bounded = await stage(
				"bound domain reprs",
				kernel.execute(`values = [
    ProcessResult(0, "o" * 2000, "e" * 2000, 1, "exited", False, False),
    SearchHit("t" * 1000, "u" * 1000, "s" * 2000, None),
    Document("u" * 1000, "title", "d" * 3000, "text/plain", "untrusted"),
]
all(len(repr(value)) < 1000 and "…" in repr(value) for value in values)`),
			);
			expect(bounded.status).toBe("ok");
			expect(bounded.result?.data["text/plain"]).toBe("True");

			const richOutput = await stage(
				"bound rich display output",
				kernel.execute(`display({"text/plain": "x" * 1_000_000}, raw=True)`),
			);
			expect(richOutput.status).toBe("ok");
			expect(String(richOutput.displays[0]?.data["text/plain"])).toContain("rich output truncated");
			expect(String(richOutput.displays[0]?.data["text/plain"]).length).toBeLessThan(101_000);
		} finally {
			await stage("close strict bridge kernel", kernel.close());
		}
	}, 30_000);

	test("round-trips reusable Agent handles and settles decoding failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-agent-wire-"));
		roots.push(root);
		const kernel = await stage("create agent wire kernel", createKernel(root, join(root, "snapshot.dill")));
		try {
			const listed = await stage(
				"decode agent list",
				kernel.execute(
					`listed = await agents.list()
(len(listed), listed[0].id, listed[0].turn_id, listed[-1].id, all(hasattr(item, name) for item in listed for name in ("info", "wait", "steer", "stop", "release")), repr(listed[0]) == "AgentInfo(name='quick-env', status='idle', task='Task for quick-env', last_outcome='ok', output_preview='Completed quick-env')")`,
				),
			);
			expect(listed.status).toBe("ok");
			expect(listed.result?.data["text/plain"]).toBe("(3, 'agent-1', 'agent-1-turn', 'agent-3', True, True)");

			const info = await stage(
				"refresh Agent info",
				kernel.execute(
					`info = await listed[0].info()
(info.id, info.turn_id, info.task, info.model, info.active_turn_id, info.last_turn_id, info.output_preview) == ("agent-1", "agent-1-turn", "Task for quick-env", "faux/test-model", None, "agent-1-turn", "Completed quick-env")`,
				),
			);
			expect(info.status).toBe("ok");
			expect(info.result?.data["text/plain"]).toBe("True");

			const waited = await stage(
				"wait for exact Agent Turn",
				kernel.execute(
					`waited = await listed[0].wait(timeout=2)
(waited.id, waited.turn_id, waited.status, waited.outcome, waited.output, waited.transcript_handle, repr(waited)) == ("agent-1", "agent-1-turn", "idle", "ok", "Completed quick-env", "artifact://agent-1-transcript", "AgentResult(name='quick-env', outcome='ok', output='Completed quick-env')")`,
				),
			);
			expect(waited.status).toBe("ok");
			expect(waited.result?.data["text/plain"]).toBe("True");

			const sent = await stage(
				"send next Agent task",
				kernel.execute(
					`next_handle = await listed[0].steer(message="inspect the regression")
(next_handle.id, next_handle.name, next_handle.turn_id)`,
				),
			);
			expect(sent.status).toBe("ok");
			expect(sent.result?.data["text/plain"]).toBe("('agent-1', 'quick-env', 'agent-1-turn')");

			const stopped = await stage(
				"stop Agent handle",
				kernel.execute(
					`stopped = await listed[1].stop(timeout=2)
(stopped.id, stopped.turn_id, stopped.status, stopped.outcome)`,
				),
			);
			expect(stopped.status).toBe("ok");
			expect(stopped.result?.data["text/plain"]).toBe("('agent-2', 'agent-2-turn', 'stopped', 'cancelled')");

			const released = await stage(
				"release Agent handle",
				kernel.execute(
					`released = await listed[2].release()
released is None`,
				),
			);
			expect(released.status).toBe("ok");
			expect(released.result?.data["text/plain"]).toBe("True");

			const surface = await stage(
				"inspect reduced Agent namespace",
				kernel.execute(
					`(hasattr(agents, "wait"), hasattr(agents, "result"), hasattr(agents, "inbox"), hasattr(agents, "park"), hasattr(agents, "revive"))`,
				),
			);
			expect(surface.status).toBe("ok");
			expect(surface.result?.data["text/plain"]).toBe("(False, False, False, False, False)");

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
	test("distinguishes timeout from caller cancellation", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-kernel-timeout-status-"));
		roots.push(root);
		const kernel = await stage(
			"create timeout status kernel",
			createKernel(
				root,
				join(root, "snapshot.dill"),
				(signal) =>
					new Promise<JsonValue>((_resolve, reject) => {
						const abort = () => reject(signal.reason);
						if (signal.aborted) abort();
						else signal.addEventListener("abort", abort, { once: true });
					}),
			),
		);
		try {
			await stage("start timeout status kernel", kernel.start());
			const timedOut = await stage(
				"expire cell deadline",
				kernel.execute("await testing.block()", { signal: AbortSignal.timeout(50) }),
			);
			expect(timedOut.status).toBe("timeout");

			const controller = new AbortController();
			const cancelledExecution = kernel.execute("await testing.block()", { signal: controller.signal });
			await delay(50);
			controller.abort();
			const cancelled = await stage("cancel cell", cancelledExecution);
			expect(cancelled.status).toBe("cancelled");
		} finally {
			await stage("close timeout status kernel", kernel.close());
		}
	}, 30_000);

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
			expect(interrupted.status).toBe("cancelled");
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
			if (process.platform === "linux") {
				const unsandboxedProcess = kernelProcess;
				if (!unsandboxedProcess?.pid) throw new Error("Kernel process was not observed");
				const fields = (await readFile(`/proc/${unsandboxedProcess.pid}/stat`, "utf8")).split(" ");
				expect(Number(fields[4])).not.toBe(unsandboxedProcess.pid);
				expect(Number(fields[5])).not.toBe(unsandboxedProcess.pid);
			}
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
			expect(["cancelled", "error"]).toContain(interrupted.status);
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
		"enforces filesystem isolation in the native system sandbox",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-kernel-sandbox-"));
			roots.push(root);
			const workspace = join(root, "workspace");
			const state = join(root, "state");
			const outside = join(root, "secret.txt");
			await Promise.all([mkdir(workspace), mkdir(state), writeFile(outside, "secret")]);
			await writeFile(join(workspace, "read.txt"), "ok");
			const sandbox: KernelSandboxConfiguration = {
				policy: fileAccessPolicy(workspace, { read: [workspace], readExclude: [], write: [], writeExclude: [] }),
				...(process.platform === "linux"
					? { bubblewrapPath: process.env.RIEMANN_BWRAP_PATH ?? "/usr/bin/bwrap" }
					: {}),
			};
			let broker: ChildProcess | undefined;
			const kernel = await stage(
				"create sandboxed kernel",
				createKernel(
					workspace,
					join(state, "kernel.dill"),
					undefined,
					(process) => {
						if (process) broker = process;
					},
					sandbox,
				),
			);
			try {
				const code = `import json, os, pathlib
out = {
    "workspace_read": pathlib.Path("read.txt").read_text(),
    "cwd_matches": os.getcwd().endswith(${JSON.stringify(workspace)}),
    "environment": os.environ.get("RIEMANN_TEST_VALUE"),
    "home": os.environ.get("HOME"),
    "tmp": os.environ.get("TMPDIR"),
}
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
print(json.dumps(out, sort_keys=True))`;
				const result = await stage("execute sandbox probes", kernel.execute(code));
				if (process.platform === "linux") {
					const brokerProcess = broker;
					if (!brokerProcess?.pid) throw new Error("Sandbox broker process was not observed");
					const fields = (await readFile(`/proc/${brokerProcess.pid}/stat`, "utf8")).split(" ");
					expect({ processGroup: Number(fields[4]), session: Number(fields[5]) }).toEqual({
						processGroup: brokerProcess.pid,
						session: brokerProcess.pid,
					});
				}
				expect(result.status).toBe("ok");
				const probe = JSON.parse(result.stdout.trim()) as Record<string, string | boolean>;
				expect(probe).toMatchObject({
					workspace_read: "ok",
					cwd_matches: true,
					environment: "visible",
					home: process.env.HOME,
					tmp: process.env.TMPDIR,
				});
				expect(probe.workspace_write).not.toBe("allowed");
				expect(probe.outside_read).not.toBe("allowed");
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
				policy: fileAccessPolicy(root, {
					read: ["/"],
					readExclude: [agentDir],
					write: [root],
					writeExclude: [agentDir],
				}),
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
				policy: fileAccessPolicy(workspace, FULL_FILESYSTEM),
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
