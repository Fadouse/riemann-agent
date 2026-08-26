import { describe, expect, test } from "vitest";
import { type ConfiguredCompactionStrategy, resolveCompactionStrategy } from "../src/riemann/compaction-strategy.ts";

describe("Riemann compaction strategy resolution", () => {
	test("resolves automatic to OpenAI only for the exact Codex provider and API pair", () => {
		expect(
			resolveCompactionStrategy("automatic", {
				provider: "openai-codex",
				api: "openai-codex-responses",
			}),
		).toEqual({ configured: "automatic", effective: "openai" });
		expect(
			resolveCompactionStrategy("automatic", {
				provider: "openai",
				api: "openai-codex-responses",
			}),
		).toEqual({ configured: "automatic", effective: "default" });
		expect(
			resolveCompactionStrategy("automatic", {
				provider: "openai-codex",
				api: "openai-responses",
			}),
		).toEqual({ configured: "automatic", effective: "default" });
		expect(resolveCompactionStrategy("automatic", undefined)).toEqual({
			configured: "automatic",
			effective: "default",
		});
	});

	test("leaves explicit strategies unchanged", () => {
		const explicitStrategies: ConfiguredCompactionStrategy[] = ["default", "openai", "snapshot"];
		for (const strategy of explicitStrategies) {
			expect(
				resolveCompactionStrategy(strategy, {
					provider: "openai-codex",
					api: "openai-codex-responses",
				}),
			).toEqual({ configured: strategy, effective: strategy });
		}
	});
});
