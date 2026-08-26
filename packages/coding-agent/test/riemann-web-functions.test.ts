import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebFunctions } from "../src/riemann/functions/web.ts";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(value: JsonValue): Record<string, JsonValue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected record");
	return value;
}

async function webDefinitions(
	apiKey = "exa-test-key",
	previewChars = 10_000,
	resolveHostname: (hostname: string) => Promise<string[]> = async () => ["93.184.216.34"],
) {
	const root = await mkdtemp(join(tmpdir(), "riemann-web-functions-"));
	roots.push(root);
	const store = new RiemannStore(join(root, "agent"));
	const run = store.openRun("web-test", root);
	const artifacts = new ArtifactStore(store, run.id);
	const definitions = new WebFunctions(apiKey, artifacts, previewChars, resolveHostname, (input, init) =>
		globalThis.fetch(input, init),
	).definitions();
	const search = definitions.find((definition) => definition.name === "search");
	const fetchDefinition = definitions.find((definition) => definition.name === "fetch");
	if (!search || !fetchDefinition) throw new Error("web functions are unavailable");
	return { search, fetchDefinition, artifacts, store };
}

describe("Riemann web ABI v2 contracts", () => {
	test("publishes strict input and exact stable output schemas", async () => {
		const { search, fetchDefinition, store } = await webDefinitions();
		try {
			for (const definition of [search, fetchDefinition]) {
				expect(definition).toMatchObject({
					visibility: "public",
					inputSchema: { type: "object", additionalProperties: false },
				});
				expect(definition).not.toHaveProperty("parameters");
				expect(definition).not.toHaveProperty("returns");
			}
			expect(
				Value.Check(search.inputSchema, {
					query: "q",
					domains: ["example.com"],
				}),
			).toBe(true);
			expect(
				Value.Check(search.inputSchema, {
					query: "q",
					domains: ["https://example.com"],
				}),
			).toBe(false);
			expect(Value.Check(search.inputSchema, { query: "q", since: "last week" })).toBe(false);
		} finally {
			store.close();
		}
	});
});

describe("Riemann web search", () => {
	test("normalizes strict filters and returns exact SearchHit fields", async () => {
		const { search, store } = await webDefinitions();
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{
							id: "one",
							url: "https://example.com/article",
							title: null,
							highlights: ["first", "second"],
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const result = await search.handler(
				{
					query: "test",
					domains: ["EXAMPLE.COM", "example.com"],
					since: "2024-01-02T03:04:05+02:00",
				},
				new AbortController().signal,
			);
			expect(result).toEqual([
				{
					$riemann: "search_hit",
					title: "https://example.com/article",
					url: "https://example.com/article",
					snippet: "first\n\nsecond",
					published_at: null,
				},
			]);
			const init = fetchMock.mock.calls[0]?.[1];
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body).toMatchObject({
				includeDomains: ["example.com"],
				startPublishedDate: "2024-01-02T01:04:05.000Z",
			});
		} finally {
			store.close();
		}
	});

	test("rejects invalid domains and calendar timestamps before fetching", async () => {
		const { search, store } = await webDefinitions();
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		try {
			await expect(
				search.handler({ query: "q", domains: ["https://example.com"] }, new AbortController().signal),
			).rejects.toMatchObject({ code: "invalid_arguments" });
			await expect(
				search.handler({ query: "q", domains: ["127.0.0.1"] }, new AbortController().signal),
			).rejects.toMatchObject({ code: "invalid_arguments" });
			await expect(
				search.handler({ query: "q", since: "2024-02-31T00:00:00Z" }, new AbortController().signal),
			).rejects.toMatchObject({ code: "invalid_arguments" });
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	test("normalizes provider, transport, and cancellation failures", async () => {
		const { search, store } = await webDefinitions();
		try {
			vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 502 })));
			await expect(search.handler({ query: "q" }, new AbortController().signal)).rejects.toMatchObject({
				code: "provider_error",
			});

			vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("socket details")));
			await expect(search.handler({ query: "q" }, new AbortController().signal)).rejects.toMatchObject({
				code: "network_error",
				message: "Exa search failed",
			});

			const controller = new AbortController();
			controller.abort();
			vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError")));
			await expect(search.handler({ query: "q" }, controller.signal)).rejects.toMatchObject({
				code: "cancelled",
			});
		} finally {
			store.close();
		}
	});
});

describe("Riemann web fetch", () => {
	test("returns untrusted text without injecting a repeated warning", async () => {
		const { fetchDefinition, store } = await webDefinitions();
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response("plain body", {
					headers: { "content-type": "text/plain; charset=utf-8" },
				}),
			),
		);
		try {
			const result = await fetchDefinition.handler(
				{ url: "https://example.test/plain" },
				new AbortController().signal,
			);
			expect(result).toEqual({
				$riemann: "document",
				url: "https://example.test/plain",
				title: null,
				text: "plain body",
				content_type: "text/plain",
				artifact: null,
				trust: "untrusted",
			});
		} finally {
			store.close();
		}
	});

	test("stores binary bytes without lossy text decoding", async () => {
		const { fetchDefinition, artifacts, store } = await webDefinitions();
		const bytes = Buffer.from([0x00, 0xff, 0x41]);
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response(bytes, {
					headers: { "content-type": "application/octet-stream" },
				}),
			),
		);
		try {
			const result = record(
				await fetchDefinition.handler({ url: "https://example.test/file.bin" }, new AbortController().signal),
			);
			expect(result).toMatchObject({
				text: "",
				content_type: "application/octet-stream",
				trust: "untrusted",
			});
			const artifact = record(result.artifact);
			expect(await artifacts.readBuffer(String(artifact.handle))).toEqual(bytes);
		} finally {
			store.close();
		}
	});

	test("artifactizes invalid text bytes instead of replacing them", async () => {
		const { fetchDefinition, store } = await webDefinitions();
		vi.stubGlobal(
			"fetch",
			vi.fn<typeof fetch>().mockResolvedValue(
				new Response(Buffer.from([0xff]), {
					headers: { "content-type": "text/plain; charset=utf-8" },
				}),
			),
		);
		try {
			const result = record(
				await fetchDefinition.handler({ url: "https://example.test/invalid.txt" }, new AbortController().signal),
			);
			expect(result).toMatchObject({ text: "", trust: "untrusted" });
			expect(result.artifact).not.toBeNull();
		} finally {
			store.close();
		}
	});
	test("blocks private destinations before making a request", async () => {
		const { fetchDefinition, store } = await webDefinitions("exa-test-key", 10_000, async () => ["127.0.0.1"]);
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		try {
			await expect(
				fetchDefinition.handler({ url: "https://internal.test/secret" }, new AbortController().signal),
			).rejects.toMatchObject({ code: "permission_denied" });
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	test("revalidates redirect destinations", async () => {
		const { fetchDefinition, store } = await webDefinitions();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			await expect(
				fetchDefinition.handler({ url: "https://example.test/start" }, new AbortController().signal),
			).rejects.toMatchObject({ code: "permission_denied" });
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			store.close();
		}
	});
});
