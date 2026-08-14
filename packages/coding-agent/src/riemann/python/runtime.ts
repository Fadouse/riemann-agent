import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import lockfile from "proper-lockfile";
import { getPackageDir, isBunBinary } from "../../config.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { getRiemannAgentDir } from "../config.ts";

const RUNTIME_LAYOUT_VERSION = 1;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
let runtimePromise: Promise<string> | undefined;

interface RuntimeMarker {
	layoutVersion: number;
	requirementsSha256: string;
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

async function runProvisionCommand(command: string, args: string[], cwd: string): Promise<void> {
	const child = spawnProcess(command, args, {
		cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	const timer = setTimeout(() => child.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
	try {
		const exitCode = await waitForChildProcess(child);
		if (exitCode !== 0) {
			const output = Buffer.concat([...stdout, ...stderr])
				.toString("utf8")
				.trim();
			throw new Error(
				`${command} ${args.join(" ")} failed with exit code ${exitCode}${output ? `:\n${output}` : ""}`,
			);
		}
	} finally {
		clearTimeout(timer);
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

async function ensureRuntime(): Promise<string> {
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

export function ensureManagedPython(): Promise<string> {
	runtimePromise ??= ensureRuntime().catch((error) => {
		runtimePromise = undefined;
		throw error;
	});
	return runtimePromise;
}

/** Reset the process-local provisioning cache. Intended for isolated runtime tests. */
export function resetManagedPythonCacheForTests(): void {
	runtimePromise = undefined;
}
