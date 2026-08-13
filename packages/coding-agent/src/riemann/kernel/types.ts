import type { ChildProcess } from "node:child_process";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JupyterConnectionInfo {
	ip: string;
	transport: "tcp" | "ipc";
	shell_port: number;
	iopub_port: number;
	stdin_port: number;
	control_port: number;
	hb_port: number;
	signature_scheme: "hmac-sha256";
	key: string;
	kernel_name: string;
}

export interface JupyterHeader {
	msg_id: string;
	username: string;
	session: string;
	date: string;
	msg_type: string;
	version: string;
}

export interface JupyterMessage {
	identities: Buffer[];
	header: JupyterHeader;
	parentHeader: Partial<JupyterHeader>;
	metadata: Record<string, JsonValue>;
	content: Record<string, JsonValue>;
	buffers: Buffer[];
}

export interface KernelDisplay {
	data: Record<string, JsonValue>;
	metadata: Record<string, JsonValue>;
}

export interface KernelError {
	ename: string;
	evalue: string;
	traceback: string[];
}

export interface KernelExecuteResult {
	status: "ok" | "error" | "aborted";
	stdout: string;
	stderr: string;
	result?: KernelDisplay;
	displays: KernelDisplay[];
	error?: KernelError;
	executionCount?: number;
	durationMs: number;
}

export interface KernelHostRequest {
	type: string;
	args: Record<string, JsonValue>;
	cellId?: string;
}

export interface KernelHostRequestError {
	code: string;
	message: string;
	details?: JsonValue;
}

export type KernelHostRequestEvent =
	| {
			phase: "start";
			requestId: string;
			request: KernelHostRequest;
			startedAt: number;
	  }
	| {
			phase: "update";
			requestId: string;
			request: KernelHostRequest;
			update: JsonValue;
	  }
	| {
			phase: "end";
			requestId: string;
			request: KernelHostRequest;
			durationMs: number;
			result?: JsonValue;
			error?: KernelHostRequestError;
	  };

export type KernelHostRequestObserver = (event: KernelHostRequestEvent) => void | Promise<void>;
export type KernelHostRequestUpdate = (update: JsonValue) => void;

export interface KernelExecuteOptions {
	signal?: AbortSignal;
	internal?: boolean;
	onHostRequest?: KernelHostRequestObserver;
}

export type KernelHostRequestHandler = (
	request: KernelHostRequest,
	signal: AbortSignal,
	onUpdate?: KernelHostRequestUpdate,
) => Promise<JsonValue>;

export interface KernelSandboxConfiguration {
	agentDir: string;
	workspaceWritable: boolean;
	platform?: NodeJS.Platform;
	bubblewrapPath?: string;
	sandboxExecPath?: string;
}

export interface KernelManagerOptions {
	python: string;
	cwd: string;
	env?: Record<string, string>;
	sessionId: string;
	bootstrapCode: string;
	sandbox: KernelSandboxConfiguration | false;
	hostRequest: KernelHostRequestHandler;
	snapshotPath?: string;
	startupTimeoutMs?: number;
	maxOutputChars?: number;
	onProcess?: (process: ChildProcess | undefined) => void;
	onRestore?: (result: KernelRestoreResult) => void;
}

export interface KernelRestoreResult {
	restored: string[];
	skipped: Array<{ name: string; reason: string }>;
	error?: string;
}
