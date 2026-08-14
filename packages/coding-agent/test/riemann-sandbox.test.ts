import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { macOSSandboxProfile, sandboxedKernelCommand } from "../src/riemann/kernel/sandbox.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function policy(workspaceWritable: boolean) {
	const root = await mkdtemp(join(tmpdir(), "riemann-sandbox-policy-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const connectionDir = join(root, "connection");
	await Promise.all([mkdir(workspace), mkdir(connectionDir)]);
	return {
		workspace,
		filesystemScope: "workspace" as const,
		workspaceWritable,
		connectionDir,
		python: process.execPath,
	};
}

describe("Riemann kernel system sandbox", () => {
	test("builds a network-isolated Linux bubblewrap command with capability-derived writes", async () => {
		process.env.RIEMANN_TEST_SECRET = "must-not-leak";
		try {
			const readOnly = await policy(false);
			const command = sandboxedKernelCommand({ ...readOnly, platform: "linux", bubblewrapPath: "/usr/bin/bwrap" }, [
				"-m",
				"ipykernel_launcher",
			]);
			expect(command.command).toBe("/usr/bin/bwrap");
			expect(command.args).toContain("--unshare-all");
			expect(command.args).toContain("--new-session");
			expect(command.transport).toBe("ipc");
			expect(command.env.RIEMANN_TEST_SECRET).toBeUndefined();
			expect(command.env.PYTHONNOUSERSITE).toBe("1");
			const workspaceBind = command.args.findIndex(
				(value, index) => value === readOnly.workspace && command.args[index - 1] === "--bind",
			);
			expect(workspaceBind).toBe(-1);

			const writable = await policy(true);
			const writableCommand = sandboxedKernelCommand(
				{ ...writable, platform: "linux", bubblewrapPath: "/usr/bin/bwrap" },
				[],
			);
			expect(
				writableCommand.args.some(
					(value, index) => value === writable.workspace && writableCommand.args[index - 1] === "--bind",
				),
			).toBe(true);
		} finally {
			delete process.env.RIEMANN_TEST_SECRET;
		}
	});
	test("masks nested Riemann state while remounting only the managed runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-sandbox-nested-state-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const agentDir = join(workspace, ".riemann", "agent");
		const runtime = join(agentDir, "runtime", "python-v1");
		const python = join(runtime, "bin", "python");
		const connectionDir = join(root, "connection");
		await mkdir(join(runtime, "bin"), { recursive: true });
		await Promise.all([
			mkdir(connectionDir),
			writeFile(python, ""),
			writeFile(join(agentDir, "auth.json"), "secret"),
		]);
		const command = sandboxedKernelCommand(
			{
				agentDir,
				workspace,
				filesystemScope: "workspace",
				workspaceWritable: true,
				connectionDir,
				python,
				platform: "linux",
				bubblewrapPath: "/usr/bin/bwrap",
			},
			[],
		);
		const workspaceBind = command.args.findIndex(
			(value, index) =>
				value === "--bind" && command.args[index + 1] === workspace && command.args[index + 2] === workspace,
		);
		const stateMask = command.args.findIndex(
			(value, index) => value === "--tmpfs" && command.args[index + 1] === agentDir,
		);
		const runtimeBind = command.args.findIndex(
			(value, index) =>
				value === "--ro-bind" && command.args[index + 1] === runtime && command.args[index + 2] === runtime,
		);
		const stateReadOnly = command.args.findIndex(
			(value, index) => value === "--remount-ro" && command.args[index + 1] === agentDir,
		);
		expect(workspaceBind).toBeGreaterThan(-1);
		expect(stateMask).toBeGreaterThan(workspaceBind);
		expect(runtimeBind).toBeGreaterThan(stateMask);
		expect(stateReadOnly).toBeGreaterThan(runtimeBind);

		const profile = macOSSandboxProfile({
			agentDir,
			workspace,
			filesystemScope: "workspace",
			workspaceWritable: true,
			connectionDir,
			python,
		});
		const excluded = JSON.stringify(agentDir);
		expect(profile).toContain(`(require-not (literal ${excluded}))`);
		expect(profile).toContain(`(require-not (subpath ${excluded}))`);
		expect(profile).toContain(`(allow file-read* (subpath ${JSON.stringify(runtime)}))`);
		expect(profile).not.toContain(`(allow file-write* (subpath ${excluded}))`);
	});

	test("builds a deny-by-default macOS Seatbelt profile with only the kernel IPC socket", async () => {
		const readOnly = await policy(false);
		const profile = macOSSandboxProfile({ ...readOnly, platform: "darwin" });
		expect(profile).toContain("(deny default)");
		expect(profile).not.toContain("(allow network*)\n");
		expect(profile).toContain(`(allow network* (subpath ${JSON.stringify(readOnly.connectionDir)}))`);
		expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(readOnly.workspace)}))`);
	});

	test("grants host filesystem access only for the explicit host scope", async () => {
		const writable = await policy(true);
		const linux = sandboxedKernelCommand(
			{ ...writable, filesystemScope: "host", platform: "linux", bubblewrapPath: "/usr/bin/bwrap" },
			[],
		);
		expect(linux.args).toEqual(expect.arrayContaining(["--bind", "/", "/"]));

		const macOS = macOSSandboxProfile({ ...writable, filesystemScope: "host", platform: "darwin" });
		expect(macOS).toContain("(allow file-read*)");
		expect(macOS).toContain("(allow file-write*)");
	});

	test("fails closed on unsupported platforms", async () => {
		const base = await policy(false);
		expect(() => sandboxedKernelCommand({ ...base, platform: "win32" }, [])).toThrow(
			"supported only on Linux and macOS",
		);
	});
});
