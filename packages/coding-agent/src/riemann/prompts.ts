import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir, isBunBinary } from "../config.ts";

export type RiemannPromptName = "system/main.md" | "system/child.md" | "system/compaction.md";

const cache = new Map<RiemannPromptName, string>();

function getPromptRoot(): string {
	const packageDir = getPackageDir();
	if (isBunBinary) return join(packageDir, "riemann-prompts");
	const sourceRoot = join(packageDir, "src", "riemann", "prompts");
	return existsSync(sourceRoot) ? sourceRoot : join(packageDir, "dist", "riemann", "prompts");
}

export function loadRiemannPrompt(name: RiemannPromptName): string {
	const cached = cache.get(name);
	if (cached !== undefined) return cached;
	const content = readFileSync(join(getPromptRoot(), name), "utf8").trim();
	cache.set(name, content);
	return content;
}

export function renderRiemannPrompt(name: RiemannPromptName, values: Readonly<Record<string, string>> = {}): string {
	let content = loadRiemannPrompt(name);
	for (const [key, value] of Object.entries(values)) {
		content = content.replaceAll(`{{${key}}}`, value);
	}
	const unresolved = [...content.matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)].map((match) => match[1]);
	if (unresolved.length > 0) {
		throw new Error(`Missing Riemann prompt values: ${[...new Set(unresolved)].join(", ")}`);
	}
	return content;
}
