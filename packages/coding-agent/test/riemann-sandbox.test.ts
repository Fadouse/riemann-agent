import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type FilesystemSnapshot, fileAccessPolicy, policyAllowsWrite } from "../src/riemann/access-policy.ts";
import {
	macOSSandboxProfile,
	resolveSandboxExecutable,
	type SandboxedLaunchConfig,
	sandboxedKernelCommand,
} from "../src/riemann/kernel/sandbox.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot(spec: Partial<FilesystemSnapshot> = {}): FilesystemSnapshot {
	return {
		read: spec.read ?? ["/"],
		readExclude: spec.readExclude ?? [],
		write: spec.write ?? ["/"],
		writeExclude: spec.writeExclude ?? [],
	};
}

async function launch(
	options: { readHost?: boolean; writeHost?: boolean; readExcludeName?: string; writeExcludeName?: string } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "riemann-sandbox-policy-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const connectionDir = join(root, "connection");
	await Promise.all([mkdir(workspace, { recursive: true }), mkdir(connectionDir, { recursive: true })]);
	if (options.readExcludeName) await mkdir(join(workspace, options.readExcludeName), { recursive: true });
	if (options.writeExcludeName) await mkdir(join(workspace, options.writeExcludeName), { recursive: true });
	const hostRead = options.readHost !== false;
	const hostWrite = options.writeHost !== false;
	const config: SandboxedLaunchConfig = {
		policy: fileAccessPolicy(
			workspace,
			snapshot({
				read: hostRead ? undefined : [workspace],
				readExclude: options.readExcludeName ? [join(workspace, options.readExcludeName)] : [],
				write: hostWrite ? undefined : [workspace],
				writeExclude: options.writeExcludeName ? [join(workspace, options.writeExcludeName)] : [],
			}),
		),
		connectionDir,
		python: process.execPath,
	};
	return { config, root, workspace, connectionDir };
}

function flagIndex(args: string[], flag: string, value: string): number {
	return args.findIndex((item, index) => item === flag && args[index + 1] === value);
}

describe("Riemann kernel system sandbox", () => {
	test("binds the full host filesystem for an unrestricted policy", async () => {
		process.env.RIEMANN_TEST_SECRET = "must-not-leak";
		try {
			const { config } = await launch();
			const command = sandboxedKernelCommand({ ...config, platform: "linux", bubblewrapPath: "/usr/bin/bwrap" }, [
				"-m",
				"ipykernel_launcher",
			]);
			expect(command.command).toBe("/usr/bin/bwrap");
			expect(command.args).not.toContain("--unshare-all");
			expect(command.args).toContain("--new-session");
			expect(command.args).toContain("--unshare-pid");
			expect(command.transport).toBe("ipc");
			expect(command.args).toEqual(expect.arrayContaining(["--dev-bind", "/dev", "/dev"]));
			expect(command.args).toEqual(expect.arrayContaining(["--bind", "/", "/"]));
			expect(command.args).toEqual(expect.arrayContaining(["--chdir", config.policy.cwd]));
			expect(command.args).not.toContain("--share-net");
			expect(command.env.RIEMANN_TEST_SECRET).toBeUndefined();
			expect(command.env.PYTHONNOUSERSITE).toBe("1");

			const profile = macOSSandboxProfile({ ...config, platform: "darwin" });
			expect(profile).toContain("(allow file-read*)");
			expect(profile).toContain("(allow file-write*)");
		} finally {
			delete process.env.RIEMANN_TEST_SECRET;
		}
	});

	test("derives a restricted sandbox from read roots, write roots, and exclusions", async () => {
		const { config, connectionDir } = await launch({
			writeHost: false,
			readExcludeName: "secrets",
			writeExcludeName: "frozen",
		});
		const command = sandboxedKernelCommand({ ...config, platform: "linux", bubblewrapPath: "/usr/bin/bwrap" }, []);
		const args = command.args;
		const writeRoot = config.policy.writeRoots[0] ?? "";
		const readExclude = config.policy.readExcludes[0] ?? "";
		const writeExclude = config.policy.writeExcludes[0] ?? "";
		const roBindRoot = flagIndex(args, "--ro-bind", "/");
		const writableBind = flagIndex(args, "--bind", writeRoot);
		const connectionBind = flagIndex(args, "--bind", connectionDir);
		const writeMask = flagIndex(args, "--ro-bind", writeExclude);
		const readMask = flagIndex(args, "--tmpfs", readExclude);
		expect(roBindRoot).toBeGreaterThan(-1);
		expect(writableBind).toBeGreaterThan(roBindRoot);
		expect(connectionBind).toBeGreaterThan(writableBind);
		// A write exclusion stays readable but read-only; a read exclusion is masked entirely.
		expect(writeMask).toBeGreaterThan(writableBind);
		expect(readMask).toBeGreaterThan(writeMask);

		const profile = macOSSandboxProfile({ ...config, platform: "darwin" });
		const excludedRead = JSON.stringify(readExclude);
		const excludedWrite = JSON.stringify(writeExclude);
		expect(profile).toContain(`(require-not (literal ${excludedRead}))`);
		expect(profile).toContain(`(require-not (subpath ${excludedRead}))`);
		expect(profile).toContain(`(require-not (literal ${excludedWrite}))`);
		expect(profile).toContain(`(allow file-write* (require-all (subpath ${JSON.stringify(writeRoot)})`);
		expect(profile).not.toContain("(allow file-write*)\n");
	}, 20_000);

	test("keeps system roots read-only when read roots do not cover the host", async () => {
		const { config } = await launch({ readHost: false, writeHost: false });
		const command = sandboxedKernelCommand({ ...config, platform: "linux", bubblewrapPath: "/usr/bin/bwrap" }, []);
		expect(command.args).toEqual(expect.arrayContaining(["--ro-bind", "/etc", "/etc"]));
		expect(command.args).toEqual(expect.arrayContaining(["--ro-bind", "/sys", "/sys"]));
		expect(command.args).not.toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));

		const profile = macOSSandboxProfile({ ...config, platform: "darwin" });
		expect(profile).toContain("(deny default)");
		expect(profile).not.toContain("(allow file-read*)");
		expect(profile).not.toContain("(allow file-write*)\n");
		expect(profile).toContain(`(allow network* (subpath ${JSON.stringify(config.connectionDir)}))`);
		expect(profile).toContain(`(allow file-read* (subpath ${JSON.stringify(config.connectionDir)}))`);
		expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(config.connectionDir)}))`);
	});

	test("allows host networking only when configured", async () => {
		const { config } = await launch();
		expect(macOSSandboxProfile({ ...config, networkAllowed: true, platform: "darwin" })).toContain(
			"(allow network*)",
		);
	});

	test("preserves host and terminal environment while keeping Jupyter state private", async () => {
		const names = [
			"HOME",
			"USERPROFILE",
			"TMPDIR",
			"TMP",
			"TEMP",
			"TERM",
			"COLORTERM",
			"TERM_PROGRAM",
			"TERM_PROGRAM_VERSION",
			"TMUX",
			"TMUX_PANE",
			"KITTY_WINDOW_ID",
			"KITTY_LISTEN_ON",
			"NO_COLOR",
		] as const;
		const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
		const { config, connectionDir } = await launch();
		try {
			for (const name of names) process.env[name] = `host-${name.toLowerCase()}`;
			const command = sandboxedKernelCommand(
				{
					...config,
					platform: "linux",
					bubblewrapPath: "/usr/bin/bwrap",
					environment: { PWD: "wrong", IPYTHONDIR: "wrong", JUPYTER_CONFIG_DIR: "wrong" },
				},
				[],
			);

			for (const name of names) expect(command.env[name]).toBe(`host-${name.toLowerCase()}`);
			expect(command.env.IPYTHONDIR).toBe(join(connectionDir, "ipython"));
			expect(command.env.JUPYTER_CONFIG_DIR).toBe(join(connectionDir, "jupyter"));
			expect(command.env.PWD).toBe(config.policy.cwd);
		} finally {
			for (const name of names) {
				const value = previous[name];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	test("rejects invalid filesystem policies with explicit errors", async () => {
		const { config, root, workspace, connectionDir } = await launch({ readHost: false, writeHost: false });
		const existingFile = join(root, "file");
		await writeFile(existingFile, "not a directory");
		const command = (policy: typeof config.policy) =>
			sandboxedKernelCommand({ ...config, policy, platform: "linux", bubblewrapPath: "/usr/bin/bwrap" }, []);

		const missing = join(root, "missing");
		expect(() => command({ ...config.policy, cwd: missing })).toThrow(/cwd.*does not exist/i);
		expect(() => command({ ...config.policy, cwd: existingFile })).toThrow(/cwd.*directory/i);
		expect(() => command({ ...config.policy, cwd: workspace, readExcludes: [workspace] })).toThrow(/cwd.*excluded/i);
		expect(() => command({ ...config.policy, readRoots: [missing] })).toThrow(/read root.*does not exist/i);
		expect(() => command({ ...config.policy, writeRoots: [missing] })).toThrow(/write root.*does not exist/i);
		expect(() => command({ ...config.policy, readExcludes: [missing] })).toThrow(/read exclusion.*does not exist/i);
		expect(() => command({ ...config.policy, writeExcludes: [missing] })).toThrow(/write exclusion.*does not exist/i);
		expect(() => command({ ...config.policy, writeRoots: [connectionDir] })).toThrow(
			/write root.*covered by a read root/i,
		);
		expect(() => command({ ...config.policy, readExcludes: [connectionDir] })).toThrow(
			/read exclusion.*covered by a read root/i,
		);
		expect(() => command({ ...config.policy, writeExcludes: [connectionDir] })).toThrow(
			/write exclusion.*covered by a write root/i,
		);

		const outside = join(root, "outside");
		const linkedCwd = join(workspace, "linked-cwd");
		await mkdir(outside);
		await symlink(outside, linkedCwd);
		expect(() => command({ ...config.policy, cwd: linkedCwd })).toThrow(/cwd.*not readable/i);
	});

	test("read exclusions override writes and mask excluded files with read-only dev-null binds", async () => {
		const { config, workspace } = await launch({ readHost: false, writeHost: false });
		const excludedFile = join(workspace, "secret.txt");
		await writeFile(excludedFile, "secret");
		const policy = fileAccessPolicy(
			workspace,
			snapshot({ read: [workspace], readExclude: [excludedFile], write: [workspace] }),
		);

		expect(policyAllowsWrite(policy, excludedFile)).toBe(false);
		const command = sandboxedKernelCommand(
			{ ...config, policy, platform: "linux", bubblewrapPath: "/usr/bin/bwrap" },
			[],
		);
		expect(command.args).toEqual(expect.arrayContaining(["--ro-bind", "/dev/null", excludedFile]));
		expect(flagIndex(command.args, "--tmpfs", excludedFile)).toBe(-1);
		const profile = macOSSandboxProfile({ ...config, policy, platform: "darwin" });
		expect(profile).toContain(
			`(allow file-write* (require-all (subpath ${JSON.stringify(workspace)}) (require-not (literal ${JSON.stringify(excludedFile)}))`,
		);
	});

	test("carves the runtime directory through excluded ancestors and removes redundant nested masks", async () => {
		const { config, root, connectionDir } = await launch();
		const excludedTmp = tmpdir();
		const policy = fileAccessPolicy(
			process.cwd(),
			snapshot({ read: ["/"], readExclude: [excludedTmp, root], write: ["/"] }),
		);
		const command = sandboxedKernelCommand(
			{ ...config, policy, platform: "linux", bubblewrapPath: "/usr/bin/bwrap" },
			[],
		);
		const tmpfs = flagIndex(command.args, "--tmpfs", excludedTmp);
		const runtimeBind = flagIndex(command.args, "--bind", connectionDir);
		const remount = flagIndex(command.args, "--remount-ro", excludedTmp);
		expect(tmpfs).toBeGreaterThan(-1);
		expect(runtimeBind).toBeGreaterThan(tmpfs);
		expect(remount).toBeGreaterThan(runtimeBind);
		expect(flagIndex(command.args, "--tmpfs", root)).toBe(-1);

		const profile = macOSSandboxProfile({ ...config, policy, platform: "darwin" });
		expect(profile).toContain(`(allow file-read* (subpath ${JSON.stringify(connectionDir)}))`);
		expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(connectionDir)}))`);
	});

	test("uses the effective PATH and canonical executable target", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-sandbox-path-"));
		roots.push(root);
		const targetDirectory = join(root, "target", "bin");
		const pathDirectory = join(root, "profile", "bin");
		const target = join(targetDirectory, "probe");
		await Promise.all([mkdir(targetDirectory, { recursive: true }), mkdir(pathDirectory, { recursive: true })]);
		await writeFile(target, "#!/bin/sh\n", { mode: 0o755 });
		await chmod(target, 0o755);
		await symlink(target, join(pathDirectory, "probe"));

		expect(resolveSandboxExecutable("probe", root, pathDirectory)).toBe(await realpath(target));
		expect(resolveSandboxExecutable("probe", root, relative(root, pathDirectory))).toBe(await realpath(target));
		expect(resolveSandboxExecutable("missing-probe", root, pathDirectory)).toBeUndefined();
	});

	test("fails closed on unsupported platforms", async () => {
		const { config } = await launch();
		expect(() => sandboxedKernelCommand({ ...config, platform: "win32" }, [])).toThrow(
			"supported only on Linux and macOS",
		);
	});
});
