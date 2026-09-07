import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolExecutionError } from "@earendil-works/pi-agent-core";
import { expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
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
		const wait = (id: string, terminate = false) =>
			runtime!.waitToolDefinition().execute("wait", { cell_id: id, terminate }, undefined, undefined, context);
		const warmup = await execute('store("answer", 42)');
		expect(warmup.details.status).toBe("ok");
		let page = await execute('print("中😀" * 70000, end="END")');
		const recovered: string[] = [];
		for (let count = 0; count < 20; count++) {
			const text = page.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("");
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
			expect(text).not.toContain("�");
			recovered.push(text.replace(/^Cell c[0-9a-f]+ ok\.\n*/, "").replace(/\n\[more r[0-9a-z]+\]$/, ""));
			if (!page.details.moreRef) break;
			page = await execute(`await output.more(ref=${JSON.stringify(page.details.moreRef)})`);
		}
		expect(page.details.moreRef).toBeUndefined();
		expect(recovered.join("")).toBe(`${"中😀".repeat(70000)}END`);
		const first = await execute(
			'import asyncio\ntransient = 1\nawait output.show(value="before-sleep")\nawait asyncio.sleep(10.2)\nprint("after-sleep", flush=True)',
		);
		expect(first.details.status).toBe("running");
		const id = first.details.cellId!;
		const parts = [JSON.stringify(first.content)];
		expect(parts[0]).toContain("before-sleep");
		const completed = await wait(id);
		parts.push(JSON.stringify(completed.content));
		expect(completed.details.status).toBe("ok");
		expect(parts.join(" ").match(/before-sleep/g)).toHaveLength(1);
		expect(parts.join(" ").match(/after-sleep/g)).toHaveLength(1);
		await expect(wait(id)).rejects.toBeInstanceOf(AgentToolExecutionError);
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
			'await shell.run(script="printf started > started.txt; sleep 30; printf finished > finished.txt")',
		);
		const longId = long.details.cellId!;
		expect(long.details.status).toBe("running");
		expect(await readFile(join(root, "started.txt"), "utf8")).toBe("started");
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
}, 60000);
