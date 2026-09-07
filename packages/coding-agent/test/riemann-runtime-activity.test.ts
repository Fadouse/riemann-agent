import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { IPythonToolDetails } from "../src/riemann/ipython.ts";
import type { IPythonKernelManager } from "../src/riemann/kernel/manager.ts";
import type { KernelExecuteOptions, KernelExecuteResult } from "../src/riemann/kernel/types.ts";
import { RiemannRuntime } from "../src/riemann/runtime.ts";
import type { RiemannStore } from "../src/riemann/state/store.ts";

test("resolves only owned child names from durable state in each cell, including release", async () => {
	const root = await mkdtemp(join(tmpdir(), "riemann-runtime-activity-"));
	const previousAgentDir = process.env.RIEMANN_CODING_AGENT_DIR;
	process.env.RIEMANN_CODING_AGENT_DIR = join(root, "agent-dir");
	let runtime: RiemannRuntime | undefined;
	try {
		const context = {
			cwd: root,
			thinkingLevel: "off",
			sessionManager: { getSessionId: () => "runtime-activity" },
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;
		runtime = await RiemannRuntime.createRoot(context);
		const internal = runtime as unknown as {
			shared: { store: RiemannStore };
			ensureKernel(): Promise<Pick<IPythonKernelManager, "execute" | "snapshot">>;
		};
		const store = internal.shared.store;
		const childInput = {
			runId: runtime.agent.runId,
			parentId: runtime.agent.id,
			name: "Reviewer",
			depth: 1,
			status: "idle" as const,
			prompt: "Review",
			modelRole: "inherit",
			workspace: root,
			workspaceMode: "shared" as const,
			filesystem: runtime.agent.filesystem,
			network: runtime.agent.network,
			capabilities: runtime.agent.capabilities,
		};
		const child = store.createAgent(childInput);
		const otherParent = store.createAgent({
			...childInput,
			parentId: child.id,
			name: "Private grandchild",
			depth: 2,
		});
		const otherRun = store.openRun("other-session", root);
		const foreign = store.createAgent({ ...childInput, runId: otherRun.id, name: "Other run" });
		const targets = [child.id, otherParent.id, foreign.id, "missing", child.id, child.id];
		let cell = 0;
		vi.spyOn(internal, "ensureKernel").mockResolvedValue({
			execute: async (_code: string, options: KernelExecuteOptions = {}): Promise<KernelExecuteResult> => {
				const agentId = targets[cell++];
				const operation = cell === 5 ? "agents.release" : "agents.info";
				const request = { requestId: "request-1", operation, arguments: { agent_id: agentId } };
				await options.onHostRequest?.({ phase: "start", requestId: request.requestId, request, startedAt: 1 });
				if (operation === "agents.release") store.releaseAgent(agentId);
				await options.onHostRequest?.({
					phase: "end",
					requestId: request.requestId,
					request,
					durationMs: 2,
					result: null,
				});
				return { status: "ok", stdout: "", stderr: "", displays: [], modelContent: [], durationMs: 2 };
			},
			snapshot: async () => ({ restored: [], skipped: [] }),
		});
		for (const agentId of targets) {
			const updates: IPythonToolDetails[] = [];
			const result = await runtime.toolDefinition().execute(
				"tool",
				{ code: "pass" },
				undefined,
				(update) => {
					if (update.details) updates.push(update.details);
				},
				context,
			);
			const running = updates.find((update) => update.activities?.length)?.activities?.[0];
			const finished = result.details?.activities?.[0];
			expect(running).toMatchObject({ agentId, status: "running" });
			expect(finished).toMatchObject({ agentId, status: "ok" });
			if (agentId === child.id) {
				expect(running).toHaveProperty("name", "Reviewer");
				expect(finished).toHaveProperty("name", "Reviewer");
			} else {
				expect(running).not.toHaveProperty("name");
				expect(finished).not.toHaveProperty("name");
			}
		}
	} finally {
		vi.restoreAllMocks();
		await runtime?.close();
		if (previousAgentDir === undefined) delete process.env.RIEMANN_CODING_AGENT_DIR;
		else process.env.RIEMANN_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
