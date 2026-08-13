import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateRiemannBinaryRelease } from "./check-riemann-binary-release.mjs";

const required = [
	"README.md",
	"CHANGELOG.md",
	"riemann",
	"riemann-python/requirements.lock",
	"riemann-python/prelude.py",
	"riemann-prompts/system/main.md",
	"riemann-prompts/system/child.md",
	"riemann-prompts/system/compaction.md",
	"node_modules/zeromq/lib/index.js",
];

test("validates required Riemann Bun release assets", async () => {
	const root = await mkdtemp(join(tmpdir(), "riemann-binary-release-"));
	try {
		for (const path of required) {
			await mkdir(join(root, path, ".."), { recursive: true });
			await writeFile(join(root, path), "fixture");
		}
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "riemann-agent", bin: { riemann: "dist/cli.js" } }));
		const result = await validateRiemannBinaryRelease(root, "linux-x64");
		assert.equal(result.binary, join(root, "riemann"));
		await rm(join(root, "riemann-python", "requirements.lock"));
		await assert.rejects(validateRiemannBinaryRelease(root, "linux-x64"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
