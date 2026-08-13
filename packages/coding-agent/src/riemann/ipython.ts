import { type Static, Type } from "typebox";

export const IPYTHON_TOOL_DESCRIPTION =
	"Execute Python in a persistent IPython environment. The operation namespaces listed in the system prompt are preinstalled globals; calls can be assigned and composed with top-level await. Variables persist across executions.";

export const IPYTHON_TOOL_PROMPT_SNIPPET = "Run persistent Python for state and operation orchestration";

export const IPythonSchema = Type.Object(
	{
		code: Type.String({
			description:
				"Python code to execute. For independent async operations, import asyncio and use await asyncio.gather(...). Assign large results and display only the needed slice.",
		}),
		timeout: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 86_400, description: "Cell timeout in seconds. Default 300." }),
		),
	},
	{ additionalProperties: false },
);

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
	status: "running" | "ok" | "error" | "aborted";
	durationMs?: number;
	errorName?: string;
	executionCount?: number;
	artifactHandle?: string;
	activities?: IPythonActivity[];
}
