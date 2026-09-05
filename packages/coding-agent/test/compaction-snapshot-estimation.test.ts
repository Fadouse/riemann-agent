import { expect, test } from "vitest";
import { estimateContextTokens, estimateTokens } from "../src/core/compaction/compaction.ts";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";
import { FRAME_TOKEN_ESTIMATE } from "../src/riemann/snapshot-compaction.ts";

test("includes every snapshot archive text and image block in context estimates", () => {
	const message = createCompactionSummaryMessage("1234", 100000, "2026-01-01", [
		{ type: "text", text: "x".repeat(40000) },
		{ type: "image", data: "a".repeat(170000), mimeType: "image/png" },
		{ type: "text", text: "y".repeat(4000) },
		{ type: "image", data: "b".repeat(170000), mimeType: "image/png" },
	]);
	expect(estimateTokens(message)).toBe(11001 + 2 * FRAME_TOKEN_ESTIMATE);
	expect(estimateContextTokens([message]).tokens).toBe(11001 + 2 * FRAME_TOKEN_ESTIMATE);
	message.blocks![0] = { type: "text", text: "x".repeat(80000) };
	expect(estimateTokens(message)).toBe(21001 + 2 * FRAME_TOKEN_ESTIMATE);
	expect(estimateTokens(createCompactionSummaryMessage("1234", 0, "2026-01-01"))).toBe(1);
});
