import { describe, expect, test } from "vitest";
import { loadRiemannPrompt, renderRiemannPrompt } from "../src/riemann/prompts.ts";

describe("Riemann prompt budgets", () => {
	test("keeps static contracts bounded and compaction at least 40% below the v1 baseline", () => {
		expect(loadRiemannPrompt("system/main.md").length).toBeLessThanOrEqual(1_600);
		expect(loadRiemannPrompt("system/child.md").length).toBeLessThanOrEqual(1_400);
		expect(loadRiemannPrompt("system/compaction.md").length).toBeLessThanOrEqual(1_966);
	});

	test("renders one runtime contract with explicit discovery and precedence", () => {
		const rendered = renderRiemannPrompt("system/main.md", {
			environment: "env",
			availableOperations: "ops",
			agentProfiles: "",
			operationGuidelines: "",
			exposedMcpServers: "",
		});
		expect(rendered.match(/`ipython` is persistent/g)).toHaveLength(1);
		expect(rendered).toContain('catalog.describe(name="...")');
		expect(rendered).toContain("Platform/system rules and injected project guidance govern");
	});
});
