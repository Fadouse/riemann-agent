import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, test } from "vitest";
import { waitForChildProcess } from "../src/utils/child-process.ts";

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
});
