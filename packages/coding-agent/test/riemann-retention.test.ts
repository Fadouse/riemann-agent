import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { FULL_FILESYSTEM } from "../src/riemann/access-policy.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { applyRetention } from "../src/riemann/state/retention.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<void> {
	const result = await execCommand(
		"git",
		["-c", "user.name=Riemann Test", "-c", "user.email=test@example.invalid", ...args],
		cwd,
		{
			timeout: 30_000,
		},
	);
	if (result.code !== 0) throw new Error(result.stderr);
}

const policy = {
	maxAgeDays: 0,
	maxArtifactBytes: Number.MAX_SAFE_INTEGER,
	maxSnapshotBytes: Number.MAX_SAFE_INTEGER,
	maxWorktreeBytes: Number.MAX_SAFE_INTEGER,
};

describe("Riemann state retention", () => {
	test("removes only closed run artifacts, snapshots, and Git worktrees", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-retention-"));
		roots.push(root);
		const repository = join(root, "repository");
		const agentDir = join(root, "agent");
		await mkdir(repository);
		await git(repository, ["init"]);
		await writeFile(join(repository, "README.md"), "retention test\n");
		await git(repository, ["add", "README.md"]);
		await git(repository, ["commit", "-m", "initial"]);

		const store = new RiemannStore(agentDir);
		try {
			const closed = store.openRun("closed-session", repository);
			store.ensureRootAgent(closed.id, repository);
			const child = store.createAgent({
				runId: closed.id,
				parentId: store.ensureRootAgent(closed.id, repository).id,
				name: "worktree",
				status: "idle",
				prompt: "",
				modelRole: "inherit",
				workspace: repository,
				workspaceMode: "worktree",
				filesystem: FULL_FILESYSTEM,
				depth: 1,
				capabilities: ["fs.read"],
			});
			const worktree = join(store.root, "workspaces", closed.id, child.id);
			await mkdir(join(store.root, "workspaces", closed.id), { recursive: true });
			await git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
			store.updateAgent(child.id, { workspace: worktree });
			const closedArtifacts = new ArtifactStore(store, closed.id);
			const closedArtifact = await closedArtifacts.putText("closed artifact");
			const closedArtifactPath = closedArtifacts.getMetadata((closedArtifact as { handle: string }).handle).path;
			const closedSnapshot = join(store.snapshotsDir, child.id, "kernel.dill");
			await mkdir(join(store.snapshotsDir, child.id), { recursive: true });
			await writeFile(closedSnapshot, "snapshot");
			store.closeRun(closed.id);

			const active = store.openRun("active-session", repository);
			const activeAgent = store.ensureRootAgent(active.id, repository);
			const activeArtifacts = new ArtifactStore(store, active.id);
			const activeArtifact = await activeArtifacts.putText("active artifact");
			const activeArtifactPath = activeArtifacts.getMetadata((activeArtifact as { handle: string }).handle).path;
			const activeSnapshot = join(store.snapshotsDir, activeAgent.id, "kernel.dill");
			await mkdir(join(store.snapshotsDir, activeAgent.id), { recursive: true });
			await writeFile(activeSnapshot, "active snapshot");

			const report = await applyRetention(store, policy);
			expect(report.errors).toEqual([]);
			expect(report.removedRunIds).toEqual([closed.id]);
			expect(existsSync(worktree)).toBe(false);
			expect(existsSync(closedSnapshot)).toBe(false);
			expect(existsSync(closedArtifactPath)).toBe(false);
			expect(existsSync(activeSnapshot)).toBe(true);
			expect(existsSync(activeArtifactPath)).toBe(true);
			expect(store.listRuns().map((run) => run.id)).toEqual([active.id]);
		} finally {
			store.close();
		}
	}, 60_000);

	test("accounts for snapshots owned by released agents", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-retention-released-"));
		roots.push(root);
		const store = new RiemannStore(join(root, "agent"));
		try {
			const run = store.openRun("released-agent-session", root);
			const main = store.ensureRootAgent(run.id, root);
			const child = store.createAgent({
				runId: run.id,
				parentId: main.id,
				name: "released",
				status: "idle",
				prompt: "",
				modelRole: "inherit",
				workspace: root,
				workspaceMode: "shared",
				filesystem: FULL_FILESYSTEM,
				depth: 1,
				capabilities: ["fs.read"],
			});
			store.releaseAgent(child.id);
			const snapshot = join(store.snapshotsDir, `${child.id}.dill`);
			const contents = "released snapshot";
			await writeFile(snapshot, contents);
			store.closeRun(run.id);

			const report = await applyRetention(store, {
				...policy,
				maxAgeDays: 36_500,
				maxSnapshotBytes: 0,
			});
			expect(report.errors).toEqual([]);
			expect(report.removedRunIds).toEqual([run.id]);
			expect(report.freedSnapshotBytes).toBe(Buffer.byteLength(contents));
			expect(existsSync(snapshot)).toBe(false);
		} finally {
			store.close();
		}
	});

	test("retains metadata and releases the reservation when worktree cleanup fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-retention-failure-"));
		roots.push(root);
		const store = new RiemannStore(join(root, "agent"));
		try {
			const run = store.openRun("retry-session", root);
			const main = store.ensureRootAgent(run.id, root);
			const worktree = join(store.root, "workspaces", run.id, "broken-worktree");
			await mkdir(worktree, { recursive: true });
			store.updateAgent(main.id, { workspace: worktree });
			store.closeRun(run.id);
			const report = await applyRetention(store, policy, {
				removeWorktree: async () => {
					throw new Error("injected worktree failure");
				},
			});
			expect(report.removedRunIds).toEqual([]);
			expect(report.errors[0]?.message).toContain("injected worktree failure");
			expect(store.openRun("retry-session", root).status).toBe("active");
		} finally {
			store.close();
		}
	});
});
