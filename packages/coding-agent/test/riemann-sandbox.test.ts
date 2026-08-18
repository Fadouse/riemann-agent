import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type FilesystemSnapshot, fileAccessPolicy } from "../src/riemann/access-policy.ts";
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
