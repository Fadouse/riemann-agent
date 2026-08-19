import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";
import { getPackageDir, isBunBinary } from "../../config.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { getRiemannAgentDir } from "../config.ts";

const RUNTIME_LAYOUT_VERSION = 1;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const CXX_RUNTIME_LIBRARY = "libstdc++.so.6";
let runtimePromise: Promise<ManagedPythonRuntime> | undefined;

interface RuntimeMarker {
	layoutVersion: number;
	requirementsSha256: string;
}

interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface ManagedPythonRuntime {
	python: string;
	environment?: Record<string, string>;
}

function requirementsPath(): string {
	const packageDir = getPackageDir();
	if (isBunBinary) return join(packageDir, "riemann-python", "requirements.lock");
	const sourcePath = join(packageDir, "src", "riemann", "python", "requirements.lock");
	return existsSync(sourcePath) ? sourcePath : join(packageDir, "dist", "riemann", "python", "requirements.lock");
}

function pythonIn(runtimeDir: string): string {
	return process.platform === "win32" ? join(runtimeDir, "Scripts", "python.exe") : join(runtimeDir, "bin", "python");
}

function hostPython(): string {
	const configured = process.env.RIEMANN_PYTHON?.trim();
	if (configured) return configured;
	const name = process.platform === "win32" ? "python.exe" : "python3";
	for (const directory of process.env.PATH?.split(delimiter) ?? []) {
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return name;
}

async function readMarker(path: string): Promise<RuntimeMarker | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const marker = value as Partial<RuntimeMarker>;
		if (marker.layoutVersion !== RUNTIME_LAYOUT_VERSION || typeof marker.requirementsSha256 !== "string") {
			return undefined;
		}
		return { layoutVersion: marker.layoutVersion, requirementsSha256: marker.requirementsSha256 };
	} catch {
		return undefined;
	}
}

async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<CommandResult> {
	const child = spawnProcess(command, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	try {
		const exitCode = await waitForChildProcess(child);
		return {
			exitCode,
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function runProvisionCommand(command: string, args: string[], cwd: string): Promise<void> {
	const result = await runCommand(command, args, cwd);
	if (result.exitCode !== 0) {
		const output = `${result.stdout}${result.stderr}`.trim();
		throw new Error(
			`${command} ${args.join(" ")} failed with exit code ${result.exitCode}${output ? `:\n${output}` : ""}`,
		);
	}
}

async function provisionRuntime(stagingDir: string, requirements: string): Promise<void> {
	try {
		await runProvisionCommand("uv", ["venv", stagingDir, "--python", hostPython()], getRiemannAgentDir());
		await runProvisionCommand(
			"uv",
			["pip", "install", "--python", pythonIn(stagingDir), "--require-hashes", "-r", requirements],
			getRiemannAgentDir(),
		);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code !== "ENOENT") throw error;
		await runProvisionCommand("python3", ["-m", "venv", stagingDir], getRiemannAgentDir());
		await runProvisionCommand(
			pythonIn(stagingDir),
			["-m", "pip", "install", "--require-hashes", "-r", requirements],
			getRiemannAgentDir(),
		);
	}
}

async function canImportZmq(python: string, environment?: Record<string, string>): Promise<boolean> {
	try {
		const result = await runCommand(
			python,
			["-I", "-c", "import zmq"],
			getRiemannAgentDir(),
			environment ? { ...process.env, ...environment } : process.env,
			PROBE_TIMEOUT_MS,
		);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

function loadedCxxRuntimeDirectory(): string | undefined {
	try {
		const report = process.report.getReport();
		if (!("sharedObjects" in report)) return undefined;
		const { sharedObjects } = report;
		if (!Array.isArray(sharedObjects)) return undefined;
		for (const value of sharedObjects) {
			if (typeof value !== "string") continue;
			const name = basename(value);
			if (name !== CXX_RUNTIME_LIBRARY && !name.startsWith(`${CXX_RUNTIME_LIBRARY}.`)) continue;
			return dirname(realpathSync(value));
		}
	} catch {
		// Bun and restricted Node runtimes may not expose diagnostic reports.
	}
	return undefined;
}

async function compilerCxxRuntimeDirectories(): Promise<string[]> {
	const compilers = [process.env.CXX?.trim(), "c++", "g++", "gcc"];
	const tried = new Set<string>();
	const directories: string[] = [];
	for (const compiler of compilers) {
		if (!compiler || tried.has(compiler)) continue;
		tried.add(compiler);
		try {
			const result = await runCommand(
				compiler,
				[`-print-file-name=${CXX_RUNTIME_LIBRARY}`],
				getRiemannAgentDir(),
				process.env,
				PROBE_TIMEOUT_MS,
			);
			const candidate = result.stdout.trim();
			if (result.exitCode !== 0 || !isAbsolute(candidate) || !existsSync(candidate)) continue;
			const directory = dirname(realpathSync(candidate));
			if (!directories.includes(directory)) directories.push(directory);
		} catch {
			// Try the next compiler available on PATH.
		}
	}
	return directories;
}

async function environmentWithLibraryDirectories(
	python: string,
	directories: readonly string[],
): Promise<Record<string, string> | undefined> {
	const existing = process.env.LD_LIBRARY_PATH;
	const existingEntries = existing?.split(delimiter) ?? [];
	const additions = [...new Set(directories)].filter((entry) => !existingEntries.includes(entry));
	if (additions.length === 0) return undefined;
	const environment = {
		LD_LIBRARY_PATH: [...additions, ...(existing ? [existing] : [])].join(delimiter),
	};
	return (await canImportZmq(python, environment)) ? environment : undefined;
}

async function managedPythonEnvironment(python: string): Promise<Record<string, string> | undefined> {
	if (process.platform !== "linux" || (await canImportZmq(python))) return undefined;

	const loadedDirectory = loadedCxxRuntimeDirectory();
	if (loadedDirectory) {
		const environment = await environmentWithLibraryDirectories(python, [loadedDirectory]);
		if (environment) return environment;
	}

	const nixLoaderDirectories: string[] = [];
	for (const entry of process.env.NIX_LD_LIBRARY_PATH?.split(delimiter) ?? []) {
		if (!entry) continue;
		try {
			const directory = realpathSync(entry);
			if (!nixLoaderDirectories.includes(directory)) nixLoaderDirectories.push(directory);
		} catch {
			// Ignore stale loader paths.
		}
	}
	if (nixLoaderDirectories.length > 0) {
		const environment = await environmentWithLibraryDirectories(python, nixLoaderDirectories);
		if (environment) return environment;
	}

	for (const directory of await compilerCxxRuntimeDirectories()) {
		const environment = await environmentWithLibraryDirectories(python, [directory]);
		if (environment) return environment;
	}
	return undefined;
}

async function ensureRuntimePath(): Promise<string> {
	const agentDir = getRiemannAgentDir();
	const runtimeRoot = join(agentDir, "runtime");
	const runtimeDir = join(runtimeRoot, `python-v${RUNTIME_LAYOUT_VERSION}`);
	const markerPath = join(runtimeDir, "riemann-runtime.json");
	const requirements = requirementsPath();
	const requirementsSha256 = createHash("sha256")
		.update(await readFile(requirements))
		.digest("hex");
	const current = await readMarker(markerPath);
	if (current?.requirementsSha256 === requirementsSha256 && existsSync(pythonIn(runtimeDir)))
		return pythonIn(runtimeDir);

	await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(runtimeRoot, { realpath: false, stale: INSTALL_TIMEOUT_MS * 2, retries: 20 });
	try {
		const lockedCurrent = await readMarker(markerPath);
		if (lockedCurrent?.requirementsSha256 === requirementsSha256 && existsSync(pythonIn(runtimeDir))) {
			return pythonIn(runtimeDir);
		}
		const stagingDir = join(runtimeRoot, `.python-v${RUNTIME_LAYOUT_VERSION}-${process.pid}-${randomUUID()}.tmp`);
		try {
			await provisionRuntime(stagingDir, requirements);
			await writeFile(
				join(stagingDir, "riemann-runtime.json"),
				`${JSON.stringify({ layoutVersion: RUNTIME_LAYOUT_VERSION, requirementsSha256 }, null, 2)}\n`,
				{ mode: 0o600 },
			);
			await rm(runtimeDir, { recursive: true, force: true });
			await rename(stagingDir, runtimeDir);
		} finally {
			await rm(stagingDir, { recursive: true, force: true });
		}
		return pythonIn(runtimeDir);
	} finally {
		await release();
	}
}

export function ensureManagedPython(): Promise<ManagedPythonRuntime> {
	runtimePromise ??= (async () => {
		const python = await ensureRuntimePath();
		const environment = await managedPythonEnvironment(python);
		return environment ? { python, environment } : { python };
	})().catch((error) => {
		runtimePromise = undefined;
		throw error;
	});
	return runtimePromise;
}

/** Reset the process-local provisioning cache. Intended for isolated runtime tests. */
export function resetManagedPythonCacheForTests(): void {
	runtimePromise = undefined;
}
