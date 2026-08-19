import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { getShellConfig } from "../../utils/shell.ts";
import { assertReadable, type FileAccessPolicy } from "../access-policy.ts";
import { RiemannHostError } from "../errors.ts";
import { resolveSandboxExecutable, type SandboxedCommand, sandboxedKernelCommand } from "../kernel/sandbox.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { ArtifactStore } from "../state/artifacts.ts";
import type { FunctionDefinition, FunctionUpdateCallback } from "./registry.ts";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const STREAM_UPDATE_INTERVAL_MS = 80;
const MAX_STREAM_UPDATE_BYTES = 64 * 1024;

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

function appendCaptured(chunks: Buffer[], currentBytes: number, chunk: Buffer, maxBytes = MAX_CAPTURE_BYTES): number {
	if (currentBytes >= maxBytes) return currentBytes;
	const remaining = maxBytes - currentBytes;
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

	private resolveCwd(value: JsonValue | undefined): string {
		if (value === undefined || value === null) return this.policy.cwd;
		if (typeof value !== "string" || value.length === 0)
			throw new RiemannHostError("invalid_arguments", "cwd must be a non-empty string");
		const cwd = resolve(this.policy.cwd, value);
		assertReadable(this.policy, cwd, value);
		return cwd;
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
				$riemann: "process_result",
				command: commandLine,
				exit_code: 127,
				stdout: "",
				stderr: `${command.executable}: command not found\n`,
				duration_ms: Date.now() - started,
				timed_out: false,
				artifact: null,
			};
		}
		const sandboxDir = await mkdtemp(join(tmpdir(), "riemann-shell-"));
		await Promise.all([
			mkdir(join(sandboxDir, "home"), { recursive: true, mode: 0o700 }),
			mkdir(join(sandboxDir, "tmp"), { recursive: true, mode: 0o700 }),
		]);
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
		let totalBytes = 0;
		let updateStdout: Buffer[] = [];
		let updateStderr: Buffer[] = [];
		let updateStdoutBytes = 0;
		let updateStderrBytes = 0;
		let updateTimer: NodeJS.Timeout | undefined;
		const flushUpdate = (): void => {
			if (!options.onUpdate || (updateStdoutBytes === 0 && updateStderrBytes === 0)) return;
			const stdoutDelta = Buffer.concat(updateStdout).toString("utf8");
			const stderrDelta = Buffer.concat(updateStderr).toString("utf8");
			updateStdout = [];
			updateStderr = [];
			updateStdoutBytes = 0;
			updateStderrBytes = 0;
			options.onUpdate({ stdout_delta: stdoutDelta, stderr_delta: stderrDelta });
		};
		const scheduleUpdate = (): void => {
			if (!options.onUpdate || updateTimer) return;
			updateTimer = setTimeout(() => {
				updateTimer = undefined;
				flushUpdate();
			}, STREAM_UPDATE_INTERVAL_MS);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			stdoutBytes = appendCaptured(stdout, stdoutBytes, chunk);
			updateStdoutBytes = appendCaptured(updateStdout, updateStdoutBytes, chunk, MAX_STREAM_UPDATE_BYTES);
			scheduleUpdate();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			stderrBytes = appendCaptured(stderr, stderrBytes, chunk);
			updateStderrBytes = appendCaptured(updateStderr, updateStderrBytes, chunk, MAX_STREAM_UPDATE_BYTES);
			scheduleUpdate();
		});
		let timedOut = false;
		let forceKill: NodeJS.Timeout | undefined;
		const terminate = () => {
			if (child.exitCode !== null) return;
			child.kill("SIGTERM");
			forceKill = setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 2_000);
		};
		const onAbort = () => terminate();
		options.signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, options.timeoutSeconds * 1_000);
		let exitCode: number | null;
		try {
			exitCode = await waitForChildProcess(child);
		} finally {
			clearTimeout(timeout);
			if (forceKill) clearTimeout(forceKill);
			options.signal.removeEventListener("abort", onAbort);
			await rm(sandboxDir, { recursive: true, force: true });
		}
		if (updateTimer) clearTimeout(updateTimer);
		flushUpdate();
		const stdoutText = Buffer.concat(stdout).toString("utf8");
		const stderrText = Buffer.concat(stderr).toString("utf8");
		let artifact: JsonValue = null;
		if (totalBytes > this.previewChars) {
			artifact = await this.artifacts.putText(
				`$ ${commandLine}\n\n[stdout]\n${stdoutText}\n\n[stderr]\n${stderrText}${totalBytes > MAX_CAPTURE_BYTES ? "\n[output capture limit reached]" : ""}`,
				{ name: "process-output.txt" },
			);
		}
		const preview = (text: string): string =>
			text.length <= this.previewChars
				? text
				: `${text.slice(0, this.previewChars)}\n[preview truncated; inspect artifact]`;
		return {
			$riemann: "process_result",
			command: commandLine,
			exit_code: exitCode,
			stdout: preview(stdoutText),
			stderr: preview(stderrText),
			duration_ms: Date.now() - started,
			timed_out: timedOut,
			artifact,
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
				promptSnippet: "Run a shell script; pipes, redirection, and compound syntax are supported.",
				parameters: [
					{ name: "script", description: "Shell script source", type: "str", required: true },
					{ name: "cwd", description: cwdDescription, type: "str | None", required: false },
					{
						name: "env",
						description: "Additional environment variables",
						type: "dict[str,str] | None",
						required: false,
					},
					{ name: "timeout", description: "Timeout in seconds", type: "int | None", required: false },
				],
				returns: "ProcessResult",
				examples: [
					"result = await shell.run(script='npm test 2>&1 | tail -40', timeout=300)",
					"display((result.exit_code, result.stderr[-2000:]))",
				],
				capability: "shell.run",
				promptGuidelines: [
					"Use the target project's own commands and environment for builds, tests, scripts, and dependency checks.",
				],
				handler: async (args, signal, onUpdate) => {
					const script = requiredString(args, "script");
					const cwd = this.resolveCwd(args.cwd);
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
