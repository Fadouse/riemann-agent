import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Dealer, Subscriber } from "zeromq";
import { signalProcessGroup, spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { policyAllowsRead, policyAllowsWrite } from "../access-policy.ts";
import { RiemannHostError } from "../errors.ts";
import { sandboxedKernelCommand } from "./sandbox.ts";
import type {
	JsonValue,
	JupyterConnectionInfo,
	JupyterMessage,
	KernelDisplay,
	KernelError,
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelExecuteStatus,
	KernelHostRequest,
	KernelHostRequestError,
	KernelHostRequestEvent,
	KernelManagerOptions,
	KernelModelContent,
	KernelRestoreResult,
} from "./types.ts";
import { isKernelHostResult } from "./types.ts";
import { decodeJupyterMessage, encodeJupyterMessage } from "./wire.ts";

const CONNECTION_WAIT_MS = 50;
const SHUTDOWN_GRACE_MS = 1_500;
const INTERRUPT_GRACE_MS = 500;
const HOST_COMM_TARGET = "riemann.host";

interface ActiveExecution {
	id: string;
	startedAt: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	displays: KernelDisplay[];
	result?: KernelDisplay;
	error?: KernelError;
	executionCount?: number;
	status: KernelExecuteStatus;
	idle: boolean;
	replied: boolean;
	settled: boolean;
	resolve: (result: KernelExecuteResult) => void;
	abort?: () => void;
	hostControllers: Set<AbortController>;
	onHostRequest?: KernelExecuteOptions["onHostRequest"];
	outputOrder?: "arrival";
	nextHostSequence: number;
	hostModelContent: Array<{ sequence: number; content: KernelModelContent[] }>;
	hostNotificationQueue: Promise<void>;
	richOutputTruncated: boolean;
	richCaptureTruncated: boolean;
}

function endpoint(info: JupyterConnectionInfo, port: number): string {
	return info.transport === "ipc" ? `ipc://${info.ip}-${port}` : `${info.transport}://${info.ip}:${port}`;
}

function stringField(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberField(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function parseDisplay(message: JupyterMessage): KernelDisplay | undefined {
	const data = message.content.data;
	const metadata = message.content.metadata;
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
	return { data, metadata };
}

function parseError(message: JupyterMessage): KernelError | undefined {
	const ename = stringField(message.content.ename);
	const evalue = stringField(message.content.evalue);
	const traceback = message.content.traceback;
	if (
		!ename ||
		evalue === undefined ||
		!Array.isArray(traceback) ||
		traceback.some((line) => typeof line !== "string")
	) {
		return undefined;
	}
	return { ename, evalue, traceback: traceback as string[] };
}

function parseStructuredError(message: JupyterMessage): KernelError | undefined {
	const value = parseDisplay(message)?.data["application/vnd.riemann.error+json"];
	if (value === undefined) return undefined;
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		typeof value.code !== "string" ||
		!value.code ||
		typeof value.message !== "string"
	) {
		return {
			ename: "RiemannError",
			evalue: "Invalid structured kernel error",
			traceback: [],
			code: "bridge_protocol_error",
		};
	}
	const recovery = value.recovery;
	return {
		ename: "RiemannError",
		evalue: value.message,
		traceback: [],
		code: value.code,
		...(typeof value.operation === "string" ? { operation: value.operation } : {}),
		...(typeof value.repair_code === "string" ? { repairCode: value.repair_code } : {}),
		...(typeof value.request_id === "string" ? { requestId: value.request_id } : {}),
		...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
		...(recovery === "none" ||
		recovery === "retry" ||
		recovery === "refresh" ||
		recovery === "fix_arguments" ||
		recovery === "reauthorize"
			? { recovery }
			: {}),
		...(value.details === undefined ? {} : { details: value.details }),
	};
}

function stripAnsi(value: string): string {
	return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}
function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class IPythonKernelManager {
	private readonly options: KernelManagerOptions;
	private readonly session = randomUUID();
	private process?: ChildProcess;
	private tempDir?: string;
	private connection?: JupyterConnectionInfo;
	private shell?: Dealer;
	private control?: Dealer;
	private iopub?: Subscriber;
	private startup?: Promise<void>;
	private execution?: ActiveExecution;
	private shellLoop?: Promise<void>;
	private controlLoop?: Promise<void>;
	private iopubLoop?: Promise<void>;
	private closed = false;
	private kernelReady = false;
	private incompatibleSnapshot = false;
	private incompatibleSnapshotWarningEmitted = false;
	readonly contractFingerprint: string;

	constructor(options: KernelManagerOptions) {
		this.options = options;
		this.contractFingerprint =
			options.contractFingerprint ?? createHash("sha256").update(options.bootstrapCode).digest("hex");
	}
	private kernelSnapshotPath(): string | undefined {
		if (!this.options.snapshotPath) return undefined;
		if (!this.options.sandbox) return this.options.snapshotPath;
		// A policy that covers the durable snapshot path lets the kernel read and
		// write it directly; otherwise stage through the sandbox temp directory.
		if (
			policyAllowsRead(this.options.sandbox.policy, this.options.snapshotPath) &&
			policyAllowsWrite(this.options.sandbox.policy, this.options.snapshotPath)
		) {
			return this.options.snapshotPath;
		}
		if (!this.tempDir) throw new Error("IPython kernel snapshot staging directory is unavailable");
		return join(this.tempDir, "snapshot.dill");
	}

	private async stageSnapshotForRestore(kernelPath: string): Promise<void> {
		const durablePath = this.options.snapshotPath;
		if (!durablePath || kernelPath === durablePath) return;
		try {
			await copyFile(durablePath, kernelPath);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}

	private async persistStagedSnapshot(kernelPath: string): Promise<void> {
		const durablePath = this.options.snapshotPath;
		if (!durablePath || kernelPath === durablePath) return;
		const temporary = join(dirname(durablePath), `.snapshot-${randomUUID()}.tmp`);
		try {
			await copyFile(kernelPath, temporary);
			const file = await open(temporary, "r");
			try {
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, durablePath);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	async start(): Promise<void> {
		if (this.closed) throw new Error("IPython kernel manager is closed");
		if (this.kernelReady && this.process?.exitCode === null) return;
		this.startup ??= (async () => {
			await this.cleanupKernelResources();
			await this.startKernel();
		})()
			.catch(async (error) => {
				await this.cleanupKernelResources();
				throw error;
			})
			.finally(() => {
				this.startup = undefined;
			});
		return this.startup;
	}

	private signalKernelProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
		if (this.options.sandbox) return signalProcessGroup(child, signal);
		try {
			return child.kill(signal);
		} catch {
			return false;
		}
	}

	private async cleanupKernelResources(): Promise<void> {
		const process = this.process;
		const tempDir = this.tempDir;
		const loops = [this.shellLoop, this.controlLoop, this.iopubLoop].filter(
			(loop): loop is Promise<void> => loop !== undefined,
		);
		this.process = undefined;
		this.tempDir = undefined;
		this.connection = undefined;
		this.kernelReady = false;
		this.shell?.close();
		this.control?.close();
		this.iopub?.close();
		this.shell = undefined;
		this.control = undefined;
		this.iopub = undefined;
		this.shellLoop = undefined;
		this.controlLoop = undefined;
		this.iopubLoop = undefined;
		if (process) {
			this.signalKernelProcess(process, "SIGTERM");
			await Promise.race([waitForChildProcess(process), delay(INTERRUPT_GRACE_MS)]);
			this.signalKernelProcess(process, "SIGKILL");
			if (process.exitCode === null) {
				process.stdout?.destroy();
				process.stderr?.destroy();
			}
			await Promise.race([waitForChildProcess(process), delay(SHUTDOWN_GRACE_MS)]);
		}
		await Promise.allSettled(loops);
		this.options.onProcess?.(undefined);
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}

	private async startKernel(): Promise<void> {
		this.tempDir = await mkdtemp(join(tmpdir(), "riemann-kernel-"));
		if (this.options.snapshotPath) {
			await mkdir(dirname(this.options.snapshotPath), { recursive: true, mode: 0o700 });
		}
		const connectionPath = join(this.tempDir, "connection.json");
		const sandbox = this.options.sandbox;
		const initial: JupyterConnectionInfo = {
			ip: sandbox ? join(this.tempDir, "kernel") : "127.0.0.1",
			transport: sandbox ? "ipc" : "tcp",
			shell_port: 0,
			iopub_port: 0,
			stdin_port: 0,
			control_port: 0,
			hb_port: 0,
			signature_scheme: "hmac-sha256",
			key: randomBytes(32).toString("hex"),
			kernel_name: "python3",
		};
		await writeFile(connectionPath, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
		const pythonArgs = ["-B", "-m", "ipykernel_launcher", "-f", connectionPath];
		const launch = sandbox
			? sandboxedKernelCommand(
					{
						policy: { ...sandbox.policy, cwd: this.options.cwd },
						networkAllowed: sandbox.networkAllowed,
						python: this.options.python,
						connectionDir: this.tempDir,
						platform: sandbox.platform,
						bubblewrapPath: sandbox.bubblewrapPath,
						sandboxExecPath: sandbox.sandboxExecPath,
						environment: this.options.env,
					},
					pythonArgs,
				)
			: {
					command: this.options.python,
					args: pythonArgs,
					env: { ...process.env, ...this.options.env },
				};
		const child = spawnProcess(launch.command, launch.args, {
			cwd: this.options.cwd,
			env: { ...launch.env, PYDEVD_DISABLE_FILE_VALIDATION: "1" },
			detached: "detachedProcessGroup" in launch && launch.detachedProcessGroup,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.process = child;
		this.options.onProcess?.(child);
		let processStderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			processStderr = (processStderr + chunk.toString("utf8")).slice(-16_384);
		});
		const exited = waitForChildProcess(child).then((exitCode) => {
			if (!this.closed && this.process === child) {
				this.kernelReady = false;
				this.failActive(new Error(`IPython kernel exited with code ${exitCode}: ${processStderr.trim()}`));
			}
		});
		const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				await exited;
				throw new Error(`IPython kernel exited during startup: ${processStderr.trim()}`);
			}
			try {
				const parsed: unknown = JSON.parse(await readFile(connectionPath, "utf8"));
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					const info = parsed as JupyterConnectionInfo;
					if (
						[info.shell_port, info.iopub_port, info.control_port].every(
							(port) => Number.isInteger(port) && port > 0,
						)
					) {
						this.connection = info;
						break;
					}
				}
			} catch {
				// ipykernel may be replacing the connection file.
			}
			await delay(CONNECTION_WAIT_MS);
		}
		if (!this.connection) throw new Error("Timed out waiting for IPython connection ports");

		this.shell = new Dealer({ routingId: `riemann-shell-${this.session}` });
		this.control = new Dealer({ routingId: `riemann-control-${this.session}` });
		this.iopub = new Subscriber();
		this.iopub.subscribe();
		this.shell.connect(endpoint(this.connection, this.connection.shell_port));
		this.control.connect(endpoint(this.connection, this.connection.control_port));
		this.iopub.connect(endpoint(this.connection, this.connection.iopub_port));
		this.shellLoop = this.readSocket(this.shell, "shell");
		this.controlLoop = this.readSocket(this.control, "control");
		this.iopubLoop = this.readSocket(this.iopub, "iopub");

		await this.waitForKernel();
		const bootstrap = await this.execute(this.options.bootstrapCode, { internal: true });
		if (bootstrap.status !== "ok")
			throw new Error(`IPython bootstrap failed: ${bootstrap.error?.evalue ?? bootstrap.stderr}`);
		await this.restoreSnapshot();
	}

	private async waitForKernel(): Promise<void> {
		if (!this.shell || !this.connection) throw new Error("Kernel sockets are unavailable");
		const request = encodeJupyterMessage({
			type: "kernel_info_request",
			session: this.session,
			username: this.options.sessionId,
			key: this.connection.key,
		});
		await this.shell.send(request.frames);
		const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
		while (Date.now() < deadline) {
			if (this.kernelReady) return;
			await delay(CONNECTION_WAIT_MS);
		}
		throw new Error("Timed out waiting for IPython kernel_info_reply");
	}

	private async readSocket(socket: Dealer | Subscriber, channel: "shell" | "control" | "iopub"): Promise<void> {
		try {
			for await (const frames of socket) {
				if (!this.connection) continue;
				const message = decodeJupyterMessage(frames as Buffer[], this.connection.key);
				if (message) this.handleMessage(channel, message);
			}
		} catch (error) {
			if (!this.closed) this.failActive(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private handleMessage(channel: "shell" | "control" | "iopub", message: JupyterMessage): void {
		if (message.header.msg_type === "kernel_info_reply") {
			this.kernelReady = true;
			return;
		}
		if (message.header.msg_type === "comm_open" && stringField(message.content.target_name) === HOST_COMM_TARGET) {
			const execution = this.execution?.id === stringField(message.parentHeader.msg_id) ? this.execution : undefined;
			void this.handleHostRequest(channel, message).catch((error: unknown) => {
				if (execution && this.execution === execution) {
					this.failActive(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		}
		const execution = this.execution;
		if (!execution || message.parentHeader.msg_id !== execution.id) return;
		if (message.header.msg_type === "execute_result" || message.header.msg_type === "display_data") {
			const error = parseStructuredError(message);
			if (error) {
				if (execution.status !== "cancelled" && execution.status !== "timeout") {
					execution.status = "error";
					execution.error = {
						...error,
						...(execution.error ? { ename: execution.error.ename, traceback: execution.error.traceback } : {}),
					};
				}
				execution.executionCount ??= numberField(message.content.execution_count);
				return;
			}
		}
		switch (message.header.msg_type) {
			case "stream": {
				const text = stringField(message.content.text) ?? "";
				if (message.content.name === "stderr") {
					if (execution.stderrTruncated) break;
					const output = this.capOutput(execution.stderr, text);
					execution.stderr = output.value;
					execution.stderrTruncated = output.truncated;
				} else {
					if (execution.stdoutTruncated) break;
					const output = this.capOutput(execution.stdout, text);
					execution.stdout = output.value;
					execution.stdoutTruncated = output.truncated;
				}
				break;
			}
			case "display_data": {
				const display = this.boundedDisplay(message);
				if (!display) break;
				if (execution.displays.length < 32) execution.displays.push(display);
				else if (!execution.richOutputTruncated) {
					execution.richOutputTruncated = true;
					execution.richCaptureTruncated = true;
					execution.displays.push({
						data: { "text/plain": "[additional rich output omitted by Riemann Agent]" },
						metadata: {},
					});
				}
				break;
			}
			case "execute_result": {
				execution.result = this.boundedDisplay(message);
				execution.executionCount = numberField(message.content.execution_count);
				break;
			}
			case "error":
				if (execution.status !== "cancelled" && execution.status !== "timeout") {
					const error = parseError(message);
					if (error) execution.error = { ...execution.error, ...error };
					execution.status = "error";
				}
				break;
			case "execute_reply":
				execution.replied = true;
				execution.executionCount ??= numberField(message.content.execution_count);
				if (
					message.content.status === "error" &&
					execution.status !== "cancelled" &&
					execution.status !== "timeout"
				) {
					execution.status = "error";
					const error = parseError(message);
					if (error) execution.error = { ...execution.error, ...error };
				} else if (message.content.status === "aborted" && execution.status === "ok") {
					execution.status = "cancelled";
				}
				this.settleIfComplete(execution);
				break;
			case "status":
				if (message.content.execution_state === "idle") {
					execution.idle = true;
					this.settleIfComplete(execution);
				}
				break;
		}
	}

	private boundedDisplay(message: JupyterMessage): KernelDisplay | undefined {
		const display = parseDisplay(message);
		if (!display) return undefined;
		const cap = Math.max(1, this.options.maxOutputChars ?? 100_000);
		const encoded = JSON.stringify(display.data);
		if (encoded.length <= cap) return display;
		if (this.execution) this.execution.richCaptureTruncated = true;
		const text = display.data["text/plain"];
		if (typeof text === "string") {
			return {
				data: { "text/plain": `${text.slice(0, cap)}\n[rich output truncated by Riemann Agent]` },
				metadata: display.metadata,
			};
		}
		return {
			data: { "text/plain": `[rich output omitted by Riemann Agent; ${encoded.length} encoded characters]` },
			metadata: {},
		};
	}

	private capOutput(value: string, addition: string): { value: string; truncated: boolean } {
		const cap = this.options.maxOutputChars ?? 100_000;
		if (cap >= 0) {
			if (value.length + addition.length <= cap) return { value: value + addition, truncated: false };
			return {
				value: `${value}${addition.slice(0, cap - value.length)}\n[output truncated by Riemann Agent]`,
				truncated: true,
			};
		}
		const combined = value + addition;
		if (combined.length <= cap) return { value: combined, truncated: false };
		return {
			value: `${combined.slice(0, cap)}\n[output truncated by Riemann Agent]`,
			truncated: false,
		};
	}

	private abortHostRequests(execution: ActiveExecution, reason: Error): void {
		for (const controller of execution.hostControllers) controller.abort(reason);
		execution.hostControllers.clear();
	}

	private notifyHostRequest(execution: ActiveExecution, event: KernelHostRequestEvent): Promise<void> {
		const observer = execution.onHostRequest;
		if (!observer) return Promise.resolve();
		const notification = execution.hostNotificationQueue.then(() => observer(event)).catch(() => undefined);
		execution.hostNotificationQueue = notification;
		return notification;
	}

	private settleIfComplete(execution: ActiveExecution): void {
		if (execution.settled || !execution.replied || !execution.idle) return;
		execution.settled = true;
		this.abortHostRequests(execution, new Error("IPython cell finished"));
		execution.abort?.();
		if (this.execution === execution) this.execution = undefined;
		execution.resolve({
			status: execution.status,
			stdout: execution.stdout,
			stderr: execution.stderr,
			...(execution.stdoutTruncated || execution.stderrTruncated || execution.richCaptureTruncated
				? {
						captureTruncated: {
							stdout: execution.stdoutTruncated,
							stderr: execution.stderrTruncated,
							rich: execution.richCaptureTruncated,
						},
					}
				: {}),
			result: execution.result,
			displays: execution.displays,
			modelContent: (execution.outputOrder === "arrival"
				? execution.hostModelContent
				: execution.hostModelContent.slice().sort((left, right) => left.sequence - right.sequence)
			).flatMap((entry) => entry.content),
			error: execution.error,
			executionCount: execution.executionCount,
			durationMs: Date.now() - execution.startedAt,
		});
	}

	private async handleHostRequest(_channel: "shell" | "control" | "iopub", message: JupyterMessage): Promise<void> {
		const commId = stringField(message.content.comm_id);
		if (!commId) return;
		const data = message.content.data;
		const dataRecord = typeof data === "object" && data !== null && !Array.isArray(data) ? data : undefined;
		const suppliedRequestId = dataRecord ? stringField(dataRecord.request_id) : undefined;
		const suppliedOperation = dataRecord ? stringField(dataRecord.operation) : undefined;
		const requestId = suppliedRequestId ?? commId;
		const operation = suppliedOperation ?? "<unknown>";
		const sendReply = async (reply: Record<string, JsonValue>): Promise<void> => {
			const socket = this.control ?? this.shell;
			if (!socket || !this.connection || this.closed) return;
			let response: ReturnType<typeof encodeJupyterMessage>;
			try {
				response = encodeJupyterMessage({
					type: "comm_msg",
					content: { comm_id: commId, data: reply },
					parentHeader: message.header,
					session: this.session,
					username: this.options.sessionId,
					key: this.connection.key,
				});
			} catch (error) {
				const protocolReply: Record<string, JsonValue> = {
					request_id: requestId,
					operation,
					status: "error",
					error: {
						code: "bridge_protocol_error",
						message: `Host produced a value that cannot be encoded: ${errorMessage(error)}`,
						retryable: false,
						recovery: "none",
					},
				};
				response = encodeJupyterMessage({
					type: "comm_msg",
					content: { comm_id: commId, data: protocolReply },
					parentHeader: message.header,
					session: this.session,
					username: this.options.sessionId,
					key: this.connection.key,
				});
			}
			await socket.send(response.frames);
		};
		const protocolError = async (messageText: string): Promise<void> => {
			await sendReply({
				request_id: requestId,
				operation,
				status: "error",
				error: {
					code: "bridge_protocol_error",
					message: messageText,
					retryable: false,
					recovery: "none",
				},
			});
		};
		if (!dataRecord) {
			await protocolError("Host bridge request data must be an object");
			return;
		}
		const requestFields = new Set(["request_id", "operation", "arguments"]);
		if (Object.keys(dataRecord).some((key) => !requestFields.has(key))) {
			await protocolError("Host bridge request contains an unknown field");
			return;
		}
		if (!suppliedRequestId) {
			await protocolError("Host bridge request_id must be a non-empty string");
			return;
		}
		if (!suppliedOperation) {
			await protocolError("Host bridge operation must be a non-empty string");
			return;
		}
		const argumentsValue = dataRecord.arguments;
		if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
			await protocolError("Host bridge arguments must be an object");
			return;
		}

		const execution = this.execution;
		const sequence = execution?.nextHostSequence ?? 0;
		if (execution) execution.nextHostSequence += 1;
		const controller = new AbortController();
		if (!execution || message.parentHeader.msg_id !== execution.id) {
			controller.abort(new Error("The originating IPython cell is no longer active"));
		} else {
			execution.hostControllers.add(controller);
		}
		const request: KernelHostRequest = {
			requestId,
			operation,
			arguments: argumentsValue,
			cellId: stringField(message.parentHeader.msg_id),
		};
		const startedAt = Date.now();
		let reply: Record<string, JsonValue>;
		if (controller.signal.aborted || !execution) {
			reply = {
				request_id: requestId,
				operation,
				status: "error",
				error: {
					code: "cancelled",
					message: "The originating IPython cell is no longer active",
					retryable: false,
					recovery: "none",
				},
			};
		} else {
			await this.notifyHostRequest(execution, { phase: "start", requestId, request, startedAt });
			try {
				const result = await this.options.hostRequest(request, controller.signal, (update) => {
					void this.notifyHostRequest(execution, { phase: "update", requestId, request, update });
				});
				const value = isKernelHostResult(result) ? result.value : result;
				if (isKernelHostResult(result) && result.modelContent.length > 0) {
					execution.hostModelContent.push({ sequence, content: result.modelContent });
				}
				reply = {
					request_id: requestId,
					operation,
					status: "ok",
					value,
				};
				await this.notifyHostRequest(execution, {
					phase: "end",
					requestId,
					request,
					durationMs: Date.now() - startedAt,
					result: value,
				});
			} catch (error) {
				const details =
					error instanceof Error && "details" in error ? (error as { details?: JsonValue }).details : undefined;
				const requestError: KernelHostRequestError = {
					code:
						error instanceof RiemannHostError
							? error.code
							: controller.signal.aborted
								? "cancelled"
								: "internal_error",
					recovery: error instanceof RiemannHostError ? error.recovery : "none",
					message: error instanceof Error ? error.message : String(error),
					operation,
					requestId,
					retryable:
						error instanceof Error && "retryable" in error
							? (error as { retryable?: unknown }).retryable === true
							: false,
					...(details === undefined ? {} : { details }),
				};
				reply = {
					request_id: requestId,
					operation,
					status: "error",
					error: {
						code: requestError.code,
						message: requestError.message,
						retryable: requestError.retryable,
						recovery: requestError.recovery ?? "none",
						...(requestError.details === undefined ? {} : { details: requestError.details }),
					},
				};
				await this.notifyHostRequest(execution, {
					phase: "end",
					requestId,
					request,
					durationMs: Date.now() - startedAt,
					error: requestError,
				});
			} finally {
				execution.hostControllers.delete(controller);
			}
		}
		await sendReply(reply);
	}

	async execute(code: string, options: KernelExecuteOptions = {}): Promise<KernelExecuteResult> {
		if (!options.internal) await this.start();
		if (!this.shell || !this.connection) throw new Error("IPython kernel is unavailable");
		if (this.execution) throw new Error("IPython kernel is already executing a cell");
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Operation aborted");
		const request = encodeJupyterMessage({
			type: "execute_request",
			content: {
				code,
				silent: false,
				store_history: !options.internal,
				user_expressions: {},
				allow_stdin: false,
				stop_on_error: true,
			},
			session: this.session,
			username: this.options.sessionId,
			key: this.connection.key,
		});
		let resolveExecution!: ActiveExecution["resolve"];
		const promise = new Promise<KernelExecuteResult>((resolve) => {
			resolveExecution = resolve;
		});
		const execution: ActiveExecution = {
			id: request.id,
			startedAt: Date.now(),
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			displays: [],
			status: "ok",
			idle: false,
			replied: false,
			settled: false,
			resolve: resolveExecution,
			hostControllers: new Set(),
			onHostRequest: options.onHostRequest,
			outputOrder: options.outputOrder,
			nextHostSequence: 0,
			hostModelContent: [],
			hostNotificationQueue: Promise.resolve(),
			richOutputTruncated: false,
			richCaptureTruncated: false,
		};
		this.execution = execution;
		try {
			await this.shell.send(request.frames);
		} catch (error) {
			this.failActive(error instanceof Error ? error : new Error(String(error)));
		}
		if (options.signal && !execution.settled) {
			const onAbort = () => {
				const reason = options.signal?.reason;
				execution.status = reason instanceof Error && reason.name === "TimeoutError" ? "timeout" : "cancelled";
				void this.interrupt().catch(() => undefined);
			};
			options.signal.addEventListener("abort", onAbort, { once: true });
			execution.abort = () => options.signal?.removeEventListener("abort", onAbort);
			if (options.signal.aborted) onAbort();
		}
		return promise;
	}

	/** Retained output only; no execution or automatic representation of user variables. */
	peek(): KernelExecuteResult | undefined {
		const execution = this.execution;
		if (!execution) return undefined;
		return {
			status: execution.status,
			stdout: execution.stdout,
			stderr: execution.stderr,
			displays: [...execution.displays],
			modelContent: execution.hostModelContent.flatMap((entry) => entry.content),
			durationMs: Date.now() - execution.startedAt,
		};
	}

	async interrupt(): Promise<void> {
		const execution = this.execution;
		if (!execution) return;
		if (execution.status === "ok") execution.status = "cancelled";
		this.abortHostRequests(execution, new Error("IPython cell interrupted"));
		if (this.control && this.connection) {
			const request = encodeJupyterMessage({
				type: "interrupt_request",
				session: this.session,
				username: this.options.sessionId,
				key: this.connection.key,
			});
			await this.control.send(request.frames).catch(() => undefined);
		}
		await delay(INTERRUPT_GRACE_MS);
		if (this.execution !== execution || execution.settled) return;
		this.kernelReady = false;
		const process = this.process;
		if (process) {
			this.signalKernelProcess(process, "SIGTERM");
			await delay(INTERRUPT_GRACE_MS);
			this.signalKernelProcess(process, "SIGKILL");
		}
		execution.replied = true;
		execution.idle = true;
		this.settleIfComplete(execution);
	}

	private failActive(error: Error): void {
		const execution = this.execution;
		if (!execution || execution.settled) return;
		if (execution.status !== "cancelled" && execution.status !== "timeout") {
			execution.error = { ename: error.name, evalue: error.message, traceback: [] };
			execution.status = "error";
		}
		execution.replied = true;
		execution.idle = true;
		this.settleIfComplete(execution);
	}

	private parseSnapshotResult(result: KernelExecuteResult): KernelRestoreResult {
		const marker = "__RIEMANN_SNAPSHOT__";
		const stdoutLines = result.stdout.split(/\r?\n/);
		let line: string | undefined;
		for (let index = stdoutLines.length - 1; index >= 0; index -= 1) {
			const candidate = stdoutLines[index];
			if (candidate?.startsWith(marker)) {
				line = candidate;
				break;
			}
		}
		if (!line) {
			return {
				restored: [],
				skipped: [],
				error: stripAnsi(result.error?.evalue || result.stderr.trim() || "Snapshot operation returned no result"),
			};
		}
		try {
			const value: unknown = JSON.parse(line.slice(marker.length));
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error("snapshot result must be an object");
			}
			const restored = "restored" in value ? value.restored : undefined;
			const skipped = "skipped" in value ? value.skipped : undefined;
			const error = "error" in value ? value.error : undefined;
			if (!Array.isArray(restored) || restored.some((name) => typeof name !== "string") || !Array.isArray(skipped)) {
				throw new Error("snapshot result has invalid restored or skipped fields");
			}
			const parsedSkipped: Array<{ name: string; reason: string }> = [];
			for (const item of skipped) {
				if (
					typeof item !== "object" ||
					item === null ||
					Array.isArray(item) ||
					!("name" in item) ||
					typeof item.name !== "string" ||
					!("reason" in item) ||
					typeof item.reason !== "string"
				) {
					throw new Error("snapshot result contains an invalid skipped entry");
				}
				parsedSkipped.push({ name: item.name, reason: item.reason });
			}
			if (error !== undefined && typeof error !== "string")
				throw new Error("snapshot result error must be a string");
			return {
				restored: restored as string[],
				skipped: parsedSkipped,
				...(error ? { error } : {}),
				...("incompatible" in value && value.incompatible === true ? { incompatible: true } : {}),
			};
		} catch (error) {
			return {
				restored: [],
				skipped: [],
				error: `Could not parse snapshot result: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	private async restoreSnapshot(): Promise<void> {
		const kernelPath = this.kernelSnapshotPath();
		if (!kernelPath) return;
		try {
			await this.stageSnapshotForRestore(kernelPath);
		} catch (error) {
			this.options.onRestore?.({
				restored: [],
				skipped: [],
				error: `Could not stage snapshot for restore: ${errorMessage(error)}`,
			});
			return;
		}
		const escapedPath = JSON.stringify(kernelPath);
		const result = await this.execute(
			`import json as _riemann_json
# Keep loaded values local so deleting a restored binding can release its object graph.
def _riemann_restore_snapshot(path, namespace):
    import dill, pathlib
    restored = {"restored": [], "skipped": []}
    snapshot_path = pathlib.Path(path)
    if snapshot_path.exists():
        try:
            with snapshot_path.open("rb") as file:
                expected = ${JSON.stringify(`RIEMANN-CHECKPOINT ${this.contractFingerprint}\n`)}.encode("ascii")
                if file.read(len(expected)) != expected:
                    return {"restored": [], "skipped": [], "incompatible": True, "error": "Incompatible checkpoint contract; original file retained. Archive it before creating a new checkpoint."}
                values = dill.load(file)
            for name, value in values.items():
                if name == "riemann_code_state" and "_riemann_restore_code_state" in namespace:
                    value = namespace["_riemann_restore_code_state"](value)
                namespace[name] = value
                restored["restored"].append(name)
        except Exception as error:
            restored["error"] = f"{type(error).__name__}: {error}"
    return restored
try:
    print("__RIEMANN_SNAPSHOT__" + _riemann_json.dumps(_riemann_restore_snapshot(${escapedPath}, globals()), sort_keys=True))
finally:
    del _riemann_restore_snapshot`,
			{ internal: true, signal: AbortSignal.timeout(30_000) },
		);
		const restored = this.parseSnapshotResult(result);
		this.incompatibleSnapshot = restored.incompatible === true;
		if (!this.incompatibleSnapshot) this.incompatibleSnapshotWarningEmitted = false;
		this.options.onRestore?.(restored);
	}

	async snapshot(signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<KernelRestoreResult> {
		const kernelPath = this.kernelSnapshotPath();
		if (!kernelPath) return { restored: [], skipped: [], error: "Snapshots are disabled" };
		if (this.incompatibleSnapshot) {
			const warned = this.incompatibleSnapshotWarningEmitted;
			this.incompatibleSnapshotWarningEmitted = true;
			return {
				restored: [],
				skipped: [],
				incompatible: true,
				...(warned
					? {}
					: { error: "Incompatible checkpoint retained; archive it and restart the kernel before saving." }),
			};
		}
		if (!this.kernelReady || this.process?.exitCode !== null)
			return { restored: [], skipped: [], error: "Cannot snapshot while an IPython kernel restart is pending" };
		if (this.execution)
			return { restored: [], skipped: [], error: "Cannot snapshot while an IPython cell is running" };
		const escapedPath = JSON.stringify(kernelPath);
		const code = `import json as _riemann_json
# A function scope releases checkpoint-only references after serialization.
def _riemann_write_snapshot(path, namespace):
    import builtins, dill, os, pathlib, tempfile
    snapshot_path = pathlib.Path(path)
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    candidates, values, skipped = {}, {}, []
    reserved = {"In", "Out", "get_ipython", "exit", "quit"} | set(namespace.get("_RIEMANN_PROTECTED", set()))
    for name, value in list(namespace.items()):
        if name.startswith("_") or name in reserved or isinstance(value, type(builtins)):
            continue
        if name == "riemann_code_state" and "_riemann_snapshot_code_state" in namespace:
            value, code_skipped = namespace["_riemann_snapshot_code_state"](value)
            skipped.extend(code_skipped)
        candidates[name] = value
    fd, temporary = tempfile.mkstemp(dir=str(snapshot_path.parent), prefix=".snapshot-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as file:
            header = ${JSON.stringify(`RIEMANN-CHECKPOINT ${this.contractFingerprint}\n`)}.encode("ascii")
            file.write(header)
            try:
                dill.dump(candidates, file)
                values = candidates
            except Exception:
                file.seek(len(header))
                file.truncate()
                for name, value in candidates.items():
                    try:
                        dill.dumps(value)
                        values[name] = value
                    except Exception as error:
                        skipped.append({"name": name, "reason": f"{type(error).__name__}: {error}"})
                dill.dump(values, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, snapshot_path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    return {"restored": sorted(values), "skipped": skipped}
try:
    print("__RIEMANN_SNAPSHOT__" + _riemann_json.dumps(_riemann_write_snapshot(${escapedPath}, globals()), sort_keys=True))
finally:
    del _riemann_write_snapshot`;
		const result = await this.execute(code, { internal: true, signal });
		if (result.status !== "ok") return { restored: [], skipped: [], error: result.error?.evalue ?? result.stderr };
		const parsed = this.parseSnapshotResult(result);
		try {
			await this.persistStagedSnapshot(kernelPath);
		} catch (error) {
			return { ...parsed, error: `Could not persist snapshot: ${errorMessage(error)}` };
		}
		return parsed;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.failActive(new Error("IPython kernel closed"));
		if (this.control && this.connection) {
			const request = encodeJupyterMessage({
				type: "shutdown_request",
				content: { restart: false },
				session: this.session,
				username: this.options.sessionId,
				key: this.connection.key,
			});
			await this.control.send(request.frames).catch(() => undefined);
		}
		await Promise.race([
			this.process ? waitForChildProcess(this.process) : Promise.resolve(),
			delay(SHUTDOWN_GRACE_MS),
		]);
		await this.cleanupKernelResources();
	}
}
