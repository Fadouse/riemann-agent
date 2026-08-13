import { describe, expect, test } from "vitest";
import { FunctionRegistry } from "../src/riemann/functions/registry.ts";

function registerFixtureFunctions(registry: FunctionRegistry): void {
	registry.register({
		name: "read",
		namespace: "workspace",
		description: "Read a workspace file.",
		promptSnippet: "Read a file.",
		parameters: [{ name: "path", description: "Path", type: "str", required: true }],
		returns: "TextSnapshot",
		capability: "workspace.read",
		handler: async () => null,
	});
	registry.register({
		name: "edit",
		namespace: "workspace",
		description: "Edit a workspace snapshot.",
		parameters: [
			{ name: "snapshot", description: "Snapshot", type: "TextSnapshot", required: true },
			{ name: "operations", description: "Edits", type: "list[dict]", required: true },
		],
		returns: "TextSnapshot",
		capability: "workspace.write",
		promptGuidelines: ["Read before editing."],
		handler: async () => null,
	});
	registry.register({
		name: "search",
		namespace: "catalog",
		description: "Search available functions.",
		parameters: [
			{ name: "query", description: "Query", type: "str", required: true },
			{ name: "limit", description: "Limit", type: "int | None", required: false },
		],
		returns: "list[dict]",
		handler: async () => null,
	});
}

describe("Riemann function registry prompt inventory", () => {
	test("lists compact signatures and filters unavailable capabilities", () => {
		const registry = new FunctionRegistry();
		registerFixtureFunctions(registry);
		const readOnly = new Set(["workspace.read"]);

		const inventory = registry.promptInventory(readOnly);
		expect(inventory).toContain("`workspace.read(path) -> TextSnapshot`: Read a file.");
		expect(inventory).toContain("`catalog.search(query, limit=None) -> list[dict]`");
		expect(inventory).not.toContain("workspace.edit");
		expect(registry.pythonSpecifications(undefined, readOnly).map((item) => item.qualified_name)).toEqual([
			"catalog.search",
			"workspace.read",
		]);
		expect(registry.promptGuidelines(readOnly)).toEqual([]);
	});

	test("keeps discovery results and descriptions inside the same capability boundary", () => {
		const registry = new FunctionRegistry();
		registerFixtureFunctions(registry);
		const readOnly = new Set(["workspace.read"]);

		expect(JSON.stringify(registry.search("workspace", 8, readOnly))).not.toContain("workspace.edit");
		expect(() => registry.describe("workspace.edit", readOnly)).toThrow("Function not found");
		expect(registry.promptGuidelines(new Set(["workspace.*"]))).toEqual(["Read before editing."]);
	});
});
