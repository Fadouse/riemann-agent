import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RiemannActivityTracker } from "../src/riemann/activity.ts";
import type { KernelHostRequest, KernelHostRequestEvent } from "../src/riemann/kernel/types.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(type: string, args: KernelHostRequest["args"]): KernelHostRequest {
	return { type, args, cellId: "cell-1" };
}

async function observe(tracker: RiemannActivityTracker, event: KernelHostRequestEvent) {
	const activities = await tracker.observe(event);
	if (!activities) throw new Error("Expected a visible activity");
	return activities;
}

describe("Riemann IPython activity tracking", () => {
	test("tracks streaming shell output and terminal process metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-activity-shell-"));
		roots.push(root);
		const tracker = new RiemannActivityTracker(root, () => undefined);
		const shellRequest = request("shell.run", { script: "npm test", cwd: "packages/agent" });
		let activities = await observe(tracker, {
			phase: "start",
			requestId: "shell-1",
			request: shellRequest,
			startedAt: 1,
		});
		expect(activities[0]).toMatchObject({ kind: "shell", status: "running", command: "npm test" });
		activities = await observe(tracker, {
			phase: "update",
			requestId: "shell-1",
			request: shellRequest,
			update: { stdout_delta: "Tests 12 passed\n", stderr_delta: "" },
		});
		expect(activities[0]).toMatchObject({ stdout: "Tests 12 passed\n" });
		activities = await observe(tracker, {
			phase: "end",
			requestId: "shell-1",
			request: shellRequest,
			durationMs: 40,
			result: {
				$riemann: "process_result",
				command: "npm test",
				exit_code: 0,
				stdout: "Tests 12 passed\n",
				stderr: "",
				duration_ms: 40,
				timed_out: false,
				artifact: null,
			},
		});
		expect(activities[0]).toMatchObject({ status: "ok", exitCode: 0, durationMs: 40 });
	});

	test("derives actual file and patch diffs from atomic file operations", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-activity-file-"));
		roots.push(root);
		const path = join(root, "value.ts");
		await writeFile(path, "const value = 1;\n", "utf8");
		const tracker = new RiemannActivityTracker(root, (capability) =>
			capability === "file-capability" ? path : undefined,
		);
		const editRequest = request("fs.edit", {
			snapshot: { $riemann: "text_snapshot_ref", capability: "file-capability" },
			operations: [{ kind: "replace", start: 14, end: 15, text: "2" }],
		});
		await observe(tracker, { phase: "start", requestId: "edit-1", request: editRequest, startedAt: 1 });
		const activities = await observe(tracker, {
			phase: "end",
			requestId: "edit-1",
			request: editRequest,
			durationMs: 10,
			result: {
				$riemann: "text_snapshot",
				path,
				text: "const value = 2;\n",
				encoding: "utf-8",
				_capability: "next-capability",
			},
		});
		expect(activities[0]).toMatchObject({
			kind: "patch",
			status: "ok",
			path: "value.ts",
			additions: 1,
			removals: 1,
		});
		expect(activities[0] && "diff" in activities[0] ? activities[0].diff : "").toContain("+1 const value = 2;");
	});

	test("parses spawned child identity and task metadata", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-activity-agent-"));
		roots.push(root);
		const tracker = new RiemannActivityTracker(root, () => undefined);
		const spawnRequest = request("agents.spawn", {
			task: "Review the parser",
			name: "Reviewer",
			profile: "deep",
		});
		await observe(tracker, { phase: "start", requestId: "agent-1", request: spawnRequest, startedAt: 1 });
		const activities = await observe(tracker, {
			phase: "end",
			requestId: "agent-1",
			request: spawnRequest,
			durationMs: 8,
			result: { $riemann: "agent_handle", id: "child-1", name: "Reviewer" },
		});
		expect(activities[0]).toMatchObject({
			kind: "agent",
			operation: "spawn",
			status: "ok",
			agentId: "child-1",
			name: "Reviewer",
			task: "Review the parser",
			profile: "deep",
			agentStatus: "running",
		});
	});

	test("keeps bounded stream and error text on grapheme boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-activity-unicode-"));
		roots.push(root);
		const tracker = new RiemannActivityTracker(root, () => undefined);
		const shellRequest = request("shell.run", { script: "unicode" });
		await observe(tracker, { phase: "start", requestId: "shell-unicode", request: shellRequest, startedAt: 1 });
		let activities = await observe(tracker, {
			phase: "update",
			requestId: "shell-unicode",
			request: shellRequest,
			update: { stdout_delta: `a😀${"x".repeat(19_999)}` },
		});
		const running = activities[0];
		expect(running?.kind).toBe("shell");
		const runningStdout = running?.kind === "shell" ? running.stdout : undefined;
		expect(Buffer.from(runningStdout ?? "", "utf8").toString("utf8")).toBe(runningStdout);
		expect(runningStdout).toBe(`[earlier output omitted]\n${"x".repeat(19_999)}`);

		activities = await observe(tracker, {
			phase: "end",
			requestId: "shell-unicode",
			request: shellRequest,
			durationMs: 2,
			error: { code: "execution_error", message: `${"x".repeat(1_999)}😀z` },
		});
		const finished = activities[0];
		expect(Buffer.from(finished?.error ?? "", "utf8").toString("utf8")).toBe(finished?.error);
		expect(finished?.error).toBe("x".repeat(1_999));
	});
});
