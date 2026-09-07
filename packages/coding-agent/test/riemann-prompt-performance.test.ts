import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";

test("unchanged prompt inventory does not repeat schema serialization on the message dispatch path", async () => {
	const root = await mkdtemp(join(tmpdir(), "riemann-prompt-performance-"));
	const previous = process.env.RIEMANN_CODING_AGENT_DIR;
	process.env.RIEMANN_CODING_AGENT_DIR = join(root, "agent");
	let runtime: RiemannRuntime | undefined;
	try {
		const started = performance.now();
		runtime = await RiemannRuntime.createRoot({
			cwd: root,
			thinkingLevel: "off",
			sessionManager: { getSessionId: () => "prompt-performance" },
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext);
		const created = performance.now();
		const first = runtime.systemPrompt("main");
		const prepared = performance.now();
		const stringify = vi.spyOn(JSON, "stringify");
		try {
			for (let index = 0; index < 20; index++) expect(runtime.systemPrompt("main")).toBe(first);
			const calls = stringify.mock.calls.filter(
				([value]) => value !== null && typeof value === "object" && "type" in value && value.type === "object",
			).length;
			console.info({
				createMs: created - started,
				firstPromptMs: prepared - created,
				repeat20Ms: performance.now() - prepared,
				promptChars: first.length,
				schemaSerializations: calls,
			});
			expect(calls).toBe(0);
		} finally {
			stringify.mockRestore();
		}
	} finally {
		await runtime?.close();
		if (previous === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
		else process.env.RIEMANN_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
