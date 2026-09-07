import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolExecutionError } from "@earendil-works/pi-agent-core";
import { expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
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
		const wait = (id: string, terminate = false, yield_time_ms = 10000) =>
			runtime!
				.waitToolDefinition()
				.execute("wait", { cell_id: id, terminate, yield_time_ms }, undefined, undefined, context);
		const warmup = await execute('store("answer", 42)');
		expect(warmup.details.status).toBe("ok");
		const first = await execute(
			'# @exec: {"yield_time_ms": 0}\nimport asyncio\ntransient = 1\nawait output.show(value="before-sleep")\nawait asyncio.sleep(0.3)\nprint("after-sleep", flush=True)',
		);
		expect(first.details.status).toBe("running");
		const id = first.details.cellId!;
		const parts = [JSON.stringify(first.content)];
		let running = true;
		let sawIntermediate = false;
		for (let attempt = 0; running && attempt < 100; attempt++) {
			const result = await wait(id, false, 20);
			parts.push(JSON.stringify(result.content));
			running = result.details.status === "running";
			if (running && parts.at(-1)?.includes("before-sleep")) sawIntermediate = true;
		}
		expect(running).toBe(false);
		expect(sawIntermediate).toBe(true);
		expect(parts.join(" ").match(/before-sleep/g)).toHaveLength(1);
		expect(parts.join(" ").match(/after-sleep/g)).toHaveLength(1);
		await expect(wait(id)).rejects.toThrow("already collected");
		expect((await execute('assert "transient" not in globals(); print(load("answer"))')).content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("42") })]),
		);
		await execute('# @exec: {"persist": true}\ncounter = 1\ndef current(): return counter');
		await execute('# @exec: {"persist": true}\ncounter = 2\nassert current() == 2\nbad = (x for x in [])');
		await runtime.snapshot();
		await runtime.close();
		runtime = await RiemannRuntime.createRoot(context);
		await execute(
			'# @exec: {"persist": true}\nassert current() == 2, ("before", current())\ncounter = 3\nassert current() == 3, ("after", current(), current.__globals__ is globals())\nassert "bad" not in globals(), "bad restored"',
		);
		await execute('assert load("answer") == 42');

		const long = await execute(
			'# @exec: {"yield_time_ms": 0}\nawait shell.run(script="printf started > started.txt; sleep 30; printf finished > finished.txt", timeout=60)',
		);
		const longId = long.details.cellId!;
		let started = false;
		for (let attempt = 0; !started && attempt < 100; attempt++) {
			await wait(longId, false, 20);
			started = await readFile(join(root, "started.txt"), "utf8").then(
				() => true,
				() => false,
			);
		}
		expect(started).toBe(true);
		try {
			await wait(longId, true);
			throw new Error("expected cancellation");
		} catch (error) {
			expect(error).toBeInstanceOf(AgentToolExecutionError);
			if (error instanceof AgentToolExecutionError)
				expect(error.result.details).toMatchObject({ status: "cancelled" });
		}
		await expect(readFile(join(root, "finished.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect((await execute('print("usable")')).details.status).toBe("ok");
	} finally {
		await runtime?.close();
		if (previous === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
		else process.env.RIEMANN_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
