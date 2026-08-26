import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { truncateLine, truncateTail } from "../src/core/tools/truncate.ts";
import { WebFunctions } from "../src/riemann/functions/web.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";
import { sanitizeBinaryOutput } from "../src/utils/shell.ts";
import { graphemeSafePrefix, graphemeSafeSuffix } from "../src/utils/text.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("grapheme-safe text limits", () => {
	test("keeps prefix and suffix limits on grapheme boundaries", () => {
		expect(graphemeSafePrefix("a😀b", 2)).toBe("a");
		expect(graphemeSafeSuffix("a😀b", 2)).toBe("b");
		expect(graphemeSafePrefix("a👩🏽‍💻b", 4)).toBe("a");
		expect(graphemeSafeSuffix("a👩🏽‍💻b", 4)).toBe("b");
	});

	test("does not split emoji in tool output truncation", () => {
		expect(truncateLine("a😀b", 2)).toEqual({
			text: "a... [truncated]",
			wasTruncated: true,
		});
		expect(truncateTail("👩‍💻", { maxBytes: 8 })).toMatchObject({
			content: "",
			lastLinePartial: true,
			outputBytes: 0,
		});
	});

	test("normalizes lone surrogates and removes terminal-affecting controls", () => {
		expect(sanitizeBinaryOutput("a\ud800b\u202ec\x7fd")).toBe("a�bcd");
	});
});

describe("Riemann web decoding", () => {
	test("honors supported response charsets and falls back to UTF-8", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-web-unicode-"));
		roots.push(root);
		const store = new RiemannStore(join(root, "agent"));
		try {
			const run = store.openRun("web-unicode", root);
			const web = new WebFunctions(
				undefined,
				new ArtifactStore(store, run.id),
				10_000,
				async () => ["93.184.216.34"],
				(input, init) => globalThis.fetch(input, init),
			);
			const definition = web.definitions().find((item) => item.name === "fetch");
			if (!definition) throw new Error("web.fetch is unavailable");
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(
					new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), {
						headers: { "content-type": 'text/plain; charset="windows-1252"' },
					}),
				)
				.mockResolvedValueOnce(
					new Response(Buffer.from("snowman: ☃", "utf8"), {
						headers: {
							"content-type": "text/plain; charset=not-a-real-charset",
						},
					}),
				);
			vi.stubGlobal("fetch", fetchMock);

			const windowsResult = await definition.handler(
				{ url: "https://example.test/windows" },
				new AbortController().signal,
			);
			const fallbackResult = await definition.handler(
				{ url: "https://example.test/fallback" },
				new AbortController().signal,
			);
			expect(windowsResult).toMatchObject({ text: "café", trust: "untrusted" });
			expect(fallbackResult).toMatchObject({
				text: "snowman: ☃",
				trust: "untrusted",
			});
			expect(windowsResult).not.toMatchObject({
				text: expect.stringContaining("Untrusted external web content"),
			});
		} finally {
			store.close();
		}
	});
});
