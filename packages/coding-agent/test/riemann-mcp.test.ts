import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { FunctionRegistry } from "../src/riemann/functions/registry.ts";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { RiemannMcpManager } from "../src/riemann/mcp/manager.ts";

function objectValue(value: JsonValue): Record<string, JsonValue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object result");
	return value;
}

describe("Riemann MCP bridge", () => {
	test("activates a server lazily and installs callable Python-safe functions", async () => {
		const registry = new FunctionRegistry();
		const manager = new RiemannMcpManager(
			{
				fixture: {
					command: process.execPath,
					args: [join(import.meta.dirname, "fixtures", "riemann-mcp-server.mjs")],
					startupTimeoutMs: 10_000,
					toolTimeoutMs: 10_000,
				},
			},
			import.meta.dirname,
			registry,
		);
		for (const definition of manager.definitions()) registry.register(definition);
		expect(manager.definitions().map((definition) => definition.name)).toEqual(["activate"]);
		const capabilities = new Set(["mcp.*"]);
		const signal = new AbortController().signal;
		try {
			const activated = objectValue(
				await registry.dispatch({ type: "mcp.activate", args: { name: "fixture" } }, capabilities, signal),
			);
			expect(activated.$riemann).toBe("function_bundle");
			expect(activated.namespace).toBe("fixture");
			expect(registry.get("fixture.sum_values")).toBeDefined();
			expect(registry.search("sum values", 8, capabilities)).toEqual([
				{
					name: "fixture.sum_values",
					description: "Add two numbers. [MCP fixture/sum-values]",
					returns: "MCP tool result",
				},
			]);
			expect(registry.describe("fixture.sum_values", capabilities)).toMatchObject({
				name: "fixture.sum_values",
			});

			const result = objectValue(
				await registry.dispatch(
					{ type: "fixture.sum_values", args: { left: 19, right: 23 } },
					capabilities,
					signal,
				),
			);
			const structured = objectValue(result.structuredContent ?? null);
			expect(structured.total).toBe(42);
		} finally {
			await manager.close();
		}
	}, 30_000);

	test("exposes available server names and descriptions by default with explicit opt-out", async () => {
		const registry = new FunctionRegistry();
		const manager = new RiemannMcpManager(
			{
				public_docs: {
					description: "Search approved internal product documentation.",
					command: "private-docs-command",
					env: { PRIVATE_TOKEN: "secret" },
				},
				hidden_docs: {
					description: "Hidden documentation.",
					command: "hidden-command",
					exposeToModel: false,
				},
			},
			import.meta.dirname,
			registry,
		);
		try {
			expect(manager.promptInventory(new Set(["mcp.*"]))).toBe(
				'- "public_docs": Search approved internal product documentation.',
			);
			expect(manager.promptInventory(new Set(["mcp.activate", "mcp.hidden_docs"]))).toBe("");
			const exposed = manager.promptInventory(new Set(["mcp.activate", "mcp.public_docs"]));
			expect(exposed).toContain("public_docs");
			expect(exposed).not.toContain("private-docs-command");
			expect(exposed).not.toContain("PRIVATE_TOKEN");
			expect(exposed).not.toContain("secret");
			expect(exposed).not.toContain("hidden_docs");
		} finally {
			await manager.close();
		}
	});

	test("keeps colliding Python-safe server names isolated", async () => {
		const registry = new FunctionRegistry();
		const server = {
			command: process.execPath,
			args: [join(import.meta.dirname, "fixtures", "riemann-mcp-server.mjs")],
			startupTimeoutMs: 10_000,
		};
		const manager = new RiemannMcpManager({ "fixture-a": server, fixture_a: server }, import.meta.dirname, registry);
		const reservedManager = new RiemannMcpManager({ shell: server }, import.meta.dirname, registry);
		const signal = new AbortController().signal;
		try {
			const first = objectValue(await manager.activate("fixture-a", signal));
			const second = objectValue(await manager.activate("fixture_a", signal));
			expect(first.namespace).not.toBe(second.namespace);
			expect(registry.get(`${String(first.namespace)}.sum_values`)).toBeDefined();
			expect(registry.get(`${String(second.namespace)}.sum_values`)).toBeDefined();
			const reserved = objectValue(await reservedManager.activate("shell", signal));
			expect(reserved.namespace).toBe("mcp_shell");
		} finally {
			await manager.close();
			await reservedManager.close();
		}
	}, 30_000);
});
