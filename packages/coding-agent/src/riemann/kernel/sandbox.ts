import { accessSync, constants, existsSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

export interface KernelSandboxPolicy {
	agentDir?: string;
	workspace: string;
	workspaceWritable: boolean;
	networkAllowed?: boolean;
	python: string;
	connectionDir: string;
	snapshotPath?: string;
	platform?: NodeJS.Platform;
	bubblewrapPath?: string;
	sandboxExecPath?: string;
	environment?: Record<string, string>;
}

export interface SandboxedCommand {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	transport: "ipc";
	endpointPrefix: string;
}

const SAFE_ENVIRONMENT = [
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"PATH",
	"TERM",
	"TZ",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"LD_LIBRARY_PATH",
	"DYLD_LIBRARY_PATH",
	"AI_AGENT",
	"RIEMANN_CODING_AGENT",
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
] as const;

function executableFromPath(name: string, pathValue = process.env.PATH): string | undefined {
	for (const directory of pathValue?.split(delimiter) ?? []) {
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}
	return undefined;
}

function interpreterLinkRoot(python: string): string | undefined {
	try {
		const target = readlinkSync(python);
		const resolvedTarget = resolve(dirname(python), target);
		return dirname(dirname(resolvedTarget));
	} catch {
		return undefined;
	}
}

function existingRoots(paths: readonly string[]): string[] {
	return paths.filter((path) => existsSync(path));
}

function isInside(parent: string, child: string): boolean {
	const root = resolve(parent);
	const candidate = resolve(child);
	return candidate === root || candidate.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`);
}

function writablePaths(policy: KernelSandboxPolicy): string[] {
	const paths = [resolve(policy.connectionDir)];
	if (policy.snapshotPath) paths.push(dirname(resolve(policy.snapshotPath)));
	if (policy.workspaceWritable) paths.push(resolve(policy.workspace));
	return [...new Set(paths)];
}

function sanitizedEnvironment(policy: KernelSandboxPolicy): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of SAFE_ENVIRONMENT) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	const home = join(policy.connectionDir, "home");
	const temporary = join(policy.connectionDir, "tmp");
	return {
		...env,
		...policy.environment,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
		IPYTHONDIR: join(policy.connectionDir, "ipython"),
		JUPYTER_CONFIG_DIR: join(policy.connectionDir, "jupyter"),
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONNOUSERSITE: "1",
	};
}

function linuxCommand(policy: KernelSandboxPolicy, pythonArgs: string[]): SandboxedCommand {
	const bubblewrap = policy.bubblewrapPath ?? process.env.RIEMANN_BWRAP_PATH ?? executableFromPath("bwrap");
	if (!bubblewrap) {
		throw new Error(
			"Riemann requires bubblewrap for Linux kernel isolation. Install bwrap or set RIEMANN_BWRAP_PATH.",
		);
	}
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-all",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
	];
	if (policy.networkAllowed) args.push("--share-net");
	for (const path of existingRoots([
		"/nix",
		"/usr",
		"/bin",
		"/sbin",
		"/lib",
		"/lib64",
		"/etc",
		"/opt",
		interpreterLinkRoot(policy.python) ?? "",
	])) {
		args.push("--ro-bind", path, path);
	}
	for (const path of existingRoots(["/run/current-system", "/run/opengl-driver", "/run/opengl-driver-32"])) {
		args.push("--ro-bind", path, path);
	}
	const runtime = dirname(dirname(resolve(policy.python)));
	const workspace = resolve(policy.workspace);
	args.push("--ro-bind", workspace, workspace);
	if (policy.workspaceWritable) args.push("--bind", workspace, workspace);
	if (!runtime.startsWith("/nix/")) args.push("--ro-bind", runtime, runtime);
	args.push("--bind", resolve(policy.connectionDir), resolve(policy.connectionDir));
	if (policy.snapshotPath) {
		const snapshotDirectory = dirname(resolve(policy.snapshotPath));
		args.push("--bind", snapshotDirectory, snapshotDirectory);
	}
	args.push("--chdir", workspace, "--", resolve(policy.python), ...pythonArgs);
	return {
		command: bubblewrap,
		args,
		env: sanitizedEnvironment(policy),
		transport: "ipc",
		endpointPrefix: join(policy.connectionDir, "kernel"),
	};
}

function seatbeltPath(path: string): string {
	const resolved = resolve(path);
	return JSON.stringify(existsSync(resolved) ? realpathSync(resolved) : resolved);
}

export function macOSSandboxProfile(policy: KernelSandboxPolicy): string {
	const readable = [
		"/System",
		"/usr",
		"/bin",
		"/sbin",
		"/Library",
		"/private/etc",
		"/dev",
		"/nix",
		"/run/current-system",
		dirname(dirname(resolve(policy.python))),
		resolve(policy.workspace),
		resolve(policy.connectionDir),
		...(policy.snapshotPath ? [dirname(resolve(policy.snapshotPath))] : []),
	].filter((path) => existsSync(path));
	const lines = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow process-info* (target same-sandbox))",
		"(allow signal (target same-sandbox))",
		"(allow ipc-posix-shm)",
		"(allow ipc-posix-sem)",
		"(allow user-preference-read)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow system-socket)",
		"(allow file-read-metadata)",
		'(allow file-read* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
		...readable.map((path) => `(allow file-read* (subpath ${seatbeltPath(path)}))`),
		...writablePaths(policy).map((path) => `(allow file-write* (subpath ${seatbeltPath(path)}))`),
		...(policy.networkAllowed
			? ["(allow network*)"]
			: [`(allow network* (subpath ${seatbeltPath(policy.connectionDir)}))`]),
	];
	return `${lines.join("\n")}\n`;
}

function macOSCommand(policy: KernelSandboxPolicy, pythonArgs: string[]): SandboxedCommand {
	const sandboxExec = policy.sandboxExecPath ?? "/usr/bin/sandbox-exec";
	if (!existsSync(sandboxExec)) {
		throw new Error("Riemann requires /usr/bin/sandbox-exec for macOS kernel isolation.");
	}
	return {
		command: sandboxExec,
		args: ["-p", macOSSandboxProfile(policy), resolve(policy.python), ...pythonArgs],
		env: sanitizedEnvironment(policy),
		transport: "ipc",
		endpointPrefix: join(policy.connectionDir, "kernel"),
	};
}

export function sandboxedKernelCommand(policy: KernelSandboxPolicy, pythonArgs: string[]): SandboxedCommand {
	if (policy.agentDir && isInside(policy.workspace, policy.agentDir)) {
		throw new Error(
			`Riemann state directory ${resolve(policy.agentDir)} must be outside sandbox workspace ${resolve(policy.workspace)}`,
		);
	}
	const platform = policy.platform ?? process.platform;
	if (platform === "linux") return linuxCommand(policy, pythonArgs);
	if (platform === "darwin") return macOSCommand(policy, pythonArgs);
	throw new Error(`Riemann kernel sandboxing is supported only on Linux and macOS, not ${platform}.`);
}

export function resolveSandboxExecutable(command: string, cwd: string, pathValue?: string): string {
	const candidate = command.includes("/") ? resolve(cwd, command) : executableFromPath(command, pathValue);
	if (!candidate) throw new Error(`Executable not found for sandboxed process: ${command}`);
	accessSync(candidate, constants.X_OK);
	return candidate;
}
