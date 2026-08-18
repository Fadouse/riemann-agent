import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { generateDiffString } from "../core/tools/edit-diff.ts";
import type {
	IPythonActivity,
	IPythonAgentActivity,
	IPythonFileActivity,
	IPythonPatchActivity,
	IPythonShellActivity,
} from "./ipython.ts";
import type { JsonValue, KernelHostRequestEvent } from "./kernel/types.ts";

const MAX_STREAM_CHARS = 20_000;
const MAX_DIFF_INPUT_CHARS = 1_000_000;
const MAX_DIFF_CHARS = 40_000;
const OMITTED_OUTPUT = "[earlier output omitted]\n";

type FileCapabilityPathResolver = (capability: string) => string | undefined;

interface TrackedActivity {
	activity: IPythonActivity;
	before?: string;
}

interface DiffDetails {
	diff?: string;
	additions?: number;
	removals?: number;
	diffTruncated?: boolean;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function booleanValue(value: JsonValue | undefined): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function lineCount(text: string): number {
	if (!text) return 0;
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	return lines.length;
}

function diffDetails(before: string, after: string): DiffDetails {
	if (before === after) return {};
	if (before.length + after.length > MAX_DIFF_INPUT_CHARS) {
		return {
			...(before.length === 0 ? { additions: lineCount(after) } : {}),
			...(after.length === 0 ? { removals: lineCount(before) } : {}),
			diffTruncated: true,
		};
	}
	const generated = generateDiffString(before, after).diff;
	const lines = generated.split("\n");
	const additions = lines.filter((line) => line.startsWith("+")).length;
	const removals = lines.filter((line) => line.startsWith("-")).length;
	if (generated.length <= MAX_DIFF_CHARS) {
		return { diff: generated, additions, removals };
	}
	let consumed = 0;
	const preview: string[] = [];
	for (const line of lines) {
		if (consumed + line.length + 1 > MAX_DIFF_CHARS) break;
		preview.push(line);
		consumed += line.length + 1;
	}
	preview.push("     ... diff truncated");
	return { diff: preview.join("\n"), additions, removals, diffTruncated: true };
}

function quoteArgument(value: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(type: string, args: Record<string, JsonValue>): string {
	if (type === "shell.exec") return stringValue(args.script) ?? "…";
	const command = stringValue(args.command) ?? "…";
	const commandArgs = Array.isArray(args.args)
		? args.args.filter((item): item is string => typeof item === "string")
		: [];
	return [command, ...commandArgs].map(quoteArgument).join(" ");
}

function appendStream(current: string | undefined, delta: string | undefined): string | undefined {
	if (!delta) return current;
	const combined = `${current ?? ""}${delta}`;
	if (combined.length <= MAX_STREAM_CHARS) return combined;
	return `${OMITTED_OUTPUT}${combined.slice(-MAX_STREAM_CHARS)}`;
}

function agentInfo(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
	const direct = objectValue(value);
	if (!direct) return undefined;
	const nested = objectValue(direct.agent);
	return nested ?? direct;
}

/** Converts host-bridge lifecycle events into bounded, display-safe IPython activity details. */
export class RiemannActivityTracker {
	private readonly workspace: string;
	private readonly resolveFileCapability: FileCapabilityPathResolver;
	private readonly tracked = new Map<string, TrackedActivity>();

	constructor(workspace: string, resolveFileCapability: FileCapabilityPathResolver) {
		this.workspace = resolve(workspace);
		this.resolveFileCapability = resolveFileCapability;
	}

	async observe(event: KernelHostRequestEvent): Promise<IPythonActivity[] | undefined> {
		switch (event.phase) {
			case "start": {
				const tracked = await this.start(event.requestId, event.request.type, event.request.args);
				if (!tracked) return undefined;
				this.tracked.set(event.requestId, tracked);
				return this.snapshot();
			}
			case "update": {
				const tracked = this.tracked.get(event.requestId);
				if (!tracked || tracked.activity.kind !== "shell") return undefined;
				const update = objectValue(event.update);
				if (!update) return undefined;
				tracked.activity = {
					...tracked.activity,
					stdout: appendStream(tracked.activity.stdout, stringValue(update.stdout_delta)),
					stderr: appendStream(tracked.activity.stderr, stringValue(update.stderr_delta)),
				};
				return this.snapshot();
			}
			case "end": {
				const tracked = this.tracked.get(event.requestId);
				if (!tracked) return undefined;
				this.finish(tracked, event.result, event.error?.message, event.durationMs);
				return this.snapshot();
			}
		}
	}

	private async start(
		id: string,
		type: string,
		args: Record<string, JsonValue>,
	): Promise<TrackedActivity | undefined> {
		if (type === "shell.run" || type === "shell.exec") {
			const activity: IPythonShellActivity = {
				id,
				kind: "shell",
				status: "running",
				operation: type.slice("shell.".length),
				command: shellCommand(type, args),
				...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
			};
			return { activity };
		}

		if (type.startsWith("agents.")) {
			const operation = type.slice("agents.".length);
			const activity: IPythonAgentActivity = {
				id,
				kind: "agent",
				status: "running",
				operation,
				...(stringValue(args.agent_id) ? { agentId: stringValue(args.agent_id) } : {}),
				...(stringValue(args.name) ? { name: stringValue(args.name) } : {}),
				...(stringValue(args.task) ? { task: stringValue(args.task) } : {}),
				...(stringValue(args.message) ? { message: stringValue(args.message) } : {}),
				...(stringValue(args.profile) ? { profile: stringValue(args.profile) } : {}),
			};
			return { activity };
		}

		if (type === "fs.create") {
			const text = stringValue(args.text) ?? "";
			const activity: IPythonFileActivity = {
				id,
				kind: "file",
				status: "running",
				operation: "create",
				path: this.displayPath(stringValue(args.path) ?? "unknown"),
				...diffDetails("", text),
			};
			return { activity };
		}

		if (type === "fs.edit" || type === "fs.remove") {
			const path = this.snapshotPath(args);
			const before = path ? await this.readWorkspaceFile(path) : undefined;
			if (type === "fs.edit") {
				const activity: IPythonPatchActivity = {
					id,
					kind: "patch",
					status: "running",
					operation: "edit",
					path: this.displayPath(path ?? "unknown"),
				};
				return { activity, before };
			}
			const activity: IPythonFileActivity = {
				id,
				kind: "file",
				status: "running",
				operation: "remove",
				path: this.displayPath(path ?? "unknown"),
				...(before === undefined ? {} : diffDetails(before, "")),
			};
			return { activity, before };
		}

		if (type === "artifacts.materialize") {
			const activity: IPythonFileActivity = {
				id,
				kind: "file",
				status: "running",
				operation: "materialize",
				path: this.displayPath(stringValue(args.path) ?? "unknown"),
			};
			return { activity };
		}
		return undefined;
	}

	private finish(
		tracked: TrackedActivity,
		result: JsonValue | undefined,
		error: string | undefined,
		durationMs: number,
	): void {
		let activity: IPythonActivity = {
			...tracked.activity,
			status: error ? "error" : "ok",
			durationMs,
			...(error ? { error: error.slice(0, 2_000) } : {}),
		};
		if (!error && activity.kind === "shell") {
			const value = objectValue(result);
			const exitCode = value?.exit_code === null ? null : numberValue(value?.exit_code);
			const timedOut = booleanValue(value?.timed_out) ?? false;
			const failed = timedOut || (exitCode !== undefined && exitCode !== null && exitCode !== 0);
			activity = {
				...activity,
				status: failed ? "error" : "ok",
				stdout: stringValue(value?.stdout) ?? activity.stdout,
				stderr: stringValue(value?.stderr) ?? activity.stderr,
				exitCode,
				timedOut,
				...(failed ? { error: timedOut ? "Timed out" : `Exit ${exitCode}` } : {}),
			};
		} else if (!error && activity.kind === "agent") {
			const info = agentInfo(result);
			const agentStatus = stringValue(info?.status);
			const agentOutcome = stringValue(info?.last_outcome);
			activity = {
				...activity,
				...(stringValue(info?.id) ? { agentId: stringValue(info?.id) } : {}),
				...(stringValue(info?.name) ? { name: stringValue(info?.name) } : {}),
				...(agentStatus ? { agentStatus } : activity.operation === "spawn" ? { agentStatus: "running" } : {}),
				...(agentOutcome === "error" ? { status: "error", error: "Agent failed" } : {}),
			};
		} else if (!error && activity.kind === "patch") {
			const value = objectValue(result);
			const after = stringValue(value?.text);
			activity = {
				...activity,
				...(stringValue(value?.path) ? { path: this.displayPath(stringValue(value?.path) ?? activity.path) } : {}),
				...(tracked.before === undefined || after === undefined ? {} : diffDetails(tracked.before, after)),
			};
		} else if (!error && activity.kind === "file") {
			const value = objectValue(result);
			activity = {
				...activity,
				...(stringValue(value?.path) ? { path: this.displayPath(stringValue(value?.path) ?? activity.path) } : {}),
			};
		}
		tracked.activity = activity;
		tracked.before = undefined;
	}

	private snapshotPath(args: Record<string, JsonValue>): string | undefined {
		const snapshot = objectValue(args.snapshot);
		const capability = stringValue(snapshot?.capability);
		return capability ? this.resolveFileCapability(capability) : undefined;
	}

	private async readWorkspaceFile(path: string): Promise<string | undefined> {
		const absolute = resolve(path);
		const fromWorkspace = relative(this.workspace, absolute);
		if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) return undefined;
		try {
			return await readFile(absolute, "utf8");
		} catch {
			return undefined;
		}
	}

	private displayPath(path: string): string {
		const absolute = isAbsolute(path) ? resolve(path) : resolve(this.workspace, path);
		const fromWorkspace = relative(this.workspace, absolute);
		if (fromWorkspace === "") return ".";
		if (fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) return path;
		return fromWorkspace;
	}

	private snapshot(): IPythonActivity[] {
		return [...this.tracked.values()].map(({ activity }) => ({ ...activity }));
	}
}
