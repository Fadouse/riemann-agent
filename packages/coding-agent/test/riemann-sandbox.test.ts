import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
	const snapshotPath = join(root, "state", "kernel.dill");
	await Promise.all([mkdir(workspace), mkdir(connectionDir), mkdir(join(root, "state"))]);
	return { workspace, workspaceWritable, connectionDir, snapshotPath, python: process.execPath };
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

	test("builds a deny-by-default macOS Seatbelt profile with only the kernel IPC socket", async () => {
		const readOnly = await policy(false);
		const profile = macOSSandboxProfile({ ...readOnly, platform: "darwin" });
		expect(profile).toContain("(deny default)");
		expect(profile).not.toContain("(allow network*)\n");
		expect(profile).toContain(`(allow network* (subpath ${JSON.stringify(readOnly.connectionDir)}))`);
		expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(readOnly.workspace)}))`);
	});

	test("fails closed on unsupported platforms", async () => {
		const base = await policy(false);
		expect(() => sandboxedKernelCommand({ ...base, platform: "win32" }, [])).toThrow(
			"supported only on Linux and macOS",
		);
	});
});
