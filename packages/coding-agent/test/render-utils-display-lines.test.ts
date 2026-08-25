import { describe, expect, it } from "vitest";
import { splitDisplayLines } from "../src/core/tools/render-utils.ts";

describe("splitDisplayLines", () => {
	it("treats one trailing newline as a terminator", () => {
		expect(splitDisplayLines("one\ntwo\n")).toEqual(["one", "two"]);
	});

	it("preserves one intentional blank row from two trailing newlines", () => {
		expect(splitDisplayLines("one\ntwo\n\n")).toEqual(["one", "two", ""]);
	});
});
