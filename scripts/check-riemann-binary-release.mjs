#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_FILES = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"riemann-python/requirements.lock",
	"riemann-python/prelude.py",
	"riemann-prompts/system/main.md",
	"riemann-prompts/system/child.md",
	"riemann-prompts/system/compaction.md",
	"node_modules/zeromq/lib/index.js",
];

export async function validateRiemannBinaryRelease(directory, platform) {
	const binary = platform.startsWith("windows-") ? "riemann.exe" : "riemann";
	const platformFiles = platform.startsWith("windows-") ? [] : ["node_modules/zeromq/lib/index.js"];
	for (const path of [binary, ...REQUIRED_FILES, ...platformFiles]) await access(join(directory, path));
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
	if (manifest.name !== "riemann-agent") throw new Error(`Unexpected package name: ${manifest.name}`);
	if (manifest.bin?.riemann !== "dist/cli.js") throw new Error("package.json does not declare the riemann CLI");
	return { directory, platform, binary: join(directory, binary) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [directory, platform] = process.argv.slice(2);
	if (!directory || !platform) throw new Error("Usage: check-riemann-binary-release.mjs <directory> <platform>");
	const result = await validateRiemannBinaryRelease(directory, platform);
	console.log(`Validated ${basename(result.binary)} release for ${platform}`);
}
