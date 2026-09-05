import { describe, expect, test, vi } from "vitest";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { decodeJupyterMessage, encodeJupyterMessage } from "../src/riemann/kernel/wire.ts";

const options = { type: "test", session: "wire-test", username: "test", key: "secret" };

describe("Jupyter wire validation", () => {
	test("does not serialize diagnostic paths for valid payloads", () => {
		const content = { rows: Array.from({ length: 100 }, (_, id) => ({ id, text: "完整数据" })) };
		const stringify = vi.spyOn(JSON, "stringify");
		try {
			const encoded = encodeJupyterMessage({ ...options, content });
			expect(stringify).toHaveBeenCalledTimes(2);
			stringify.mockClear();
			expect(decodeJupyterMessage(encoded.frames, options.key)?.content).toEqual(content);
			expect(stringify).not.toHaveBeenCalled();
		} finally {
			stringify.mockRestore();
		}
	});

	test("preserves strict validation and precise nested error paths", () => {
		for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, 1n]) {
			expect(() =>
				encodeJupyterMessage({
					...options,
					content: { rows: [{ 'a"b': value }] } as unknown as Record<string, JsonValue>,
				}),
			).toThrow(String.raw`at content["rows"][0]["a\"b"]`);
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() =>
			encodeJupyterMessage({ ...options, content: { cyclic } as unknown as Record<string, JsonValue> }),
		).toThrow('cyclic JSON value at content["cyclic"]["self"]');
		expect(() => encodeJupyterMessage({ ...options, content: { bad: { [Symbol("bad")]: true } } })).toThrow(
			'non-string dict key at content["bad"]',
		);
	});

	test("allows shared objects and authenticates the complete payload", () => {
		const shared = { text: "same", count: Number.MAX_SAFE_INTEGER };
		const content = { values: [shared, shared, null] };
		const encoded = encodeJupyterMessage({ ...options, content });
		expect(decodeJupyterMessage(encoded.frames, options.key)?.content).toEqual(content);
		const modified = [...encoded.frames];
		modified[5] = Buffer.from('{"different":true}');
		expect(decodeJupyterMessage(modified, options.key)).toBeUndefined();
	});
});
