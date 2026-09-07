import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOpenAICodexContext } from "@earendil-works/pi-ai/api/openai-codex-context";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import { CodexContextCache, codexContextCacheKey } from "../src/core/codex-context-cache.ts";

vi.mock("@earendil-works/pi-ai/api/openai-codex-context", () => ({
	discoverOpenAICodexContext: vi.fn(),
}));

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.resetAllMocks();
});

function token(account: string, expiry: number): string {
	return `header.${Buffer.from(
		JSON.stringify({
			exp: expiry,
			"https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" },
		}),
	).toString("base64url")}.signature`;
}

it("persists capabilities across instances and token refresh, isolating accounts and backends", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codex-cache-"));
	directories.push(directory);
	const model = getModel("openai-codex", "gpt-5.4")!;
	const first = { apiKey: token("first", 1) };
	const renewed = { apiKey: token("first", 2) };
	const result = {
		eligible: true,
		model: {
			slug: model.id,
			supports_experimental_context: true,
			truncation_policy: { mode: "bytes" as const, limit: 1000 },
		},
	};
	vi.mocked(discoverOpenAICodexContext).mockResolvedValue(result);
	const cache = new CodexContextCache(directory);
	await Promise.all([cache.get(model, first), cache.get(model, first)]);
	const next = new CodexContextCache(directory);
	expect(await next.get(model, renewed)).toEqual(result);
	expect(discoverOpenAICodexContext).toHaveBeenCalledTimes(1);
	expect(codexContextCacheKey(model, first)).toBe(codexContextCacheKey(model, renewed));
	expect(codexContextCacheKey(model, first)).not.toBe(codexContextCacheKey(model, { apiKey: token("second", 2) }));
	expect(codexContextCacheKey(model, first)).not.toBe(
		codexContextCacheKey({ ...model, baseUrl: "https://other.invalid" }, first),
	);
	expect(codexContextCacheKey(model, first)).not.toBe(codexContextCacheKey(model, { ...first, clientVersion: "new" }));
	const path = join(directory, "cache", "codex-context", `${codexContextCacheKey(model, first)}.json`);
	expect(readFileSync(path, "utf8")).not.toContain(first.apiKey);
	expect(readdirSync(join(directory, "cache", "codex-context"))).toHaveLength(1);

	// A stale entry stays usable when its background refresh fails.
	writeFileSync(path, JSON.stringify({ version: 1, fetchedAt: 0, result }));
	vi.mocked(discoverOpenAICodexContext).mockRejectedValue(new Error("offline"));
	expect(await new CodexContextCache(directory).get(model, renewed)).toEqual(result);
	expect(JSON.parse(readFileSync(path, "utf8")).result).toEqual(result);
});

it("cancels one discovery waiter while letting another persist the shared result", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codex-cache-abort-"));
	directories.push(directory);
	const model = getModel("openai-codex", "gpt-5.4")!;
	let resolveDiscovery!: (result: Awaited<ReturnType<typeof discoverOpenAICodexContext>>) => void;
	const discovery = new Promise<Awaited<ReturnType<typeof discoverOpenAICodexContext>>>((resolve) => {
		resolveDiscovery = resolve;
	});
	vi.mocked(discoverOpenAICodexContext).mockReturnValue(discovery);
	const cache = new CodexContextCache(directory);
	const controller = new AbortController();
	const cancelled = cache.get(model, { apiKey: "test", signal: controller.signal });
	const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
	const waiting = cache.get(model, { apiKey: "test" });
	await vi.waitFor(() => expect(discoverOpenAICodexContext).toHaveBeenCalledTimes(1));
	controller.abort();
	await rejected;
	resolveDiscovery({ eligible: false });
	expect(await waiting).toEqual({ eligible: false });
	expect(await new CodexContextCache(directory).get(model, { apiKey: "test" })).toEqual({ eligible: false });
	expect(discoverOpenAICodexContext).toHaveBeenCalledTimes(1);
});
