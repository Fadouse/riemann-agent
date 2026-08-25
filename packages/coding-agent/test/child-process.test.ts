import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import { signalProcessGroup, waitForChildProcess } from "../src/utils/child-process.ts";

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("waitForChildProcess timed out")), 500);
			timer.unref();
		}),
	]);
}

describe("waitForChildProcess", () => {
	test("resolves when called after a child already closed", async () => {
		const child = spawn(process.execPath, ["-e", ""], { stdio: ["ignore", "pipe", "pipe"] });
		await once(child, "close");

		await expect(withTimeout(waitForChildProcess(child))).resolves.toBe(0);
	});

	test("preserves a null exit code for a child terminated by signal", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		await once(child, "spawn");
		child.kill("SIGTERM");
		await once(child, "close");

		await expect(withTimeout(waitForChildProcess(child))).resolves.toBeNull();
	});

	test.skipIf(process.platform === "win32")("signals a detached child process group", async () => {
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(descendant.pid);
setInterval(() => {}, 1000);`,
			],
			{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		const [chunk] = await once(child.stdout, "data");
		const descendantPid = Number(String(chunk).trim());
		try {
			expect(signalProcessGroup(child, "SIGTERM")).toBe(true);
			await expect(withTimeout(waitForChildProcess(child))).resolves.toBeNull();
			await expect(
				withTimeout(
					new Promise<void>((resolve) => {
						const check = () => {
							try {
								process.kill(descendantPid, 0);
								setTimeout(check, 10);
							} catch {
								resolve();
							}
						};
						check();
					}),
				),
			).resolves.toBeUndefined();
		} finally {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The process group is already gone.
			}
		}
	});
});
