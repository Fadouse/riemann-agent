import { describe, expect, it, vi } from "vitest";
import { parseStreamingJson, StreamingJsonParser } from "../src/utils/json-parse.ts";

function compareChunks(json: string, size: number): void {
	const parser = new StreamingJsonParser<unknown>();
	for (let end = size; end < json.length + size; end += size) {
		const prefix = json.slice(0, end);
		expect(parser.append(json.slice(end - size, end)), `${JSON.stringify(prefix)}, chunk=${size}`).toEqual(
			parseStreamingJson(prefix),
		);
	}
}

describe("StreamingJsonParser", () => {
	it("matches every partial prefix, including repair and permissive legacy syntax", () => {
		const samples = [
			"",
			" ",
			"null",
			"true",
			"false",
			"-",
			"0",
			"-12.5e-12",
			"1.",
			"1e",
			"1E-",
			"01",
			"NaN",
			"Infinity",
			"-Infinity",
			'"abc  "',
			'" leading and trailing \u00a0\ufeff  "',
			String.raw`"a\n\r\t\b\f\/\\\"\u1234\ud800\udfff"`,
			'{"a":true,"b":null,"c":false,"d":-12.5e+3,"e":1E-3}',
			'{"x":[1,{"a":"abc","b":[false,null,"hello"]}],"y":{}}',
			'{"same":1,"same":{"a":3,"a":[2,3]}}',
			'{"__proto__":{"polluted":true},"constructor":{"prototype":{"p":1}}}',
			'{"a":"raw\nnewline\tcontrol","b":1}',
			String.raw`{"a":"bad\Hescape","b":"ok"}`,
			String.raw`{"a":"bad\u1H34escape","b":2}`,
			'{"a":1,}',
			"[1,]",
			'{"a" 1}',
			"[1 2]",
			'{"a":t, "b":2}',
			'{"a":"\ud800","b":3}',
			'{"a":1}garbage',
			"[true,false]garbage",
			String.raw`{"a":"ends in incomplete unicode \u12`,
			'{"a": [1, 2',
			'{"a": ["text  ',
			'{"a":"\u2028\u2029 "}',
		];
		for (const json of samples) for (const size of [1, 2, 3, 7, 64]) compareChunks(json, size);
	});

	it("matches deterministic generated documents and malformed mutations at every delta", () => {
		let seed = 714;
		const next = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed;
		};
		const value = (depth: number): unknown => {
			const choice = next() % (depth ? 6 : 4);
			if (choice === 0) return null;
			if (choice === 1) return next() % 2 === 0;
			if (choice === 2) return (next() - 2 ** 31) / 100;
			if (choice === 3) return ["abc ", "\n\t\r", '\\"', "\ud800", "\u00a0", "hello", "\ufeff"][next() % 7];
			if (choice === 4) return Array.from({ length: next() % 4 }, () => value(depth - 1));
			return Object.fromEntries(Array.from({ length: next() % 4 }, (_, index) => [String(index), value(depth - 1)]));
		};
		for (let index = 0; index < 200; index++) {
			const json = JSON.stringify({ value: value(3), text: value(0) });
			compareChunks(json, 1 + (next() % 9));
			const at = next() % json.length;
			compareChunks(`${json.slice(0, at)}\\H\n${json.slice(at)}`, 1 + (next() % 5));
		}
	});

	it("matches long code strings with escaped quotes, newlines, paths and surrogate pairs", () => {
		const code = 'const name = "example";\nconst path = "C:\\temp";\n// \ud83d\ude80\n'.repeat(256);
		const json = JSON.stringify({ code, nested: [{ value: "done" }] });
		compareChunks(json, 64);
		compareChunks(json, 257);
	});

	it("isolates old snapshots and caller mutations from later updates", () => {
		const parser = new StreamingJsonParser<{ data: string; items: Array<{ n: number }> }>();
		const first = parser.append('{"items":[{"n":1}],"data":"a');
		const saved = structuredClone(first);
		const second = parser.append("b");
		expect(first).toEqual(saved);
		first.items[0].n = 99;
		first.data = "changed";
		second.items.push({ n: 8 });
		expect(parser.append('c"}')).toEqual({ items: [{ n: 1 }], data: "abc" });
	});

	it("materializes deeply nested complete inputs without a recursive snapshot walk", () => {
		const depth = 15000;
		const json = `${"[".repeat(depth)}0${"]".repeat(depth)}`;
		let actual = new StreamingJsonParser<unknown>().append(json);
		for (let index = 0; index < depth; index++) {
			if (!Array.isArray(actual) || actual.length !== 1) throw new Error(`Invalid array at depth ${index}`);
			actual = actual[0];
		}
		expect(actual).toBe(0);
	});

	it("does not parse or repair growing string prefixes", () => {
		const json = JSON.stringify({ text: "x".repeat(65536) });
		const parser = new StreamingJsonParser();
		const parse = vi.spyOn(JSON, "parse");
		let result: unknown;
		try {
			for (let index = 0; index < json.length; index += 64) result = parser.append(json.slice(index, index + 64));
			expect(parse.mock.calls.reduce((total, [input]) => total + input.length, 0)).toBeLessThan(json.length);
		} finally {
			parse.mockRestore();
		}
		expect(result).toEqual({ text: "x".repeat(65536) });
	});
});
