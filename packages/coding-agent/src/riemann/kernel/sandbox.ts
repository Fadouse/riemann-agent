import { accessSync, constants, existsSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { type FileAccessPolicy, isInside, unrestrictedRead, unrestrictedWrite } from "../access-policy.ts";

export interface SandboxedLaunchConfig {
	policy: FileAccessPolicy;
	python: string;
	connectionDir: string;
	networkAllowed?: boolean;
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

function executableFromPath(name: string, pathValue = process.env.PATH, cwd = process.cwd()): string | undefined {
	for (const directory of pathValue?.split(delimiter) ?? []) {
		const root = directory.length === 0 ? cwd : resolve(cwd, directory);
		const candidate = join(root, name);
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

function sanitizedEnvironment(config: SandboxedLaunchConfig): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of SAFE_ENVIRONMENT) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	const home = join(config.connectionDir, "home");
	const temporary = join(config.connectionDir, "tmp");
	return {
		...env,
		...config.environment,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
		IPYTHONDIR: join(config.connectionDir, "ipython"),
		JUPYTER_CONFIG_DIR: join(config.connectionDir, "jupyter"),
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONNOUSERSITE: "1",
	};
}

function coveredBy(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => isInside(root, path));
}

/**
 * Linux sandbox: read-only base for every read root, then writable binds for
 * write roots, then tmpfs masks for exclusions so excludes always win.
 */
function linuxCommand(config: SandboxedLaunchConfig, pythonArgs: string[]): SandboxedCommand {
	const bubblewrap = config.bubblewrapPath ?? process.env.RIEMANN_BWRAP_PATH ?? executableFromPath("bwrap");
	if (!bubblewrap) {
		throw new Error(
			"Riemann requires bubblewrap for Linux kernel isolation. Install bwrap or set RIEMANN_BWRAP_PATH.",
		);
	}
	const policy = config.policy;
	const runtime = dirname(dirname(resolve(config.python)));
	const unrestricted = unrestrictedRead(policy) && unrestrictedWrite(policy);
	const rootReadable = coveredBy("/", policy.readRoots);
	const args = ["--die-with-parent", "--new-session"];
	if (unrestricted) {
		args.push("--bind", "/", "/");
	} else if (rootReadable) {
		args.push("--ro-bind", "/", "/");
	} else {
		for (const path of existingRoots([
			"/nix",
			"/usr",
			"/bin",
			"/sbin",
			"/lib",
			"/lib64",
			"/etc",
			"/sys",
			interpreterLinkRoot(config.python) ?? "",
			...policy.readRoots,
		])) {
			args.push("--ro-bind", path, path);
		}
		args.push("--tmpfs", "/run");
		for (const path of existingRoots(["/run/current-system", "/run/opengl-driver", "/run/opengl-driver-32"])) {
			args.push("--ro-bind", path, path);
		}
		if (!coveredBy(runtime, policy.readRoots)) args.push("--ro-bind", runtime, runtime);
	}
	// Mount proc and dev after the base root so device nodes stay usable.
	args.push("--proc", "/proc", "--dev-bind", "/dev", "/dev");
	if (!unrestricted) {
		for (const path of existingRoots(policy.writeRoots)) {
			args.push("--bind", path, path);
		}
	}
	for (const path of existingRoots(policy.writeExcludes)) {
		if (coveredBy(path, policy.readRoots)) args.push("--ro-bind", path, path);
	}
	for (const path of existingRoots(policy.readExcludes)) {
		// An excluded directory is fully inaccessible: mask it with a private
		// tmpfs and remount read-only so writes fail instead of hitting scratch.
		args.push("--tmpfs", path, "--remount-ro", path);
	}
	args.push("--bind", resolve(config.connectionDir), resolve(config.connectionDir));
	args.push("--chdir", resolve(policy.cwd), "--", resolve(config.python), ...pythonArgs);
	return {
		command: bubblewrap,
		args,
		env: sanitizedEnvironment(config),
		transport: "ipc",
		endpointPrefix: join(config.connectionDir, "kernel"),
	};
}

function seatbeltPath(path: string): string {
	const resolved = resolve(path);
	return JSON.stringify(existsSync(resolved) ? realpathSync(resolved) : resolved);
}

/** `(subpath root)` plus `require-not` guards for each exclusion below it. */
function seatbeltRootFilter(root: string, excludes: readonly string[]): string {
	if (excludes.length === 0) return `(subpath ${seatbeltPath(root)})`;
	const guards = excludes.flatMap((exclude) => {
		const quoted = seatbeltPath(exclude);
		return [`(require-not (literal ${quoted}))`, `(require-not (subpath ${quoted}))`];
	});
	return `(require-all (subpath ${seatbeltPath(root)}) ${guards.join(" ")})`;
}

export function macOSSandboxProfile(config: SandboxedLaunchConfig): string {
	const policy = config.policy;
	const readableRoots = existingRoots([
		...policy.readRoots,
		...(coveredBy(config.connectionDir, policy.readRoots) ? [] : [config.connectionDir]),
	]);
	const writableRoots = existingRoots([
		...policy.writeRoots,
		...(coveredBy(config.connectionDir, policy.writeRoots) ? [] : [config.connectionDir]),
	]);
	const allowRead = unrestrictedRead(policy)
		? ["(allow file-read*)"]
		: readableRoots.map((root) => `(allow file-read* ${seatbeltRootFilter(root, policy.readExcludes)})`);
	const allowWrite = unrestrictedWrite(policy)
		? ["(allow file-write*)"]
		: writableRoots.map((root) => `(allow file-write* ${seatbeltRootFilter(root, policy.writeExcludes)})`);
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
		...allowRead,
		...allowWrite,
		...(config.networkAllowed
			? ["(allow network*)"]
			: [`(allow network* (subpath ${seatbeltPath(config.connectionDir)}))`]),
	];
	return `${lines.join("\n")}\n`;
}

function macOSCommand(config: SandboxedLaunchConfig, pythonArgs: string[]): SandboxedCommand {
	const sandboxExec = config.sandboxExecPath ?? "/usr/bin/sandbox-exec";
	if (!existsSync(sandboxExec)) {
		throw new Error("Riemann requires /usr/bin/sandbox-exec for macOS kernel isolation.");
	}
	return {
		command: sandboxExec,
		args: ["-p", macOSSandboxProfile(config), resolve(config.python), ...pythonArgs],
		env: sanitizedEnvironment(config),
		transport: "ipc",
		endpointPrefix: join(config.connectionDir, "kernel"),
	};
}

export function sandboxedKernelCommand(config: SandboxedLaunchConfig, pythonArgs: string[]): SandboxedCommand {
	const platform = config.platform ?? process.platform;
	if (platform === "linux") return linuxCommand(config, pythonArgs);
	if (platform === "darwin") return macOSCommand(config, pythonArgs);
	throw new Error(`Riemann kernel sandboxing is supported only on Linux and macOS, not ${platform}.`);
}

export function resolveSandboxExecutable(command: string, cwd: string, pathValue?: string): string | undefined {
	const candidate = command.includes("/") ? resolve(cwd, command) : executableFromPath(command, pathValue, cwd);
	if (!candidate) return undefined;
	try {
		accessSync(candidate, constants.X_OK);
		return realpathSync(candidate);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return undefined;
		}
		throw error;
	}
}
