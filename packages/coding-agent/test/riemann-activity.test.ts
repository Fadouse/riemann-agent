import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RiemannActivityTracker } from "../src/riemann/activity.ts";
import type { KernelHostRequest, KernelHostRequestEvent } from "../src/riemann/kernel/types.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(type: string, args: KernelHostRequest["arguments"]): KernelHostRequest {
	return { requestId: `request-${type}`, operation: type, arguments: args, cellId: "cell-1" };
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
			update: { sequence: 1, kind: "stdout", value: "Tests 12 passed\n", truncated: false },
		});
		expect(activities[0]).toMatchObject({ stdout: "Tests 12 passed\n" });
		activities = await observe(tracker, {
			phase: "end",
			requestId: "shell-1",
			request: shellRequest,
			durationMs: 40,
			result: {
				$riemann: "process_result",
				exit_code: 0,
				stdout: "Tests 12 passed\n",
				stderr: "",
				duration_ms: 40,
				termination: "exited",
				stdout_truncated: true,
				stderr_truncated: false,
				stdout_capture_truncated: true,
				stderr_capture_truncated: false,
				stdout_artifact: { handle: "artifact://stdout" },
				stderr_artifact: null,
			},
		});
		expect(activities[0]).toMatchObject({
			status: "ok",
			exitCode: 0,
			durationMs: 40,
			stdoutTruncated: true,
			stdoutCaptureTruncated: true,
			stdoutArtifactHandle: "artifact://stdout",
		});
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
				kind: "text",
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
		const spawnRequest = request("agents.start", {
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
			result: {
				$riemann: "agent_turn_handle",
				id: "child-1",
				name: "Reviewer",
				turn_id: "turn-1",
				status: "running",
			},
		});
		expect(activities[0]).toMatchObject({
			kind: "agent",
			operation: "start",
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
			update: { sequence: 1, kind: "stdout", value: `a😀${"x".repeat(19_999)}`, truncated: false },
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
			error: {
				code: "execution_error",
				message: `${"x".repeat(1_999)}😀z`,
				operation: "shell.run",
				requestId: "shell-unicode",
				retryable: false,
			},
		});
		const finished = activities[0];
		expect(Buffer.from(finished?.error ?? "", "utf8").toString("utf8")).toBe(finished?.error);
		expect(finished?.error).toBe("x".repeat(1_999));
	});
	test("counts complete large file lines without allocating an array of lines", async () => {
		const tracker = new RiemannActivityTracker(process.cwd(), () => undefined);
		const text = "content\r\n".repeat(120_000);
		const split = vi.spyOn(String.prototype, "split");
		try {
			const result = await observe(tracker, {
				phase: "start",
				requestId: "large-file",
				startedAt: 1,
				request: request("fs.create", { path: "large.txt", text }),
			});
			expect(result[0]).toMatchObject({ additions: 120_000, diffTruncated: true });
			expect(split.mock.contexts.some((context) => String(context) === text)).toBe(false);
		} finally {
			split.mockRestore();
		}
	});

	test("keeps returned snapshots independent from subsequent events and caller mutation", async () => {
		const tracker = new RiemannActivityTracker(process.cwd(), () => undefined);
		const shellRequest = request("shell.run", { script: "true" });
		const first = await observe(tracker, { phase: "start", requestId: "one", startedAt: 1, request: shellRequest });
		first[0].status = "error";
		const second = await observe(tracker, { phase: "start", requestId: "two", startedAt: 1, request: shellRequest });
		expect(second.map((activity) => activity.status)).toEqual(["running", "running"]);
		await observe(tracker, {
			phase: "end",
			requestId: "one",
			request: shellRequest,
			durationMs: 2,
			result: { exit_code: 0 },
		});
		expect(first[0].status).toBe("error");
		expect(second[0].status).toBe("running");
	});
});
