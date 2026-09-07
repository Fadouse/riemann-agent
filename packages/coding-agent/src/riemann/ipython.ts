import { type Static, Type } from "typebox";
import type { KernelExecuteStatus } from "./kernel/types.ts";

export const IPYTHON_TOOL_DESCRIPTION = `Execute Python code with top-level await and the documented Python APIs.
- On grammar-capable transports, send raw Python source, not JSON, quoted strings, or markdown fences. On JSON-only transports, put the same source in code.
- Each call starts with a fresh user namespace. Use store(key, value) / load(key, default=None) for explicit cross-call state, or persist=true to reuse a dedicated namespace. This is namespace isolation, not process or security isolation.
- Emit only the needed output with print(...) or await output.show(value=..., fields=...). Bare expressions do not automatically display results. Images use the documented view methods.
- Optional first line: # @exec: {"yield_time_ms": 10000, "max_output_tokens": 2000, "timeout_ms": 300000, "persist": false}
- yield_time_ms (0..60000, default 10000) limits this tool's wait, not the cell lifetime. timeout_ms (1..86400000, default 300000) is the hard cell deadline; nested shell.run has its own timeout in seconds.
- max_output_tokens (256..16384, default 2000) sets an approximate text budget, additionally capped by host policy.
- A yielded call returns "Script running with cell ID ...". Continue it with ipython_wait; do not rerun its producer. Only one uncollected cell per agent is allowed.
- ipython_wait returns new output only. terminate=true cancels the cell and its host operations; prior filesystem/network side effects are not rolled back.
- Await every operation. Tasks created by a cell are cancelled when it finishes. Runtime state may be lost after forced termination; retained checkpoints and artifact handles are the recovery path.`;

export const IPYTHON_TOOL_PROMPT_SNIPPET = "Execute raw Python; explicit output and optional state, yield with cell ID";

export const IPythonSchema = Type.Object(
	{
		code: Type.String({ description: "Python code. Put every namespace operation here and use top-level await." }),
	},
	{ additionalProperties: false },
);

export const IPYTHON_TOOL_METADATA = {
	name: "ipython",
	label: "IPython",
	description: IPYTHON_TOOL_DESCRIPTION,
	promptSnippet: IPYTHON_TOOL_PROMPT_SNIPPET,
	parameters: IPythonSchema,
	constrainedSampling: {
		type: "grammar",
		variants: { openai_lark: "start: SOURCE\nSOURCE: /[\\s\\S]+/" },
	},
	executionMode: "sequential",
} as const;

export const IPythonWaitSchema = Type.Object(
	{
		cell_id: Type.String({ minLength: 1, description: "Running cell ID returned by ipython" }),
		yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000, default: 10000 })),
		max_tokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 16384, default: 2000 })),
		terminate: Type.Optional(Type.Boolean({ default: false })),
	},
	{ additionalProperties: false },
);

export const IPYTHON_WAIT_TOOL_METADATA = {
	name: "ipython_wait",
	label: "Python wait",
	description:
		"Wait on a yielded ipython cell. Use only a returned cell_id. Returns new output or final completion and closes the completed cell. yield_time_ms does not kill the cell. terminate=true cancels it; false or omitted waits. Unknown or already collected IDs are errors; never rerun the producer merely to retrieve output.",
	parameters: IPythonWaitSchema,
	executionMode: "sequential",
} as const;

export type IPythonInput = Static<typeof IPythonSchema>;

export type IPythonActivityStatus = "running" | "ok" | "error";

interface IPythonActivityBase {
	id: string;
	status: IPythonActivityStatus;
	operation: string;
	/** Host operation start time in epoch milliseconds. */
	startedAt?: number;
	durationMs?: number;
	error?: string;
}

export interface IPythonShellActivity extends IPythonActivityBase {
	kind: "shell";
	command: string;
	cwd?: string;
	stdout?: string;
	stderr?: string;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
	stdoutCaptureTruncated?: boolean;
	stderrCaptureTruncated?: boolean;
	stdoutArtifactHandle?: string;
	stderrArtifactHandle?: string;
	exitCode?: number | null;
	timedOut?: boolean;
}

export interface IPythonAgentActivity extends IPythonActivityBase {
	kind: "agent";
	agentId?: string;
	name?: string;
	task?: string;
	message?: string;
	profile?: string;
	modelRole?: string;
	workspace?: string;
	agentStatus?: string;
	/** Outcome of the exact Turn returned by agents.wait, not the reusable Agent identity. */
	agentOutcome?: "ok" | "error" | "cancelled";
}

export interface IPythonFileActivity extends IPythonActivityBase {
	kind: "file";
	operation: "create" | "remove" | "materialize";
	path: string;
	diff?: string;
	additions?: number;
	removals?: number;
	diffTruncated?: boolean;
}

export interface IPythonPatchActivity extends IPythonActivityBase {
	kind: "patch";
	operation: "edit";
	path: string;
	diff?: string;
	additions?: number;
	removals?: number;
	diffTruncated?: boolean;
}

export interface IPythonExploreActivity extends IPythonActivityBase {
	kind: "explore";
	operation: "read" | "list" | "search";
	target: string;
	query?: string;
}

export interface IPythonMcpActivity extends IPythonActivityBase {
	kind: "mcp";
	/** Registered qualified Python operation, not a guessed server namespace. */
	operation: string;
	/** Bounded host-event previews; omitted tails are marked [truncated]. */
	input?: string;
	output?: string;
}

export type IPythonActivity =
	| IPythonShellActivity
	| IPythonAgentActivity
	| IPythonFileActivity
	| IPythonPatchActivity
	| IPythonExploreActivity
	| IPythonMcpActivity;

export interface IPythonToolDetails {
	status: "running" | KernelExecuteStatus;
	cellId?: string;
	/** Cell dispatch time after kernel initialization, in epoch milliseconds. */
	startedAt?: number;
	durationMs?: number;
	errorName?: string;
	errorCode?: string;
	executionCount?: number;
	moreRef?: string;
	diagnosticRef?: string;
	captureTruncated?: { stdout: boolean; stderr: boolean; rich: boolean };
	media?: Array<{
		type: "image";
		artifactHandle: string;
		mimeType: string;
		byteLength: number;
	}>;
	activities?: IPythonActivity[];
}
