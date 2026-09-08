import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { Type } from "typebox";
import { signalProcessGroup, spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { getShellConfig } from "../../utils/shell.ts";
import { assertReadable, type FileAccessPolicy } from "../access-policy.ts";
import { RiemannActivityTracker } from "../activity.ts";
import { PythonCells } from "../code-mode.ts";
import { RiemannHostError } from "../errors.ts";
import { remainingExecutionMs } from "../execution.ts";
import { resolveSandboxExecutable, type SandboxedCommand, sandboxedKernelCommand } from "../kernel/sandbox.ts";
import type { JsonValue, KernelExecuteResult } from "../kernel/types.ts";
import type { ArtifactStore } from "../state/artifacts.ts";
import type { FunctionDefinition, FunctionUpdateCallback } from "./registry.ts";

const STREAM_UPDATE_INTERVAL_MS = 80;

type StreamKind = "stdout" | "stderr";
type ProcessTermination = "exited" | "timeout" | "cancelled" | "signal";

interface PendingStreamUpdate {
	kind: StreamKind;
	chunks: Buffer[];
}

const ArtifactSchema = Type.Object(
	{
		$riemann: Type.Literal("artifact"),
		handle: Type.String(),
		mime_type: Type.String(),
		size: Type.Integer({ minimum: 0 }),
		name: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false, $id: "Ref" },
);

const ProcessResultSchema = Type.Object(
	{
		$riemann: Type.Literal("process_result"),
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		stdout: ArtifactSchema,
		stderr: ArtifactSchema,
		duration_ms: Type.Integer({ minimum: 0 }),
		termination: Type.Union([
			Type.Literal("exited"),
			Type.Literal("timeout"),
			Type.Literal("cancelled"),
			Type.Literal("signal"),
		]),
		stdout_capture_truncated: Type.Boolean(),
		stderr_capture_truncated: Type.Boolean(),
	},
	{ additionalProperties: false, $id: "ProcessResult" },
);
const ProcessHandleSchema = Type.Object(
	{ $riemann: Type.Literal("process_handle"), id: Type.String() },
	{ additionalProperties: false, $id: "ProcessHandle" },
);

function requiredString(args: Record<string, JsonValue>, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || value.length === 0)
		throw new RiemannHostError("invalid_arguments", `${name} must be a non-empty string`);
	return value;
}

function parseEnvironment(value: JsonValue | undefined): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value))
		throw new RiemannHostError("invalid_arguments", "env must be a string dictionary");
	const environment: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") throw new RiemannHostError("invalid_arguments", `env.${key} must be a string`);
		environment[key] = item;
	}
	return environment;
}

export class ShellFunctions {
	private readonly policy: FileAccessPolicy;
	private readonly artifacts: ArtifactStore;
	readonly tasks = new PythonCells("p");
	private readonly networkAllowed: boolean;

	constructor(policy: FileAccessPolicy, artifacts: ArtifactStore, networkAllowed: boolean) {
		this.policy = policy;
		this.artifacts = artifacts;
		this.networkAllowed = networkAllowed;
	}

	private async resolveCwd(value: JsonValue | undefined): Promise<string> {
		const input = value === undefined || value === null ? this.policy.cwd : value;
		if (typeof input !== "string" || input.length === 0) {
			throw new RiemannHostError("invalid_arguments", "cwd must be a non-empty string");
		}
		const candidate = resolve(this.policy.cwd, input);
		assertReadable(this.policy, candidate, input);
		try {
			const cwd = await realpath(candidate);
			assertReadable(this.policy, cwd, input);
			if (!(await stat(cwd)).isDirectory()) {
				throw new RiemannHostError("invalid_arguments", `cwd is not a directory: ${input}`);
			}
			return cwd;
		} catch (error) {
			if (error instanceof RiemannHostError) throw error;
			throw new RiemannHostError("invalid_arguments", `cwd is unavailable: ${input}`);
		}
	}

	private async run(
		command: { executable: string; args: string[]; stdin?: string },
		options: {
			cwd: string;
			env: Record<string, string>;
			signal: AbortSignal;
			onUpdate?: FunctionUpdateCallback;
		},
	): Promise<JsonValue> {
		if (options.signal.aborted)
			throw new RiemannHostError("cancelled", "Shell execution was cancelled before launch");
		const started = Date.now();
		const executable = resolveSandboxExecutable(
			command.executable,
			options.cwd,
			options.env.PATH ?? process.env.PATH,
		);
		if (!executable) {
			const stderr = `${command.executable}: command not found\n`;
			return {
				$riemann: "process_result",
				exit_code: 127,
				stdout: await this.artifacts.putText("", { name: "stdout" }),
				stderr: await this.artifacts.putText(stderr, { name: "stderr" }),
				duration_ms: Date.now() - started,
				termination: "exited",
				stdout_capture_truncated: false,
				stderr_capture_truncated: false,
			};
		}
		const sandboxDir = await mkdtemp(join(tmpdir(), "riemann-shell-"));
		let launch: SandboxedCommand;
		try {
			if (options.signal.aborted)
				throw new RiemannHostError("cancelled", "Shell execution was cancelled before launch");
			launch = sandboxedKernelCommand(
				{
					policy: { ...this.policy, cwd: options.cwd },
					networkAllowed: this.networkAllowed,
					python: executable,
					connectionDir: sandboxDir,
					environment: options.env,
				},
				command.args,
			);
		} catch (error) {
			await rm(sandboxDir, { recursive: true, force: true });
			throw error;
		}
		const child = spawnProcess(launch.command, launch.args, {
			cwd: options.cwd,
			env: launch.env,
			detached: launch.detachedProcessGroup,
			stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (command.stdin !== undefined && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(command.stdin);
		}
		let pendingUpdates: PendingStreamUpdate[] = [];
		let updateTimer: NodeJS.Timeout | undefined;
		let updateSequence = 0;
		const stdoutUpdateDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
		const stderrUpdateDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
		const emitUpdate = (kind: StreamKind, value: string, truncated: boolean): void => {
			if (!options.onUpdate || (!value && !truncated)) return;
			options.onUpdate({ sequence: updateSequence, kind, value, truncated });
			updateSequence += 1;
		};
		const flushUpdates = (): void => {
			for (const update of pendingUpdates) {
				const decoder = update.kind === "stdout" ? stdoutUpdateDecoder : stderrUpdateDecoder;
				const value = decoder.decode(Buffer.concat(update.chunks), {
					stream: true,
				});
				emitUpdate(update.kind, value, false);
			}
			pendingUpdates = [];
		};
		const finishUpdates = (): void => {
			flushUpdates();
			emitUpdate("stdout", stdoutUpdateDecoder.decode(), false);
			emitUpdate("stderr", stderrUpdateDecoder.decode(), false);
		};
		const scheduleUpdate = (): void => {
			if (!options.onUpdate || updateTimer) return;
			updateTimer = setTimeout(() => {
				updateTimer = undefined;
				flushUpdates();
			}, STREAM_UPDATE_INTERVAL_MS);
		};
		const queueUpdate = (kind: StreamKind, chunk: Buffer): void => {
			if (!options.onUpdate) return;
			let update = pendingUpdates.at(-1);
			if (!update || update.kind !== kind) {
				update = { kind, chunks: [] };
				pendingUpdates.push(update);
			}
			update.chunks.push(chunk);
			scheduleUpdate();
		};
		let requestedTermination: "timeout" | "cancelled" | null = null;
		let forceKill: NodeJS.Timeout | undefined;
		const terminate = (reason: "timeout" | "cancelled") => {
			if (requestedTermination !== null || !signalProcessGroup(child, "SIGTERM")) return;
			requestedTermination = reason;
			forceKill = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 2_000);
		};
		const onAbort = () => terminate(options.signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
		options.signal.addEventListener("abort", onAbort, { once: true });
		async function* capture(stream: Readable | null, kind: StreamKind): AsyncGenerator<Uint8Array> {
			if (!stream) return;
			for await (const value of stream) {
				const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
				queueUpdate(kind, chunk);
				yield chunk;
			}
		}
		const captured = Promise.allSettled(
			[
				this.artifacts.putStream(capture(child.stdout, "stdout"), {
					name: "stdout",
					mimeType: "application/octet-stream",
					detectText: true,
				}),
				this.artifacts.putStream(capture(child.stderr, "stderr"), {
					name: "stderr",
					mimeType: "application/octet-stream",
					detectText: true,
				}),
			].map((stream) =>
				stream.catch((error: unknown) => {
					terminate("cancelled");
					throw error;
				}),
			),
		);
		if (options.signal.aborted) onAbort();
		let exitCode: number | null = null;
		let processError: unknown;
		try {
			exitCode = await waitForChildProcess(child);
		} catch (error) {
			processError = error;
			terminate("cancelled");
		} finally {
			if (forceKill) {
				clearTimeout(forceKill);
				signalProcessGroup(child, "SIGKILL");
			}
			options.signal.removeEventListener("abort", onAbort);
			await rm(sandboxDir, { recursive: true, force: true });
		}
		const streams = await captured;
		if (updateTimer) clearTimeout(updateTimer);
		finishUpdates();
		const failure = streams.find((stream) => stream.status === "rejected");
		if (failure || processError) {
			const error: unknown = failure?.reason ?? processError;
			throw new RiemannHostError(failure ? "artifact_error" : "execution_error", String(error), {
				streams: streams.map((stream) =>
					stream.status === "fulfilled"
						? stream.value
						: {
								error: String(stream.reason),
								details: stream.reason instanceof RiemannHostError ? (stream.reason.details ?? null) : null,
							},
				),
			});
		}
		const stdoutArtifact = streams[0].status === "fulfilled" ? streams[0].value : null;
		const stderrArtifact = streams[1].status === "fulfilled" ? streams[1].value : null;

		const termination: ProcessTermination = requestedTermination ?? (child.signalCode === null ? "exited" : "signal");
		return {
			$riemann: "process_result",
			exit_code: exitCode,
			stdout: stdoutArtifact,
			stderr: stderrArtifact,
			duration_ms: Date.now() - started,
			termination,
			stdout_capture_truncated: false,
			stderr_capture_truncated: false,
		};
	}

	definitions(): FunctionDefinition[] {
		const cwdDescription =
			"Working directory; relative paths resolve from the current working directory and absolute host paths are allowed";
		return [
			{
				name: "run",
				namespace: "shell",
				description: "Run a shell script and return a structured ProcessResult.",
				inputSchema: Type.Object(
					{
						background: Type.Optional(
							Type.Boolean({
								default: false,
								description: "Return a background process handle without occupying the Python cell",
							}),
						),
						script: Type.String({
							minLength: 1,
							description: "Shell script source",
						}),
						cwd: Type.Optional(
							Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
								description: cwdDescription,
							}),
						),
						env: Type.Optional(
							Type.Union([Type.Object({}, { additionalProperties: Type.String() }), Type.Null()], {
								description: "Additional environment variables",
							}),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: Type.Union([ProcessResultSchema, ProcessHandleSchema]),
				updateSchema: Type.Object(
					{
						sequence: Type.Integer({ minimum: 0 }),
						kind: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
						value: Type.String(),
						truncated: Type.Boolean(),
					},
					{ additionalProperties: false },
				),
				pythonReturnType: "ProcessResult | ProcessHandle",
				errors: [
					{
						code: "limit_exceeded",
						description: "The run has exhausted its resource reference numbers.",
						retryable: false,
					},
					{ code: "cancelled", description: "Cancelled before process launch.", retryable: false },
					{
						code: "invalid_arguments",
						description: "The script or execution options are invalid.",
						retryable: false,
					},
					{
						code: "permission_denied",
						description: "The working directory is not readable.",
						retryable: false,
					},
				],
				effects: [
					{ kind: "execute", resource: "sandboxed-process" },
					{ kind: "write", resource: "artifact-store" },
				],
				idempotency: "non-idempotent",
				cancellation: {
					supported: true,
					description:
						"Pre-cancelled calls do not launch. After launch, aborting terminates the process group and returns termination='cancelled'; prior side effects are not rolled back.",
				},
				visibility: "public",
				prompt: {
					inventory: "Run a shell script; pipes, redirection, and compound syntax are supported.",
					example: "result = await shell.run(script='pwd'); print(result)",
					guidelines: ["Use shell.run for the target project's own builds, tests, and one-shot pipelines."],
				},
				capability: "shell.run",
				handler: async (args, signal, onUpdate) => {
					if (signal.aborted)
						throw new RiemannHostError("cancelled", "Shell execution was cancelled before launch");
					const script = requiredString(args, "script");
					const cwd = await this.resolveCwd(args.cwd);
					const environment = parseEnvironment(args.env);
					const shell = getShellConfig();
					const fromStdin = shell.commandTransport === "stdin";
					const command = {
						executable: shell.shell,
						args: fromStdin ? shell.args : [...shell.args, script],
						...(fromStdin ? { stdin: script } : {}),
					};
					if (args.background !== true) return this.run(command, { cwd, env: environment, signal, onUpdate });
					const id = this.tasks.start({ timeout_ms: remainingExecutionMs(signal) }, async (cell) => {
						const tracker = new RiemannActivityTracker(cwd, () => undefined);
						const request = { requestId: cell.id, operation: "shell.run", arguments: { script, cwd } };
						const result: KernelExecuteResult = {
							status: "ok",
							stdout: "",
							stderr: "",
							displays: [],
							modelContent: [],
							durationMs: 0,
						};
						cell.peek = () => ({ ...result, modelContent: [...result.modelContent] });
						let updates = Promise.resolve();
						let updateError: unknown;
						cell.details = {
							...cell.details,
							status: "running",
							startedAt: Date.now(),
							cellId: cell.id,
							activities: await tracker.observe({
								phase: "start",
								requestId: cell.id,
								request,
								startedAt: Date.now(),
							}),
						};
						const value = await this.run(command, {
							cwd,
							env: environment,
							signal: cell.signal,
							onUpdate: (update) => {
								updates = updates
									.then(async () => {
										cell.details.activities = await tracker.observe({
											phase: "update",
											requestId: cell.id,
											request,
											update,
										});
										if (
											update &&
											typeof update === "object" &&
											!Array.isArray(update) &&
											typeof update.value === "string"
										) {
											const text = update.value;
											if (text) {
												const retained = await this.artifacts.putText(text, { name: "process-progress" });
												if (
													retained &&
													typeof retained === "object" &&
													!Array.isArray(retained) &&
													typeof retained.handle === "string"
												)
													result.modelContent.push({
														type: "output_ref",
														handle: retained.handle,
														separator: update.kind === "stderr" ? "\n[stderr]\n" : "",
													});
											}
										}
										cell.notify();
									})
									.catch((error: unknown) => {
										updateError ??= error;
									});
							},
						});
						await updates;
						cell.details.activities = await tracker.observe({
							phase: "end",
							requestId: cell.id,
							request,
							durationMs: Date.now() - (cell.details.startedAt ?? Date.now()),
							result: value,
						});
						if (value && typeof value === "object" && !Array.isArray(value)) {
							result.durationMs = typeof value.duration_ms === "number" ? value.duration_ms : 0;
							if (value.termination === "cancelled" || value.termination === "timeout")
								result.status = value.termination;
							const ref = await this.artifacts.putResult(
								value,
								JSON.parse(JSON.stringify(ProcessResultSchema)) as JsonValue,
								"ProcessResult",
								"shell.run",
							);
							result.modelContent.push({
								type: "text",
								text: `exit_code=${value.exit_code}; termination=${value.termination} [ref=${ref}]`,
							});
						}
						if (updateError) throw updateError;
						return result;
					});
					return { $riemann: "process_handle", id };
				},
			},
		];
	}
}
