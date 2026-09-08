import { type Static, Type } from "typebox";
import type { KernelExecuteStatus } from "./kernel/types.ts";

export const IPYTHON_TOOL_DESCRIPTION = `Execute raw Python with top-level await and fresh locals. Display with print; reuse retained results with refs[id]; preserve selected variables with persist.name and functions with @persist.
Optional first line: # @exec: {"yield_time_ms": 10000, "timeout_ms": 300000}. yield_time_ms (0..60000) bounds this wait only; timeout_ms is the sole execution deadline, including nested/background work.
Running cells yield an id for ipython_wait and continue independently while awaiting tools. await yield_control() returns accumulated output immediately without ending the cell. Other cells may run meanwhile; synchronous Python still blocks the shared interpreter. shell.run(background=True) returns an independent process ID.
Each text return totals at most 16384 UTF-8 bytes. Each call has a unique [ref=r1] for its complete result, even on failure or empty output. Oversized output shows a continuous tail and reports omitted bytes before it. print(refs["r1"]) displays the saved result; await refs["r1"].read() restores its full value. read(span=[start,end]) selects UTF-8 bytes [start,end) of the full display text, never an omitted fragment; selected ranges display from their beginning. Reads never rerun producers.
Await operations. Only marked state persists; temporary locals do not. Persistent functions must not depend on temporary globals. Side effects are not rolled back by cancellation.`;

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
		id: Type.String({ minLength: 1, description: "Cell or background process ID returned by the runtime" }),
		yield_time_ms: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 60000,
				default: 10000,
				description: "Maximum wait for new output or completion; does not stop the task. 0 checks immediately.",
			}),
		),
		terminate: Type.Optional(Type.Boolean({ default: false })),
	},
	{ additionalProperties: false },
);

export const IPYTHON_WAIT_TOOL_METADATA = {
	name: "ipython_wait",
	label: "Python wait",
	description:
		"Wait on a returned cell or background process id. Returns new output or completion. terminate=true cancels that task; waiting never resets its deadline. Each wait has a unique reference to its complete returned increment, not the whole cell history. Text returns share the 16384-byte tail display bound. Use refs for saved results; do not rerun producers.",
	parameters: IPythonWaitSchema,
	executionMode: "sequential",
} as const;

export type IPythonInput = Static<typeof IPythonSchema>;

export const RIEMANN_TOOL_NAMES = [IPYTHON_TOOL_METADATA.name, IPYTHON_WAIT_TOOL_METADATA.name] as const;

export type IPythonActivityStatus = "running" | "ok" | "error";

interface IPythonActivityBase {
	id: string;
	status: IPythonActivityStatus;
	operation: string;
	/** Host operation start time in epoch milliseconds. */
	startedAt?: number;
	durationMs?: number;
	error?: string;
	resultRef?: string;
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
	/** Bounded TUI previews; resultRef points to the complete call result. */
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
	/** Internal task identity for live/replayed UI grouping; never rendered or sent to the model. */
	taskKey?: string;
	/** Cell dispatch time after kernel initialization, in epoch milliseconds. */
	startedAt?: number;
	durationMs?: number;
	errorName?: string;
	errorCode?: string;
	executionCount?: number;
	resultRef?: string;
	truncated?: boolean;
	captureTruncated?: { stdout: boolean; stderr: boolean; rich: boolean };
	media?: Array<{
		type: "image";
		artifactHandle: string;
		mimeType: string;
		byteLength: number;
	}>;
	activities?: IPythonActivity[];
}
