import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { signalProcessGroup, spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { getShellConfig } from "../../utils/shell.ts";
import { graphemeSafePrefix } from "../../utils/text.ts";
import { assertReadable, type FileAccessPolicy } from "../access-policy.ts";
import { RiemannHostError } from "../errors.ts";
import { resolveSandboxExecutable, type SandboxedCommand, sandboxedKernelCommand } from "../kernel/sandbox.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { ArtifactStore } from "../state/artifacts.ts";
import type { FunctionDefinition, FunctionUpdateCallback } from "./registry.ts";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const STREAM_UPDATE_INTERVAL_MS = 80;
const MAX_STREAM_UPDATE_BYTES = 64 * 1024;
const PREVIEW_TRUNCATION_MARKER = "[preview truncated; inspect artifact]";

type StreamKind = "stdout" | "stderr";
type ProcessTermination = "exited" | "timeout" | "cancelled" | "signal";

interface PendingStreamUpdate {
	kind: StreamKind;
	chunks: Buffer[];
	truncated: boolean;
}

const ArtifactSchema = Type.Object(
	{
		$riemann: Type.Literal("artifact.v1"),
		handle: Type.String(),
		mime_type: Type.String(),
		size: Type.Integer({ minimum: 0 }),
		name: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false },
);

const ProcessResultSchema = Type.Object(
	{
		$riemann: Type.Literal("process_result.v1"),
		exit_code: Type.Union([Type.Integer(), Type.Null()]),
		stdout: Type.String(),
		stderr: Type.String(),
		duration_ms: Type.Integer({ minimum: 0 }),
		termination: Type.Union([
			Type.Literal("exited"),
			Type.Literal("timeout"),
			Type.Literal("cancelled"),
			Type.Literal("signal"),
		]),
		stdout_truncated: Type.Boolean(),
		stderr_truncated: Type.Boolean(),
		artifact: Type.Union([ArtifactSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

function requiredString(args: Record<string, JsonValue>, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || value.length === 0)
		throw new RiemannHostError("invalid_arguments", `${name} must be a non-empty string`);
	return value;
}

function parseTimeout(value: JsonValue | undefined): number {
	const timeout = value === undefined || value === null ? 120 : value;
	if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 86_400) {
		throw new RiemannHostError("invalid_arguments", "timeout must be an integer from 1 to 86400 seconds");
	}
	return timeout;
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

function appendCaptured(chunks: Buffer[], currentBytes: number, chunk: Buffer): number {
	if (currentBytes >= MAX_CAPTURE_BYTES) return currentBytes;
	const remaining = MAX_CAPTURE_BYTES - currentBytes;
	chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
	return currentBytes + Math.min(chunk.length, remaining);
}

export class ShellFunctions {
	private readonly policy: FileAccessPolicy;
	private readonly artifacts: ArtifactStore;
	private readonly previewChars: number;
	private readonly networkAllowed: boolean;

	constructor(policy: FileAccessPolicy, artifacts: ArtifactStore, previewChars: number, networkAllowed: boolean) {
		this.policy = policy;
		this.artifacts = artifacts;
		this.previewChars = previewChars;
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
		commandLine: string,
		options: {
			cwd: string;
			env: Record<string, string>;
			timeoutSeconds: number;
			signal: AbortSignal;
			onUpdate?: FunctionUpdateCallback;
		},
	): Promise<JsonValue> {
		const started = Date.now();
		const executable = resolveSandboxExecutable(
			command.executable,
			options.cwd,
			options.env.PATH ?? process.env.PATH,
		);
		if (!executable) {
			return {
				$riemann: "process_result.v1",
				exit_code: 127,
				stdout: "",
				stderr: `${command.executable}: command not found\n`,
				duration_ms: Date.now() - started,
				termination: "exited",
				stdout_truncated: false,
				stderr_truncated: false,
				artifact: null,
			};
		}
		const sandboxDir = await mkdtemp(join(tmpdir(), "riemann-shell-"));
		let launch: SandboxedCommand;
		try {
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
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutSeenBytes = 0;
		let stderrSeenBytes = 0;
		let pendingUpdates: PendingStreamUpdate[] = [];
		let pendingUpdateBytes = 0;
		let updateTimer: NodeJS.Timeout | undefined;
		let updateSequence = 0;
		let stdoutUpdateDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
		let stderrUpdateDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
		const emitUpdate = (kind: StreamKind, value: string, truncated: boolean): void => {
			if (!options.onUpdate || (!value && !truncated)) return;
			options.onUpdate({ sequence: updateSequence, kind, value, truncated });
			updateSequence += 1;
		};
		const flushUpdates = (): void => {
			for (const update of pendingUpdates) {
				const decoder = update.kind === "stdout" ? stdoutUpdateDecoder : stderrUpdateDecoder;
				const value = decoder.decode(Buffer.concat(update.chunks), {
					stream: !update.truncated,
				});
				emitUpdate(update.kind, value, update.truncated);
				if (update.truncated) {
					if (update.kind === "stdout") stdoutUpdateDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
					else stderrUpdateDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
				}
			}
			pendingUpdates = [];
			pendingUpdateBytes = 0;
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
				update = { kind, chunks: [], truncated: false };
				pendingUpdates.push(update);
			}
			const remaining = Math.max(0, MAX_STREAM_UPDATE_BYTES - pendingUpdateBytes);
			const captured = Math.min(chunk.length, remaining);
			if (captured > 0) update.chunks.push(captured === chunk.length ? chunk : chunk.subarray(0, captured));
			update.truncated ||= captured < chunk.length;
			pendingUpdateBytes += captured;
			scheduleUpdate();
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutSeenBytes += chunk.length;
			stdoutBytes = appendCaptured(stdout, stdoutBytes, chunk);
			queueUpdate("stdout", chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrSeenBytes += chunk.length;
			stderrBytes = appendCaptured(stderr, stderrBytes, chunk);
			queueUpdate("stderr", chunk);
		});
		let requestedTermination: "timeout" | "cancelled" | null = null;
		let forceKill: NodeJS.Timeout | undefined;
		const terminate = (reason: "timeout" | "cancelled") => {
			if (requestedTermination !== null || !signalProcessGroup(child, "SIGTERM")) return;
			requestedTermination = reason;
			forceKill = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 2_000);
		};
		const onAbort = () => terminate("cancelled");
		options.signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => terminate("timeout"), options.timeoutSeconds * 1_000);
		if (options.signal.aborted) onAbort();
		let exitCode: number | null;
		try {
			exitCode = await waitForChildProcess(child);
		} finally {
			clearTimeout(timeout);
			if (forceKill) {
				clearTimeout(forceKill);
				signalProcessGroup(child, "SIGKILL");
			}
			options.signal.removeEventListener("abort", onAbort);
			await rm(sandboxDir, { recursive: true, force: true });
		}
		if (updateTimer) clearTimeout(updateTimer);
		finishUpdates();
		const stdoutText = Buffer.concat(stdout).toString("utf8");
		const stderrText = Buffer.concat(stderr).toString("utf8");
		const stdoutCaptureTruncated = stdoutSeenBytes > stdoutBytes;
		const stderrCaptureTruncated = stderrSeenBytes > stderrBytes;
		const stdoutPreviewTruncated = stdoutText.length > this.previewChars;
		const stderrPreviewTruncated = stderrText.length > this.previewChars;
		const stdoutTruncated = stdoutCaptureTruncated || stdoutPreviewTruncated;
		const stderrTruncated = stderrCaptureTruncated || stderrPreviewTruncated;
		let artifact: JsonValue = null;
		if (stdoutTruncated || stderrTruncated) {
			const captureMarker = (truncated: boolean): string =>
				truncated ? `\n[capture truncated at ${MAX_CAPTURE_BYTES} bytes]` : "";
			artifact = await this.artifacts.putText(
				`$ ${commandLine}\n\n[stdout]\n${stdoutText}${captureMarker(stdoutCaptureTruncated)}\n\n[stderr]\n${stderrText}${captureMarker(stderrCaptureTruncated)}`,
				{ name: "process-output.txt" },
			);
		}
		const preview = (text: string): string =>
			text.length <= this.previewChars
				? text
				: `${graphemeSafePrefix(text, this.previewChars)}\n${PREVIEW_TRUNCATION_MARKER}`;
		const termination: ProcessTermination = requestedTermination ?? (child.signalCode === null ? "exited" : "signal");
		return {
			$riemann: "process_result.v1",
			exit_code: exitCode,
			stdout: preview(stdoutText),
			stderr: preview(stderrText),
			duration_ms: Date.now() - started,
			termination,
			stdout_truncated: stdoutTruncated,
			stderr_truncated: stderrTruncated,
			artifact,
		};
	}

	definitions(): FunctionDefinition[] {
		const cwdDescription =
			"Working directory; relative paths resolve from the current working directory and absolute host paths are allowed";
		return [
			{
				abiVersion: 2,
				name: "run",
				namespace: "shell",
				description: "Run a shell script and return a structured ProcessResult.",
				inputSchema: Type.Object(
					{
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
						timeout: Type.Optional(
							Type.Union([Type.Integer({ minimum: 1, maximum: 86_400 }), Type.Null()], {
								description: "Timeout in seconds",
								default: 120,
							}),
						),
					},
					{ additionalProperties: false },
				),
				outputSchema: ProcessResultSchema,
				pythonReturnType: "ProcessResult",
				errors: [
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
				effects: [{ kind: "execute", resource: "sandboxed-process" }],
				idempotency: "non-idempotent",
				cancellation: {
					supported: true,
					description: "Aborting terminates the sandboxed process group and returns termination='cancelled'.",
				},
				visibility: "public",
				prompt: {
					inventory: "Run a shell script; pipes, redirection, and compound syntax are supported.",
					example: "result = await shell.run(script='npm test 2>&1 | tail -40', timeout=300)",
					guidelines: ["Use shell.run for the target project's own builds, tests, and one-shot pipelines."],
				},
				capability: "shell.run",
				handler: async (args, signal, onUpdate) => {
					const script = requiredString(args, "script");
					const cwd = await this.resolveCwd(args.cwd);
					const environment = parseEnvironment(args.env);
					const timeoutSeconds = parseTimeout(args.timeout);
					const shell = getShellConfig();
					const fromStdin = shell.commandTransport === "stdin";
					return this.run(
						{
							executable: shell.shell,
							args: fromStdin ? shell.args : [...shell.args, script],
							...(fromStdin ? { stdin: script } : {}),
						},
						script,
						{ cwd, env: environment, timeoutSeconds, signal, onUpdate },
					);
				},
			},
		];
	}
}
