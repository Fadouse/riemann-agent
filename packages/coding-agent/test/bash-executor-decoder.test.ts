import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";

describe("executeBashWithOperations UTF-8 decoding", () => {
	it("flushes an incomplete UTF-8 sequence once at EOF", async () => {
		const streamedChunks: string[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from([0xe2, 0x82]));
				return { exitCode: 0 };
			},
		};

		const result = await executeBashWithOperations("incomplete", process.cwd(), operations, {
			onChunk: (chunk) => streamedChunks.push(chunk),
		});

		expect(result.output).toBe("�");
		expect(streamedChunks.join("")).toBe("�");
	});
});
