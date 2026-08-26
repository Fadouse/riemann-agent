import { type Static, Type } from "typebox";
import type { KernelExecuteStatus } from "./kernel/types.ts";

export const IPYTHON_TOOL_DESCRIPTION =
	"The only valid model tool-call name is ipython. Execute every documented Python API inside its code field.";

export const IPYTHON_TOOL_PROMPT_SNIPPET = "The only model tool; execute persistent Python";

export const IPythonSchema = Type.Object(
	{
		code: Type.String({ description: "Python code. Put every namespace operation here and use top-level await." }),
		timeout: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 86_400, default: 300, description: "Cell timeout in seconds" }),
		),
	},
	{ additionalProperties: false },
);

export const IPYTHON_TOOL_METADATA = {
	name: "ipython",
	label: "IPython",
	description: IPYTHON_TOOL_DESCRIPTION,
	promptSnippet: IPYTHON_TOOL_PROMPT_SNIPPET,
	parameters: IPythonSchema,
	executionMode: "sequential",
} as const;

export type IPythonInput = Static<typeof IPythonSchema>;

export type IPythonActivityStatus = "running" | "ok" | "error";

interface IPythonActivityBase {
	id: string;
	status: IPythonActivityStatus;
	operation: string;
	durationMs?: number;
	error?: string;
}

export interface IPythonShellActivity extends IPythonActivityBase {
	kind: "shell";
	command: string;
	cwd?: string;
	stdout?: string;
	stderr?: string;
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

export type IPythonActivity = IPythonShellActivity | IPythonAgentActivity | IPythonFileActivity | IPythonPatchActivity;

export interface IPythonToolDetails {
	status: "running" | KernelExecuteStatus;
	durationMs?: number;
	errorName?: string;
	executionCount?: number;
	artifactHandle?: string;
	media?: Array<{
		type: "image";
		artifactHandle: string;
		mimeType: string;
		byteLength: number;
	}>;
	activities?: IPythonActivity[];
}
