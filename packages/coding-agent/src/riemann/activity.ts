import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { generateDiffString } from "../core/tools/edit-diff.ts";
import { graphemeSafePrefix, graphemeSafeSuffix } from "../utils/text.ts";
import type {
	IPythonActivity,
	IPythonAgentActivity,
	IPythonExploreActivity,
	IPythonFileActivity,
	IPythonMcpActivity,
	IPythonPatchActivity,
	IPythonShellActivity,
} from "./ipython.ts";
import type { JsonValue, KernelHostRequestError, KernelHostRequestEvent } from "./kernel/types.ts";

const MAX_STREAM_CHARS = 20_000;
const MAX_PREVIEW_CHARS = 20_000;
const TRUNCATED_PREVIEW = "\n[truncated]";
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

function lineCount(text: string): number {
	if (!text) return 0;
	let count = text.endsWith("\n") ? 0 : 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
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

function shellCommand(args: Record<string, JsonValue>): string {
	return stringValue(args.script) ?? "…";
}

function appendStream(current: string | undefined, delta: string | undefined): string | undefined {
	if (!delta) return current;
	const combined = `${current ?? ""}${delta}`;
	if (combined.length <= MAX_STREAM_CHARS) return combined;
	return `${OMITTED_OUTPUT}${graphemeSafeSuffix(combined, MAX_STREAM_CHARS)}`;
}

function agentInfo(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
	const direct = objectValue(value);
	if (!direct) return undefined;
	const nested = objectValue(direct.agent);
	return nested ?? direct;
}

function boundedPreview(text: string, limit = MAX_PREVIEW_CHARS): string {
	return text.length <= limit
		? text
		: `${graphemeSafePrefix(text, limit - TRUNCATED_PREVIEW.length)}${TRUNCATED_PREVIEW}`;
}

function mcpOutput(value: JsonValue | undefined): string | undefined {
	const result = objectValue(value);
	if (result?.$riemann !== "mcp_result") return undefined;
	const parts: string[] = [];
	let remaining = MAX_PREVIEW_CHARS;
	let truncated = false;
	const append = (text: string) => {
		if (!text) return;
		if (parts.length > 0) remaining -= 1;
		if (text.length > remaining) {
			parts.push(graphemeSafePrefix(text, Math.max(0, remaining)));
			truncated = true;
			remaining = 0;
		} else {
			parts.push(text);
			remaining -= text.length;
		}
	};
	if (Array.isArray(result.content)) {
		for (const content of result.content) {
			const wrapper = objectValue(content);
			const item = wrapper?.$riemann === "mcp_json" ? objectValue(wrapper.value) : undefined;
			const text =
				item?.type === "text"
					? stringValue(item.text)
					: item?.type === "resource"
						? stringValue(objectValue(item.resource)?.text)
						: undefined;
			if (text !== undefined) append(text);
			if (truncated) break;
		}
	}
	const structured = objectValue(result.structured_content);
	if (
		!truncated &&
		structured?.$riemann === "mcp_json" &&
		structured.value !== null &&
		structured.value !== undefined
	) {
		if (remaining <= 0) truncated = true;
		else append(JSON.stringify(structured.value));
	}
	const output = parts.join("\n");
	return output || truncated ? boundedPreview(`${output}${truncated ? TRUNCATED_PREVIEW : ""}`) : undefined;
}

/** Converts host-bridge lifecycle events into bounded, display-safe IPython activity details. */
export class RiemannActivityTracker {
	private readonly workspace: string;
	private readonly resolveFileCapability: FileCapabilityPathResolver;
	private readonly isMcpOperation?: (operation: string) => boolean;
	private readonly tracked = new Map<string, TrackedActivity>();

	constructor(
		workspace: string,
		resolveFileCapability: FileCapabilityPathResolver,
		isMcpOperation?: (operation: string) => boolean,
	) {
		this.workspace = resolve(workspace);
		this.resolveFileCapability = resolveFileCapability;
		this.isMcpOperation = isMcpOperation;
	}

	async observe(event: KernelHostRequestEvent): Promise<IPythonActivity[] | undefined> {
		switch (event.phase) {
			case "start": {
				const tracked = await this.start(event.requestId, event.request.operation, event.request.arguments);
				if (!tracked) return undefined;
				this.tracked.set(event.requestId, tracked);
				return this.snapshot();
			}
			case "update": {
				const tracked = this.tracked.get(event.requestId);
				if (!tracked || tracked.activity.kind !== "shell") return undefined;
				const update = objectValue(event.update);
				if (!update) return undefined;
				const kind = stringValue(update.kind);
				const value = `${stringValue(update.value) ?? ""}${update.truncated === true ? "\n[stream update truncated]\n" : ""}`;
				tracked.activity = {
					...tracked.activity,
					stdout: kind === "stdout" ? appendStream(tracked.activity.stdout, value) : tracked.activity.stdout,
					stderr: kind === "stderr" ? appendStream(tracked.activity.stderr, value) : tracked.activity.stderr,
				};
				return this.snapshot();
			}
			case "end": {
				const tracked = this.tracked.get(event.requestId);
				if (!tracked) return undefined;
				this.finish(tracked, event.result, event.error, event.durationMs);
				return this.snapshot();
			}
		}
	}

	private async start(
		id: string,
		type: string,
		args: Record<string, JsonValue>,
	): Promise<TrackedActivity | undefined> {
		if (this.isMcpOperation?.(type)) {
			const activity: IPythonMcpActivity = {
				id,
				kind: "mcp",
				status: "running",
				operation: type,
				...(args.input === undefined ? {} : { input: boundedPreview(JSON.stringify(args.input)) }),
			};
			return { activity };
		}

		if (type === "fs.read" || type === "fs.glob" || type === "fs.search") {
			const activity: IPythonExploreActivity = {
				id,
				kind: "explore",
				status: "running",
				operation: type === "fs.read" ? "read" : type === "fs.glob" ? "list" : "search",
				target: boundedPreview(
					type === "fs.read"
						? this.displayPath(stringValue(args.path) ?? "unknown")
						: type === "fs.glob"
							? (stringValue(args.pattern) ?? "unknown")
							: (stringValue(args.glob) ?? "**/*"),
					2_000,
				),
				...(type === "fs.search" && typeof args.query === "string"
					? { query: boundedPreview(args.query, 2_000) }
					: {}),
			};
			return { activity };
		}

		if (type === "shell.run") {
			const activity: IPythonShellActivity = {
				id,
				kind: "shell",
				status: "running",
				operation: type.slice("shell.".length),
				command: shellCommand(args),
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
		error: KernelHostRequestError | undefined,
		durationMs: number,
	): void {
		let activity: IPythonActivity = {
			...tracked.activity,
			status: error ? "error" : "ok",
			durationMs,
			...(error ? { error: graphemeSafePrefix(error.message, 2_000) } : {}),
		};
		if (activity.kind === "mcp") {
			const output = mcpOutput(error ? error.details : result);
			activity = { ...activity, ...(output === undefined ? {} : { output }) };
		} else if (!error && activity.kind === "shell") {
			const value = objectValue(result);
			const exitCode = value?.exit_code === null ? null : numberValue(value?.exit_code);
			const termination = stringValue(value?.termination);
			const timedOut = termination === "timeout";
			const cancelled = termination === "cancelled";
			const failed =
				timedOut ||
				cancelled ||
				termination === "signal" ||
				(exitCode !== undefined && exitCode !== null && exitCode !== 0);
			activity = {
				...activity,
				status: failed ? "error" : "ok",
				stdout: stringValue(value?.stdout) ?? activity.stdout,
				stderr: stringValue(value?.stderr) ?? activity.stderr,
				exitCode,
				timedOut,
				...(failed ? { error: timedOut ? "Timed out" : cancelled ? "Cancelled" : `Exit ${exitCode}` } : {}),
			};
		} else if (!error && activity.kind === "agent") {
			const info = agentInfo(result);
			const agentStatus = stringValue(info?.status);
			const agentOutcome = stringValue(info?.last_outcome);
			activity = {
				...activity,
				...(stringValue(info?.id) ? { agentId: stringValue(info?.id) } : {}),
				...(stringValue(info?.name) ? { name: stringValue(info?.name) } : {}),
				...(agentStatus ? { agentStatus } : activity.operation === "start" ? { agentStatus: "running" } : {}),
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
		const activities = new Array<IPythonActivity>(this.tracked.size);
		let index = 0;
		for (const { activity } of this.tracked.values()) activities[index++] = { ...activity };
		return activities;
	}
}
