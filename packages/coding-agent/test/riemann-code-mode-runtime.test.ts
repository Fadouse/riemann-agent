import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentToolExecutionError } from "@earendil-works/pi-agent-core";
import { expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { IPythonKernelManager } from "../src/riemann/kernel/manager.ts";
import { MODEL_TEXT_BYTES } from "../src/riemann/output.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";

test("real Python cell yields explicit output, completes once, isolates locals and cancels nested shell work", async () => {
	const root = await mkdtemp(join(tmpdir(), "riemann-code-mode-runtime-"));
	const previous = process.env.RIEMANN_CODING_AGENT_DIR;
	process.env.RIEMANN_CODING_AGENT_DIR = join(root, "agent");
	let runtime: RiemannRuntime | undefined;
	const context = {
		cwd: root,
		thinkingLevel: "off",
		sessionManager: { getSessionId: () => "code-mode-runtime" },
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
	try {
		runtime = await RiemannRuntime.createRoot(context);
		const execute = (code: string) =>
			runtime!
				.toolDefinition()
				.execute("exec", { code }, undefined, undefined, context)
				.catch((error: unknown) => {
					if (error instanceof AgentToolExecutionError)
						throw new Error(JSON.stringify(error.result.content), { cause: error });
					throw error;
				});
		const wait = (id: string, terminate = false, yield_time_ms?: number) =>
			runtime!.waitToolDefinition().execute("wait", { id, terminate, yield_time_ms }, undefined, undefined, context);
		const warmup = await execute(
			'assert "output" not in globals() and "store" not in globals() and "load" not in globals()\npersist.answer = 42',
		);
		expect(warmup.details.status).toBe("ok");
		const empty = await execute("pass");
		expect(empty.details.resultRef).not.toBe(warmup.details.resultRef);
		const errorRefs: string[] = [];
		for (let i = 0; i < 2; i++) {
			try {
				await runtime
					.toolDefinition()
					.execute("missing", { code: 'await fs.read(path="missing-file")' }, undefined, undefined, context);
				throw new Error("Expected missing-file error");
			} catch (error) {
				if (!(error instanceof AgentToolExecutionError)) throw error;
				const text = error.result.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("");
				const refs = [...text.matchAll(/\[ref=(r[0-9a-z]+)/g)].map((match) => match[1]);
				expect(refs).toHaveLength(2);
				errorRefs.push(...refs);
				await execute(
					`saved = await refs["${refs[0]}"].read()\nassert saved["error"]["code"] == "not_found"\nouter = await refs["${refs[1]}"].read()\nassert outer["status"] == "error"`,
				);
			}
		}
		expect(new Set(errorRefs).size).toBe(4);
		await execute(
			[
				"import builtins, contextlib, io",
				"assert print is not builtins.print",
				"captured = io.StringIO()",
				"with contextlib.redirect_stdout(captured):",
				"    print('a', 'b', sep='|', end='!')",
				"assert captured.getvalue() == 'a|b!'",
				"with open('printed.txt', 'w') as file:",
				"    assert print('file-output', file=file, flush=True) is None",
			].join("\n"),
		);
		expect(await readFile(join(root, "printed.txt"), "utf8")).toBe("file-output\n");
		const compact = await execute(
			[
				'result = await shell.run(script="printf payload; printf problem >&2; exit 7")',
				"assert result.exit_code == 7",
				'assert await result.stdout.read() == "payload"',
				'assert await result.stderr.read() == "problem"',
				'assert not hasattr(result, "stdout_truncated")',
				"print(result)",
				'persist.large = "中😀" * 10000',
			].join("\n"),
		);
		const compactText = compact.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("");
		expect(compactText).toContain("exit_code=7");
		expect(compactText).toContain("payload");
		expect(compactText).toContain("problem");
		const resultRef = compactText.match(/\[ref=(r[0-9a-z]+)\]/)![1];
		const scalarRef = [...compactText.matchAll(/\[ref=(r[0-9a-z]+)\]/g)][2][1];
		await execute(`assert await refs["${scalarRef}"].read() == "problem"`);
		await execute(
			`result = await refs["${resultRef}"].read()\nassert result.exit_code == 7\nassert await result.stdout.read() == "payload"\nassert len(persist.large) == 20000\nawait refs["${resultRef}"].materialize(path="result.json")\nawait result.stdout.materialize(path="stdout.txt")`,
		);
		expect(JSON.parse(await readFile(join(root, "result.json"), "utf8"))).toMatchObject({ exit_code: 7 });
		expect(await readFile(join(root, "stdout.txt"), "utf8")).toBe("payload");
		const range = await execute(
			'result = await shell.run(script="printf range-output")\nprint(await result.stdout.read(span=[6, 12]))',
		);
		expect(JSON.stringify(range.content)).toContain("output");
		expect(JSON.stringify(range.content)).not.toContain("range-output");
		const page = await execute('print("中😀" * 70000, end="END")');
		const fullRef = page.details.resultRef!;
		await execute(
			`value = await refs["${fullRef}"].read()\nassert value["status"] == "ok"\nawait refs["${fullRef}"].materialize(path="full.json")`,
		);
		expect(JSON.parse(await readFile(join(root, "full.json"), "utf8"))).toMatchObject({ status: "ok" });
		const expected = `${"中😀".repeat(70000)}END`;
		let recovered = "";
		for (let offset = 0; offset < Buffer.byteLength(expected); offset += 14000) {
			const end = Math.min(offset + 14000, Buffer.byteLength(expected));
			const chunk = await execute(`print(await refs["${fullRef}"].read(span=[${offset}, ${end}]), end="")`);
			const text = chunk.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("");
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
			expect(text).not.toContain("�");
			recovered += text.replace(/^ok\n\n(?:\[ref=r[0-9a-z]+\]\n*)?/, "").replace(/\n\n\[ref=r[0-9a-z]+\]$/, "");
		}
		expect(recovered === expected).toBe(true);
		const first = await execute(
			'import asyncio\ntransient = 1\nprint("before-sleep")\nawait yield_control()\nawait asyncio.sleep(0.4)\nprint("after-sleep", flush=True)',
		);
		expect(first.details.status).toBe("running");
		const id = first.details.cellId!;
		const parts = [JSON.stringify(first.content)];
		expect(parts[0]).toContain("before-sleep");
		const independent = await execute('print("independent-while-awaiting")\nassert "transient" not in globals()');
		expect(independent.details.status).toBe("ok");
		expect(JSON.stringify(independent.content)).not.toContain("after-sleep");
		let completed = await wait(id);
		parts.push(JSON.stringify(completed.content));
		while (completed.details.status === "running") {
			completed = await wait(id);
			parts.push(JSON.stringify(completed.content));
		}
		expect(completed.details.status).toBe("ok");
		expect(parts.join(" ").match(/before-sleep/g)).toHaveLength(1);
		expect(parts.join(" ").match(/after-sleep/g)).toHaveLength(1);
		expect(parts.join(" ")).not.toContain("independent-while-awaiting");
		await expect(wait(id)).rejects.toBeInstanceOf(AgentToolExecutionError);
		expect((await execute('assert "transient" not in globals(); print(persist.answer)')).content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("42") })]),
		);
		await execute(
			[
				'temporary = "must not persist"',
				"persist.counter = 1",
				"persist._private = 9",
				"def factory():",
				"    captured = [4]",
				"    def closure(value=5): return captured[0] + value",
				"    return closure",
				"persist.closure = factory()",
				"@persist",
				"def current(): return persist.counter",
				"assert current is persist.current",
				"@persist",
				"def bad_global(): return temporary",
				"persist.bad = (x for x in [])",
				"persist.deleted = 1",
				"del persist.deleted",
			].join("\n"),
		);
		await execute(
			[
				"assert persist.current() == 1",
				'assert "temporary" not in persist.current.__globals__',
				"persist.counter = 2",
				"assert persist.current() == 2",
				"try:",
				"    persist.bad_global()",
				"except NameError:",
				"    pass",
				"else:",
				'    raise AssertionError("temporary global retained")',
			].join("\n"),
		);
		await runtime.snapshot();
		await runtime.close();
		runtime = await RiemannRuntime.createRoot(context);
		await execute(
			'assert persist.current() == 2\npersist.counter = 3\nassert persist.current() == 3\nassert persist.closure() == 9\nassert persist._private == 9\nassert "bad" not in vars(persist) and "deleted" not in vars(persist)\nassert persist.answer == 42\nassert "counter" not in globals()',
		);
		const background = await execute(
			'handle = await shell.run(script="printf first; sleep 0.4; printf last", background=True)\nprint(handle)',
		);
		const processId = background.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("")
			.match(/id='(p[0-9a-z]+)'/)![1];
		await execute('assert persist.current() == 3\nprint("independent")');
		let backgroundResult = await wait(processId);
		let backgroundOutput = JSON.stringify(backgroundResult.content);
		while (backgroundResult.details.status === "running") {
			backgroundResult = await wait(processId);
			backgroundOutput += JSON.stringify(backgroundResult.content);
		}
		expect(backgroundOutput).toContain("first");
		expect(backgroundOutput).toContain("last");
		expect(backgroundOutput).toContain("exit_code=0");
		for (const termination of ["timeout", "cancelled"]) {
			const started = await execute(
				`# @exec: {"timeout_ms": ${termination === "timeout" ? 1500 : 300000}}\nprint(await shell.run(script="printf retained-before-stop; sleep 30", background=True))`,
			);
			const processId = JSON.stringify(started.content).match(/id='(p[0-9a-z]+)'/)![1];
			await execute('import asyncio\nawait asyncio.sleep(0.2)\nprint("kernel-free")');
			try {
				let result = await wait(processId, termination === "cancelled");
				while (result.details.status === "running") result = await wait(processId);
				throw new Error("expected process termination");
			} catch (error) {
				expect(error).toBeInstanceOf(AgentToolExecutionError);
				if (!(error instanceof AgentToolExecutionError)) throw error;
				expect(error.result.details).toMatchObject({ status: termination });
				const reference = JSON.stringify(error.result.content).match(/\[ref=(r[0-9a-z]+)\]/)![1];
				await execute(
					`result = await refs["${reference}"].read()\nassert result.termination == "${termination}"\nassert await result.stdout.read() == "retained-before-stop"`,
				);
			}
		}

		const long = await execute(
			'# @exec: {"yield_time_ms": 100}\nawait shell.run(script="printf started > started.txt; sleep 30; printf finished > finished.txt")',
		);
		const longId = long.details.cellId!;
		expect(long.details.status).toBe("running");
		expect(await readFile(join(root, "started.txt"), "utf8")).toBe("started");
		const survivor = await execute(
			'import asyncio\npersist.release = asyncio.Event()\nchild = asyncio.create_task(persist.release.wait())\nawait yield_control()\nawait child\nprint("survived-other-cancellation")',
		);
		expect(survivor.details.status).toBe("running");
		try {
			await wait(longId, true);
			throw new Error("expected cancellation");
		} catch (error) {
			expect(error).toBeInstanceOf(AgentToolExecutionError);
			if (error instanceof AgentToolExecutionError) {
				expect(error.result.details).toMatchObject({ status: "cancelled" });
				expect(JSON.stringify(error.result.content)).toContain("[ref=");
			}
		}
		await expect(readFile(join(root, "finished.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await execute("persist.release.set()\ndel persist.release");
		let survived = await wait(survivor.details.cellId!);
		let survivorOutput = JSON.stringify(survived.content);
		while (survived.details.status === "running") {
			survived = await wait(survivor.details.cellId!);
			survivorOutput += JSON.stringify(survived.content);
		}
		expect(survived.details.status).toBe("ok");
		expect(survivorOutput.match(/survived-other-cancellation/g)).toHaveLength(1);
		const immediate = await execute(
			'# @exec: {"yield_time_ms": 0}\nimport asyncio\nawait asyncio.sleep(0.2)\nprint("zero-wait")',
		);
		expect(immediate.details.status).toBe("running");
		const checked = await wait(immediate.details.cellId!, false, 0);
		expect(checked.details.status).toBe("running");
		let zeroResult = await wait(immediate.details.cellId!);
		let zeroOutput = JSON.stringify(zeroResult.content);
		while (zeroResult.details.status === "running") {
			zeroResult = await wait(immediate.details.cellId!);
			zeroOutput += JSON.stringify(zeroResult.content);
		}
		expect(zeroOutput.match(/zero-wait/g)).toHaveLength(1);
		expect((await execute('print("usable")')).details.status).toBe("ok");
		const internals = runtime as unknown as {
			kernel: IPythonKernelManager;
			shared: { store: { snapshotsDir: string } };
		};
		const checkpoint = join(internals.shared.store.snapshotsDir, runtime.agent.id, "kernel.dill");
		await internals.kernel.execute(
			'import types, dill, io\nlegacy = types.ModuleType("_riemann_user")\nlegacy.legacy_value = 17\nbuffer = io.BytesIO()\ndill.dump_module(buffer, module=legacy, refimported=True)\nriemann_code_state = {"namespace": buffer.getvalue(), "store": {"kept": "old-store-data"}}\ndef _riemann_snapshot_code_state(value): return value, []',
			{ internal: true },
		);
		await runtime.close();
		const bytes = await readFile(checkpoint);
		const original = Buffer.concat([
			Buffer.from(`RIEMANN-CHECKPOINT ${"0".repeat(64)}\n`),
			bytes.subarray(bytes.indexOf(10) + 1),
		]);
		await writeFile(checkpoint, original);
		runtime = await RiemannRuntime.createRoot(context);
		const migrated = await execute("assert persist.legacy_value == 17");
		const legacyRef = JSON.stringify(migrated.content).match(/Previous store data retained at (r[0-9a-z]+)/)![1];
		await execute(
			`import json\nassert json.loads(await refs["${legacyRef}"].read()) == {"kept": "old-store-data"}\nassert (await refs["${resultRef}"].read()).exit_code == 7`,
		);
		const backups = (await readdir(dirname(checkpoint))).filter((name) => name.endsWith(".original"));
		expect(backups).toHaveLength(1);
		expect(await readFile(join(dirname(checkpoint), backups[0]))).toEqual(original);
	} finally {
		await runtime?.close();
		if (previous === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
		else process.env.RIEMANN_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}, 120000);
