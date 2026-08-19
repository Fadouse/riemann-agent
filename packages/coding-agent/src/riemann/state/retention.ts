import type { Stats } from "node:fs";
import { lstat, opendir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execCommand } from "../../core/exec.ts";
import type { RiemannStore, StoredArtifact, StoredRun } from "./store.ts";

export interface RetentionPolicy {
	maxAgeDays: number;
	maxArtifactBytes: number;
	maxSnapshotBytes: number;
	maxWorktreeBytes: number;
}

export interface RetentionReport {
	removedRunIds: string[];
	freedArtifactBytes: number;
	freedSnapshotBytes: number;
	freedWorktreeBytes: number;
	errors: Array<{ runId: string; message: string }>;
}

interface RunResources {
	run: StoredRun;
	artifacts: StoredArtifact[];
	artifactBytes: number;
	snapshotPaths: string[];
	snapshotBytes: number;
	worktreeRoot: string;
	worktreePaths: string[];
	worktreeBytes: number;
}

function isInside(root: string, path: string): boolean {
	const pathFromRoot = relative(resolve(root), resolve(path));
	return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !pathFromRoot.startsWith(sep);
}

function assertResourcePath(root: string, path: string): string {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	if (resolvedPath === resolvedRoot || !isInside(resolvedRoot, resolvedPath)) {
		throw new Error(`Retention path escapes its resource root: ${resolvedPath}`);
	}
	return resolvedPath;
}

async function pathSize(path: string): Promise<number> {
	let info: Stats;
	try {
		info = await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
		throw error;
	}
	if (info.isSymbolicLink()) return 0;
	if (!info.isDirectory()) return info.size;
	let total = 0;
	const directory = await opendir(path);
	for await (const entry of directory) total += await pathSize(join(path, entry.name));
	return total;
}

async function immediateDirectories(path: string): Promise<string[]> {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(path, entry.name));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

async function defaultRemoveWorktree(path: string): Promise<void> {
	const listing = await execCommand("git", ["-C", path, "worktree", "list", "--porcelain"], dirname(path), {
		timeout: 30_000,
	});
	if (listing.code !== 0) throw new Error(`Could not inspect Git worktree ${path}: ${listing.stderr.trim()}`);
	const main = listing.stdout
		.split(/\r?\n/)
		.find((line) => line.startsWith("worktree "))
		?.slice("worktree ".length);
	if (!main) throw new Error(`Could not identify the main Git worktree for ${path}`);
	const removed = await execCommand("git", ["-C", main, "worktree", "remove", "--force", path], main, {
		timeout: 60_000,
	});
	if (removed.code !== 0) throw new Error(`Could not remove Git worktree ${path}: ${removed.stderr.trim()}`);
}

async function inspectRun(store: RiemannStore, run: StoredRun): Promise<RunResources> {
	const agents = store.listAgents(run.id, { includeReleased: true });
	const artifacts = store.listArtifacts(run.id);
	const artifactPaths = new Map<string, number>();
	for (const artifact of artifacts) artifactPaths.set(artifact.path, artifact.size);
	const snapshotPaths = agents.flatMap((agent) => [
		join(store.snapshotsDir, agent.id),
		join(store.snapshotsDir, `${agent.id}.dill`),
	]);
	const worktreeRoot = join(store.root, "workspaces", run.id);
	const worktreePaths = await immediateDirectories(worktreeRoot);
	return {
		run,
		artifacts,
		artifactBytes: [...artifactPaths.values()].reduce((total, size) => total + size, 0),
		snapshotPaths,
		snapshotBytes: (
			await Promise.all(snapshotPaths.map((path) => pathSize(assertResourcePath(store.snapshotsDir, path))))
		).reduce((total, size) => total + size, 0),
		worktreeRoot,
		worktreePaths,
		worktreeBytes: (
			await Promise.all(worktreePaths.map((path) => pathSize(assertResourcePath(worktreeRoot, path))))
		).reduce((total, size) => total + size, 0),
	};
}

function budgetCandidates(
	resources: readonly RunResources[],
	closed: readonly RunResources[],
	field: "artifactBytes" | "snapshotBytes" | "worktreeBytes",
	budget: number,
	selected: Set<string>,
): void {
	let total = resources.reduce((sum, resource) => sum + resource[field], 0);
	if (total <= budget) return;
	for (const resource of closed) {
		if (total <= budget) break;
		if (!selected.has(resource.run.id)) selected.add(resource.run.id);
		total -= resource[field];
	}
}

export async function applyRetention(
	store: RiemannStore,
	policy: RetentionPolicy,
	options: { now?: Date; removeWorktree?: (path: string) => Promise<void> } = {},
): Promise<RetentionReport> {
	const report: RetentionReport = {
		removedRunIds: [],
		freedArtifactBytes: 0,
		freedSnapshotBytes: 0,
		freedWorktreeBytes: 0,
		errors: [],
	};
	const resources = await Promise.all(store.listRuns().map((run) => inspectRun(store, run)));
	const closed = resources
		.filter((resource) => resource.run.status === "closed")
		.sort((left, right) => left.run.updatedAt.localeCompare(right.run.updatedAt));
	const selected = new Set<string>();
	const cutoff = (options.now ?? new Date()).getTime() - policy.maxAgeDays * 86_400_000;
	for (const resource of closed) {
		if (new Date(resource.run.updatedAt).getTime() <= cutoff) selected.add(resource.run.id);
	}
	budgetCandidates(resources, closed, "artifactBytes", policy.maxArtifactBytes, selected);
	budgetCandidates(resources, closed, "snapshotBytes", policy.maxSnapshotBytes, selected);
	budgetCandidates(resources, closed, "worktreeBytes", policy.maxWorktreeBytes, selected);

	for (const resource of closed.filter((item) => selected.has(item.run.id))) {
		try {
			for (const path of resource.worktreePaths) assertResourcePath(resource.worktreeRoot, path);
			for (const path of resource.snapshotPaths) assertResourcePath(store.snapshotsDir, path);
			for (const artifact of resource.artifacts) assertResourcePath(store.artifactsDir, artifact.path);
		} catch (error) {
			report.errors.push({
				runId: resource.run.id,
				message: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		if (!store.reserveClosedRunForRetention(resource.run.id)) continue;
		try {
			for (const path of resource.worktreePaths) {
				await (options.removeWorktree ?? defaultRemoveWorktree)(assertResourcePath(resource.worktreeRoot, path));
			}
			for (const path of resource.snapshotPaths) {
				await rm(assertResourcePath(store.snapshotsDir, path), { recursive: true, force: true });
			}
			const unreferencedArtifacts = [
				...new Set(
					resource.artifacts
						.filter((artifact) => store.countArtifactPathReferences(artifact.path, resource.run.id) === 0)
						.map((artifact) => assertResourcePath(store.artifactsDir, artifact.path)),
				),
			];
			if (!store.deleteReservedRun(resource.run.id)) throw new Error("Reserved run could not be deleted");
			await Promise.all(unreferencedArtifacts.map((path) => rm(path, { force: true })));
			await rmdir(resource.worktreeRoot).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
			});
			report.removedRunIds.push(resource.run.id);
			report.freedArtifactBytes += resource.artifactBytes;
			report.freedSnapshotBytes += resource.snapshotBytes;
			report.freedWorktreeBytes += resource.worktreeBytes;
		} catch (error) {
			store.releaseRetentionRun(resource.run.id);
			report.errors.push({
				runId: resource.run.id,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return report;
}
