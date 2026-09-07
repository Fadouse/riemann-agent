import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { IPythonKernelManager } from "../src/riemann/kernel/manager.ts";
import type { KernelExecuteResult } from "../src/riemann/kernel/types.ts";

const python = process.env.RIEMANN_TEST_PYTHON ?? "python3";
const successfulExecution: KernelExecuteResult = {
	status: "ok",
	stdout: '__RIEMANN_SNAPSHOT__{"restored": [], "skipped": []}',
	stderr: "",
	displays: [],
	modelContent: [],
	durationMs: 0,
};

async function checkpointCode(path: string, operation: "snapshot" | "restore"): Promise<string> {
	const kernel = new IPythonKernelManager({
		python,
		cwd: tmpdir(),
		sessionId: "checkpoint-resources",
		bootstrapCode: "",
		sandbox: false,
		snapshotPath: path,
		hostRequest: async () => null,
	});
	const internals = kernel as unknown as {
		kernelReady: boolean;
		process: { exitCode: null };
		restoreSnapshot(): Promise<void>;
	};
	internals.kernelReady = true;
	internals.process = { exitCode: null };
	const execution = vi.spyOn(kernel, "execute").mockResolvedValue(successfulExecution);
	if (operation === "snapshot") await kernel.snapshot();
	else await internals.restoreSnapshot();
	const code = execution.mock.calls[0]?.[0];
	execution.mockRestore();
	if (!code) throw new Error("Checkpoint operation did not execute Python");
	return code;
}

async function runPython(source: string, root: string): Promise<void> {
	const script = join(root, "regression.py");
	await writeFile(script, source);
	expect(execFileSync(python, ["-B", script], { encoding: "utf8" })).toContain("passed");
}

const picklePrelude = `import gc, pickle, sys, types, weakref
# Exercise generated checkpoint code without provisioning Python dependencies.
sys.modules["dill"] = types.SimpleNamespace(dump=pickle.dump, dumps=pickle.dumps, load=pickle.load)
class Payload:
    pass
`;

describe("checkpoint resources", () => {
	test("snapshot releases temporary references while preserving aliases and in-place changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-checkpoint-resources-"));
		try {
			const path = join(root, "snapshot.dill");
			const code = await checkpointCode(path, "snapshot");
			await runPython(
				`${picklePrelude}
namespace = {"payload": Payload(), "items": [1]}
namespace["alias"] = namespace["items"]
reference = weakref.ref(namespace["payload"])
code = ${JSON.stringify(code)}
exec(code, namespace)
namespace["items"].append(2)
# A background task may mutate the namespace without executing another user cell.
import threading
thread = threading.Thread(target=lambda: namespace["items"].append(3))
thread.start()
thread.join()
exec(code, namespace)
with open(${JSON.stringify(path)}, "rb") as file:
    assert file.readline().startswith(b"RIEMANN-CHECKPOINT ")
    saved = pickle.load(file)
assert saved["items"] == [1, 2, 3]
assert saved["items"] is saved["alias"]
del saved
# Neither a completed checkpoint nor a deleted user binding may retain payload.
del namespace["payload"]
gc.collect()
assert reference() is None, "checkpoint temporaries retain a deleted user object"
print("passed")
`,
				root,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("restore releases its temporary object graph after deleting a restored binding", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-restore-resources-"));
		try {
			const path = join(root, "snapshot.dill");
			const code = await checkpointCode(path, "restore");
			const write = await checkpointCode(path, "snapshot");
			await runPython(
				`${picklePrelude}
exec(${JSON.stringify(write)}, {"payload": Payload()})
namespace = {}
exec(${JSON.stringify(code)}, namespace)
reference = weakref.ref(namespace["payload"])
del namespace["payload"]
gc.collect()
assert reference() is None, "restore temporaries retain a deleted user object"
print("passed")
`,
				root,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects incompatible checkpoints before loading user objects", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-checkpoint-contract-"));
		try {
			const path = join(root, "snapshot.dill");
			const restore = await checkpointCode(path, "restore");
			const kernel = new IPythonKernelManager({
				python,
				cwd: root,
				sessionId: "incompatible-warning",
				bootstrapCode: "",
				sandbox: false,
				snapshotPath: path,
				hostRequest: async () => null,
			});
			(kernel as unknown as { incompatibleSnapshot: boolean }).incompatibleSnapshot = true;
			const first = await kernel.snapshot();
			expect(first).toMatchObject({ incompatible: true, error: expect.stringContaining("Incompatible checkpoint") });
			expect(await kernel.snapshot()).toEqual({ restored: [], skipped: [], incompatible: true });
			await runPython(
				`${picklePrelude}
import io, contextlib, pathlib
path = pathlib.Path(${JSON.stringify(path)})
original = pickle.dumps({"answer": 42})
path.write_bytes(original)
loads = []
sys.modules["dill"].load = lambda file: loads.append(True) or {"answer": 42}
output = io.StringIO()
namespace = {}
with contextlib.redirect_stdout(output):
    exec(${JSON.stringify(restore)}, namespace)
assert loads == [], "incompatible checkpoint executed dill.load"
assert "incompatible" in output.getvalue().lower(), output.getvalue()
assert "answer" not in namespace
assert path.read_bytes() == original, "incompatible checkpoint was overwritten"
print("passed")
`,
				root,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("valid primitive wire values do not construct diagnostic paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-wire-resources-"));
		try {
			const preludePath = join(import.meta.dirname, "..", "src", "riemann", "python", "prelude.py");
			await runPython(
				`import runpy
namespace = runpy.run_path(${JSON.stringify(preludePath)})
convert = namespace["_to_wire"]
original_path = namespace["_wire_path"]
paths = []
def tracked_path(path, key):
    paths.append((path, key))
    return original_path(path, key)
convert.__globals__["_wire_path"] = tracked_path
values = list(range(10000))
assert convert(values) == values
assert convert(values) is not values
assert paths == [], "valid primitive values constructed diagnostic paths"
assert convert({"nested": [(1, None, True, "text")]}) == {"nested": [[1, None, True, "text"]]}
for value, expected in [({"nested": [float("nan")]}, "$['nested'][0]"), ({"nested": [1 << 53]}, "$['nested'][0]"), ({"nested": [object()]}, "$['nested'][0]")]:
    try:
        convert(value)
    except TypeError as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError("invalid wire value accepted")
cycle = []
cycle.append(cycle)
try:
    convert(cycle)
except TypeError as error:
    assert "$[0]" in str(error)
else:
    raise AssertionError("cyclic wire value accepted")
print("passed")
`,
				root,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
