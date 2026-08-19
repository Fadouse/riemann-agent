import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("processFileArguments", () => {
	test("preserves file order and skips empty files", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-file-processor-"));
		roots.push(root);
		const first = join(root, "first.txt");
		const empty = join(root, "empty.txt");
		const second = join(root, "second.txt");
		await Promise.all([writeFile(first, "first"), writeFile(empty, ""), writeFile(second, "second")]);

		const result = await processFileArguments([first, empty, second]);

		expect(result.images).toEqual([]);
		expect(result.text).toBe(
			`<file name="${first}">
first
</file>
<file name="${second}">
second
</file>
`,
		);
	});
});
