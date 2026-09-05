import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapTextWithAnsi, wrapTextWithAnsiIterator } from "../src/utils.ts";

describe("wrapped line iteration", () => {
	it("does not split the full multiline source into a retained line array", (context) => {
		const text = "line\r\n".repeat(20_000);
		const split = context.mock.method(String.prototype, "split");
		let count = 0;
		for (const line of wrapTextWithAnsiIterator(text, 80)) {
			assert.equal(line, count < 20_000 ? "line" : "");
			count++;
		}
		assert.equal(count, 20_001);
		assert.equal(
			split.mock.calls.some((call) => String(call.this) === text),
			false,
		);
	});

	it("preserves style, line endings, hyperlinks and Unicode for incremental consumers", () => {
		const input = "\x1b[31ma\r\nb\rc\n";
		assert.deepEqual([...wrapTextWithAnsiIterator(input, 80)], ["\x1b[31ma", "\x1b[31mb", "\x1b[31mc", "\x1b[31m"]);
		const samples = [
			"",
			"  ",
			"中😀e\u0301".repeat(40),
			"\ud800\udfff\u202e\x00\t",
			`\x1b[4;44m${"longword".repeat(100)}\x1b[0m`,
			`\x1b]8;;https://example.com\x07${"longword".repeat(100)}\nend\x1b]8;;\x07`,
		];
		for (const text of samples)
			for (const width of [0, 1, 2, 10, 80]) {
				const iterator = wrapTextWithAnsiIterator(text, width);
				const actual: string[] = [];
				for (const line of iterator) actual.push(line);
				assert.deepEqual(actual, wrapTextWithAnsi(text, width));
			}
	});
});
