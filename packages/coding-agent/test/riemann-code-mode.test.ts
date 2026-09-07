import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createGrammarToolInputProperties } from "../../ai/src/api/constrained-sampling.ts";
import { convertResponsesTools } from "../../ai/src/api/openai-responses-shared.ts";
import { type PythonCell, PythonCells, parsePythonExec } from "../src/riemann/code-mode.ts";
import { PYTHON_CODE_MODE_BOOTSTRAP } from "../src/riemann/code-mode-python.ts";
import { IPYTHON_TOOL_METADATA, IPYTHON_WAIT_TOOL_METADATA } from "../src/riemann/ipython.ts";
import type { KernelExecuteResult } from "../src/riemann/kernel/types.ts";

const controllers: PythonCells[] = [];
afterEach(async () => {
	await Promise.all(controllers.splice(0).map((cells) => cells.close()));
});

function execution(stdout = ""): KernelExecuteResult {
	return { status: "ok", stdout, stderr: "", displays: [], modelContent: [], durationMs: 1 };
}

function pendingCell() {
	const cells = new PythonCells();
	controllers.push(cells);
	let finish!: (result: KernelExecuteResult) => void;
	let active!: PythonCell;
	let output = execution("first\n");
	const id = cells.start(parsePythonExec("pass"), async (cell) => {
		active = cell;
		cell.peek = () => output;
		return new Promise<KernelExecuteResult>((resolve) => {
			finish = resolve;
			cell.signal.addEventListener("abort", () => resolve({ ...output, status: "cancelled" }), { once: true });
		});
	});
	return {
		cells,
		id,
		get active() {
			return active;
		},
		finish: (value: KernelExecuteResult) => finish(value),
		setOutput: (value: KernelExecuteResult) => {
			output = value;
		},
	};
}

describe("Python code mode", () => {
	test("declares native raw source and a separate JSON wait tool, with JSON-only fallback", () => {
		const tools = [IPYTHON_TOOL_METADATA, IPYTHON_WAIT_TOOL_METADATA];
		expect(createGrammarToolInputProperties(tools, true).get("ipython")).toBe("code");
		expect(convertResponsesTools(tools, { supportsOpenAIGrammarTools: true })).toMatchObject([
			{ type: "custom", name: "ipython", format: { type: "grammar", syntax: "lark" } },
			{ type: "function", name: "ipython_wait" },
		]);
		expect(convertResponsesTools(tools, { supportsOpenAIGrammarTools: false })).toMatchObject([
			{ type: "function", parameters: { required: ["code"], properties: { code: { type: "string" } } } },
			{ type: "function", name: "ipython_wait" },
		]);
		expect(IPYTHON_TOOL_METADATA.parameters.properties).not.toHaveProperty("timeout");
	});

	test("parses only a first-line pragma and rejects unknown or out-of-range controls", () => {
		expect(parsePythonExec('# @exec: {"persist": true, "timeout_ms": 300000}\r\nprint(1)')).toMatchObject({
			persist: true,
			timeout_ms: 300000,
		});
		expect(parsePythonExec('print(1)\n# @exec: {"persist": true}').persist).toBe(false);
		for (const source of [
			"",
			"# @exec: []",
			'# @exec: {"yield_time_ms": -1}',
			'# @exec: {"max_output_tokens": 1}',
			'# @exec: {"persist": 1}',
			'# @exec: {"timeout": 10}',
		]) {
			expect(() => parsePythonExec(source)).toThrow();
		}
	});

	test("yield keeps the producer alive, reads only new output, and closes the final cell", async () => {
		const fixture = pendingCell();
		expect(fixture.id).toMatch(/^c[0-9a-f]{8}$/);
		expect(fixture.cells.pending).toEqual({ cell_id: fixture.id, status: "running", next_tool: "ipython_wait" });
		const consume = async (result: KernelExecuteResult, running: boolean) => ({ result, running });
		expect(await fixture.cells.poll(fixture.id, 0, false, undefined, consume)).toMatchObject({
			running: true,
			result: { stdout: "first\n" },
		});
		expect(fixture.active.signal.aborted).toBe(false);
		expect(() => fixture.cells.start(parsePythonExec("pass"), async () => execution())).toThrow("Collect cell");
		fixture.setOutput({ ...execution("first\nsecond\n"), modelContent: [{ type: "text", text: "selected" }] });
		expect(await fixture.cells.poll(fixture.id, 0, false, undefined, consume)).toMatchObject({
			running: true,
			result: { stdout: "second\n", modelContent: [{ text: "selected" }] },
		});
		fixture.finish({ ...execution("first\nsecond\nlast\n"), modelContent: [{ type: "text", text: "selected" }] });
		expect(await fixture.cells.poll(fixture.id, 100, false, undefined, consume)).toMatchObject({
			running: false,
			result: { stdout: "last\n", modelContent: [] },
		});
		expect(fixture.cells.active).toBe(false);
		expect(fixture.cells.pending).toBeNull();
		await expect(fixture.cells.poll(fixture.id, 0, false, undefined, consume)).rejects.toThrow("already collected");
	});

	test("does not drop output if completion arrives while a yielded response is formatting", async () => {
		const fixture = pendingCell();
		await fixture.cells.poll(fixture.id, 0, false, undefined, async () => {
			fixture.finish(execution("first\nlast\n"));
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		});
		expect(fixture.cells.active).toBe(true);
		const result = await fixture.cells.poll(fixture.id, 100, false, undefined, async (result) => result);
		expect(result.stdout).toBe("last\n");
	});

	test("does not consume output on formatting failure or allow concurrent waits", async () => {
		const fixture = pendingCell();
		await expect(
			fixture.cells.poll(fixture.id, 0, false, undefined, async () => {
				throw new Error("format failed");
			}),
		).rejects.toThrow("format failed");
		const waiting = fixture.cells.poll(fixture.id, 20, false, undefined, async (result) => result);
		await expect(fixture.cells.poll(fixture.id, 0, false, undefined, async () => null)).rejects.toThrow(
			"active wait",
		);
		expect((await waiting).stdout).toBe("first\n");
	});

	test("an aborted wait does not kill the cell; explicit termination does", async () => {
		const fixture = pendingCell();
		await fixture.cells.poll(fixture.id, 0, false, undefined, async () => null);
		const abort = new AbortController();
		abort.abort(new Error("stop waiting"));
		await expect(fixture.cells.poll(fixture.id, 100, false, abort.signal, async () => null)).rejects.toThrow(
			"stop waiting",
		);
		expect(fixture.active.signal.aborted).toBe(false);
		const ended = await fixture.cells.poll(fixture.id, 100, true, undefined, async (result, running) => ({
			result,
			running,
		}));
		expect(ended).toMatchObject({ running: false, result: { status: "cancelled" } });
		expect(fixture.active.signal.aborted).toBe(true);
	});

	test("hard deadlines and shutdown abort owned work and reject future starts", async () => {
		const cells = new PythonCells();
		controllers.push(cells);
		const id = cells.start(
			{ ...parsePythonExec("pass"), timeout_ms: 5 },
			async (cell) =>
				new Promise((_resolve, reject) => {
					cell.signal.addEventListener("abort", () => reject(cell.signal.reason), { once: true });
				}),
		);
		expect(await cells.poll(id, 100, false, undefined, async (result) => result.status)).toBe("timeout");
		const fixture = pendingCell();
		await fixture.cells.poll(fixture.id, 0, false, undefined, async () => null);
		await fixture.cells.close();
		expect(fixture.active.signal.aborted).toBe(true);
		expect(() => fixture.cells.start(parsePythonExec("pass"), async () => execution())).toThrow("closed");
	});

	test("fresh namespaces, explicit JSON state, optional persistence, output, and task cleanup", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-code-mode-python-"));
		try {
			const script = join(root, "check.py");
			await writeFile(
				script,
				`import asyncio as _asyncio, inspect as _inspect, json as _json, sys, types, contextlib, io
sys.modules["IPython.display"] = types.SimpleNamespace(display=lambda *args, **kwargs: None)
_RIEMANN_PROTECTED = set()
${PYTHON_CODE_MODE_BOOTSTRAP}
async def check():
    await _riemann_exec_source("temporary = 42")
    await _riemann_exec_source("assert 'temporary' not in globals()")
    await _riemann_exec_source("store('value', {'items': [1]})")
    await _riemann_exec_source("copy = load('value'); copy['items'].append(2); assert load('value') == {'items': [1]}")
    await _riemann_exec_source("durable = 42", True)
    await _riemann_exec_source("assert durable == 42", True)
    await _riemann_exec_source("def current(): return durable", True)
    await _riemann_exec_source("durable = 43; assert current() == 43", True)
    await _riemann_exec_source("del durable", True)
    await _riemann_exec_source("assert 'durable' not in globals()", True)
    await _riemann_exec_source("assert 'durable' not in globals()")
    await _riemann_exec_source("import asyncio; asyncio.create_task(asyncio.sleep(100))")
    assert len(_asyncio.all_tasks()) == 1
    capture = io.StringIO()
    with contextlib.redirect_stdout(capture):
        await _riemann_exec_source("42")
        assert capture.getvalue() == ""
        await _riemann_exec_source("print('selected')")
    assert capture.getvalue() == "selected\\n"
    try:
        store("bad", object())
    except TypeError:
        pass
    else:
        raise AssertionError("store accepted non-JSON state")
_asyncio.run(check())
print("passed")
`,
			);
			expect(
				execFileSync(process.env.RIEMANN_TEST_PYTHON ?? "python3", ["-B", script], { encoding: "utf8" }),
			).toContain("passed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
