import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { RiemannHostError } from "./errors.ts";

/**
 * Resolved per-agent filesystem access policy. `cwd` is only the base for
 * relative paths; the roots and excludes define the actual boundary.
 */
export interface FileAccessPolicy {
	cwd: string;
	readRoots: readonly string[];
	readExcludes: readonly string[];
	writeRoots: readonly string[];
	writeExcludes: readonly string[];
}

/** Fully resolved filesystem configuration stored on an agent row. */
export interface FilesystemSnapshot {
	read: readonly string[];
	readExclude: readonly string[];
	write: readonly string[];
	writeExclude: readonly string[];
}

/** A single filesystem field as written in configuration: an entry list or `inherit`. */
export type FilesystemFieldConfig = string[] | "inherit";

export type FilesystemConfig = {
	read?: FilesystemFieldConfig;
	readExclude?: FilesystemFieldConfig;
	write?: FilesystemFieldConfig;
	writeExclude?: FilesystemFieldConfig;
};

/** Unrestricted filesystem: read and write everywhere with no exclusions. */
export const FULL_FILESYSTEM: FilesystemSnapshot = {
	read: ["/"],
	readExclude: [],
	write: ["/"],
	writeExclude: [],
};

export function isInside(parent: string, child: string): boolean {
	const root = resolve(parent);
	const target = resolve(child);
	return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function canonicalBestEffort(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function expandEntry(entry: string, workspace: string): string {
	if (entry === "~") return homedir();
	if (entry.startsWith("~/") || entry.startsWith("~\\")) return resolve(homedir(), entry.slice(2));
	return resolve(workspace, entry);
}

type FilesystemField = "read" | "readExclude" | "write" | "writeExclude";

const FIELDS: readonly FilesystemField[] = ["read", "readExclude", "write", "writeExclude"];

function modeDefault(mode: "main" | "shared" | "worktree", field: FilesystemField): FilesystemFieldConfig {
	if (mode === "main") return [...FULL_FILESYSTEM[field]];
	if (mode === "worktree" && field === "write") return ["."];
	return "inherit";
}

/**
 * Resolves one agent's filesystem configuration into an absolute snapshot.
 *
 * Per field: profile/defaults value, else the mode default, where `shared`
 * inherits every field from the calling agent and `worktree` inherits
 * everything except `write`, which defaults to the agent's own worktree.
 */
export function resolveFilesystemSnapshot(options: {
	config: FilesystemConfig | undefined;
	mode: "main" | "shared" | "worktree";
	workspace: string;
	parent: FilesystemSnapshot | undefined;
}): FilesystemSnapshot {
	const result: Record<FilesystemField, string[]> = {
		read: [],
		readExclude: [],
		write: [],
		writeExclude: [],
	};
	for (const field of FIELDS) {
		const configured = options.config?.[field];
		const effective = configured === undefined ? modeDefault(options.mode, field) : configured;
		if (effective === "inherit") {
			result[field] = [...(options.parent ?? FULL_FILESYSTEM)[field]];
		} else {
			result[field] = effective.map((entry) => canonicalBestEffort(expandEntry(entry, options.workspace)));
		}
	}
	return result;
}

/** Builds a runtime policy from a stored snapshot, re-canonicalizing roots. */
export function fileAccessPolicy(cwd: string, snapshot: FilesystemSnapshot): FileAccessPolicy {
	const policy = {
		cwd: resolve(cwd),
		readRoots: snapshot.read.map(canonicalBestEffort),
		readExcludes: snapshot.readExclude.map(canonicalBestEffort),
		writeRoots: snapshot.write.map(canonicalBestEffort),
		writeExcludes: snapshot.writeExclude.map(canonicalBestEffort),
	};
	validateFileAccessPolicy(policy);
	return policy;
}

export function policyAllowsRead(policy: FileAccessPolicy, path: string): boolean {
	const target = resolve(path);
	if (policy.readExcludes.some((exclude) => isInside(exclude, target))) return false;
	return policy.readRoots.some((root) => isInside(root, target));
}

export function policyAllowsWrite(policy: FileAccessPolicy, path: string): boolean {
	const target = resolve(path);
	if (!policyAllowsRead(policy, target)) return false;
	if (policy.writeExcludes.some((exclude) => isInside(exclude, target))) return false;
	return policy.writeRoots.some((root) => isInside(root, target));
}

export function assertReadable(policy: FileAccessPolicy, path: string, input: string): void {
	if (!policyAllowsRead(policy, path)) {
		throw new RiemannHostError("permission_denied", `Path is not readable under the filesystem policy: ${input}`);
	}
}

export function assertWritable(policy: FileAccessPolicy, path: string, input: string): void {
	if (!policyAllowsWrite(policy, path)) {
		throw new RiemannHostError("permission_denied", `Path is not writable under the filesystem policy: ${input}`);
	}
}

export function unrestrictedRead(policy: FileAccessPolicy): boolean {
	return policy.readRoots.length === 1 && policy.readRoots[0] === "/" && policy.readExcludes.length === 0;
}

export function unrestrictedWrite(policy: FileAccessPolicy): boolean {
	return (
		policy.writeRoots.length === 1 &&
		policy.writeRoots[0] === "/" &&
		policy.writeExcludes.length === 0 &&
		policy.readExcludes.length === 0
	);
}

function assertPathsExist(paths: readonly string[], label: string): void {
	for (const path of paths) {
		if (!existsSync(path)) throw new Error(`Sandbox ${label} does not exist: ${path}`);
	}
}

/** Validates the invariants required to turn a policy into OS sandbox mounts. */
export function validateFileAccessPolicy(policy: FileAccessPolicy): void {
	assertPathsExist(policy.readRoots, "read root");
	assertPathsExist(policy.readExcludes, "read exclusion");
	assertPathsExist(policy.writeRoots, "write root");
	assertPathsExist(policy.writeExcludes, "write exclusion");

	for (const path of policy.writeRoots) {
		if (!policy.readRoots.some((root) => isInside(root, path))) {
			throw new Error(`Sandbox write root must be covered by a read root: ${path}`);
		}
	}
	for (const path of policy.readExcludes) {
		if (!policy.readRoots.some((root) => isInside(root, path))) {
			throw new Error(`Sandbox read exclusion must be covered by a read root: ${path}`);
		}
	}
	for (const path of policy.writeExcludes) {
		if (!policy.writeRoots.some((root) => isInside(root, path))) {
			throw new Error(`Sandbox write exclusion must be covered by a write root: ${path}`);
		}
	}

	if (!existsSync(policy.cwd)) throw new Error(`Sandbox cwd does not exist: ${policy.cwd}`);
	if (!statSync(policy.cwd).isDirectory()) throw new Error(`Sandbox cwd is not a directory: ${policy.cwd}`);
	const canonicalCwd = realpathSync(policy.cwd);
	if (policy.readExcludes.some((exclude) => isInside(exclude, policy.cwd) || isInside(exclude, canonicalCwd))) {
		throw new Error(`Sandbox cwd is excluded from read access: ${policy.cwd}`);
	}
	if (
		!policy.readRoots.some((root) => isInside(root, policy.cwd)) ||
		!policy.readRoots.some((root) => isInside(root, canonicalCwd))
	) {
		throw new Error(`Sandbox cwd is not readable under the filesystem policy: ${policy.cwd}`);
	}
	try {
		accessSync(policy.cwd, constants.R_OK | constants.X_OK);
	} catch {
		throw new Error(`Sandbox cwd is not readable by the current user: ${policy.cwd}`);
	}
}

function rootsCovered(childRoots: readonly string[], parentRoots: readonly string[]): boolean {
	return childRoots.every((childRoot) => parentRoots.some((parentRoot) => isInside(parentRoot, childRoot)));
}

function excludesCovered(childExcludes: readonly string[], parentExcludes: readonly string[]): boolean {
	return parentExcludes.every((parentExclude) =>
		childExcludes.some((childExclude) => isInside(childExclude, parentExclude)),
	);
}

/**
 * Checks that a child filesystem is a subset of its parent's: every child root
 * must be covered by a parent root and every parent exclusion must stay
 * excluded. Write roots listed in `grantedWriteRoots` (host-provisioned
 * worktrees) are exempt from the parent-coverage requirement.
 */
export function isFilesystemSubset(
	child: FilesystemSnapshot,
	parent: FilesystemSnapshot,
	grantedWriteRoots: readonly string[] = [],
): boolean {
	const ungrantedWrites = child.write.filter(
		(writeRoot) => !grantedWriteRoots.some((granted) => isInside(granted, writeRoot)),
	);
	return (
		rootsCovered(child.read, parent.read) &&
		rootsCovered(ungrantedWrites, parent.write) &&
		excludesCovered(child.readExclude, parent.readExclude) &&
		excludesCovered(child.writeExclude, parent.writeExclude)
	);
}

/** Parses a stored filesystem JSON column, failing loudly on corruption. */
export function parseFilesystemSnapshot(value: string): FilesystemSnapshot {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Stored agent filesystem policy is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Stored agent filesystem policy is not an object");
	}
	const record = parsed as Record<string, unknown>;
	const snapshot: Record<FilesystemField, string[]> = {
		read: [],
		readExclude: [],
		write: [],
		writeExclude: [],
	};
	for (const field of FIELDS) {
		const entries = record[field];
		if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
			throw new Error(`Stored agent filesystem policy has an invalid ${field} list`);
		}
		snapshot[field] = entries as string[];
	}
	return snapshot;
}
