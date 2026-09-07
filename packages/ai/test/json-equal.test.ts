import { expect, it, vi } from "vitest";
import { jsonValuesEqual } from "../src/utils/json-equal.ts";

it.each([
	[null, null],
	[null, undefined],
	[0, -0],
	[NaN, null],
	[Infinity, -Infinity],
	["abc", "abd"],
	[true, false],
	[[], {}],
	[[1], [1, 2]],
	[{ a: 1, missing: undefined }, { a: 1 }],
	[{ a: 1, ignored: Symbol("ignored") }, { a: 1 }],
	[{ a: 1, ignored: () => 1 }, { a: 1 }],
	[
		[undefined, NaN, Symbol("ignored"), () => 1],
		[null, null, null, null],
	],
	[
		{ a: 1, b: 2 },
		{ b: 2, a: 1 },
	],
	[{ input: [{ text: "hello", nested: { value: 1 } }] }, { input: [{ text: "hello", nested: { value: 2 } }] }],
	[new Date(0), new Date(0)],
	[new Date(0), new Date(1)],
	[{ toJSON: () => ({ a: 1 }) }, { a: 1 }],
])("preserves serialized comparison for request values (%#)", (left, right) => {
	expect(jsonValuesEqual(left, right)).toBe(JSON.stringify(left) === JSON.stringify(right));
});

it("compares opaque payloads without serializing them", () => {
	const text = "A".repeat(16 * 1024 * 1024);
	const stringify = vi.spyOn(JSON, "stringify");
	try {
		const equal = jsonValuesEqual({ input: [{ encrypted_content: text }] }, { input: [{ encrypted_content: text }] });
		const calls = stringify.mock.calls.length;
		expect(equal).toBe(true);
		expect(calls).toBe(0);
	} finally {
		stringify.mockRestore();
	}
});
