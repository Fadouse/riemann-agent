import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RiemannHostError } from "../src/riemann/errors.ts";
import { FunctionRegistry } from "../src/riemann/functions/registry.ts";
import {
	isKernelHostResult,
	type JsonValue,
	type KernelHostRequest,
	type KernelHostResult,
} from "../src/riemann/kernel/types.ts";
import { RiemannMcpManager } from "../src/riemann/mcp/manager.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

let root: string;
let store: RiemannStore;
let artifacts: ArtifactStore;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "riemann-mcp-test-"));
	store = new RiemannStore(join(root, ".agent"));
	const run = store.openRun("mcp-test", root);
	artifacts = new ArtifactStore(store, run.id);
});

afterEach(async () => {
	store.close();
	await rm(root, { recursive: true, force: true });
});

function objectValue(value: JsonValue | KernelHostResult | undefined): Record<string, JsonValue> {
	const wireValue = value && isKernelHostResult(value) ? value.value : value;
	if (typeof wireValue !== "object" || wireValue === null || Array.isArray(wireValue)) {
		throw new Error("Expected object result");
	}
	return wireValue;
}

function mcpJson(value: JsonValue | undefined): JsonValue {
	const wrapper = objectValue(value);
	expect(wrapper.$riemann).toBe("mcp_json");
	return wrapper.value ?? null;
}

function request(operation: string, arguments_: Record<string, JsonValue>): KernelHostRequest {
	return { requestId: `test-${operation}`, operation, arguments: arguments_ };
}

function fixtureConfig() {
	return {
		command: process.execPath,
		args: [join(import.meta.dirname, "fixtures", "riemann-mcp-server.mjs")],
		startupTimeoutMs: 10_000,
		toolTimeoutMs: 10_000,
	};
}

describe("Riemann MCP ABI v2 bridge", () => {
	test("opens a server lazily and installs one-input-schema functions with stable results", async () => {
		const registry = new FunctionRegistry();
		const capabilities = new Set(["mcp.*"]);
		const manager = new RiemannMcpManager(
			{ fixture: fixtureConfig() },
			import.meta.dirname,
			registry,
			artifacts,
			capabilities,
		);
		for (const definition of manager.definitions()) registry.register(definition);
		expect(manager.definitions().map((definition) => definition.name)).toEqual([
			"open",
			"status",
			"refresh",
			"close",
		]);
		const signal = new AbortController().signal;
		try {
			const opened = objectValue(
				await registry.dispatch(request("mcp.open", { name: "fixture" }), capabilities, signal),
			);
			expect(opened.$riemann).toBe("function_bundle");
			expect(opened.namespace).toBe("fixture");
			expect(opened.server_name).toBe("fixture");
			expect(registry.get("fixture.close")).toBeUndefined();
			expect(registry.list(capabilities).some((definition) => definition.name.startsWith("tool_close_"))).toBe(true);
			expect(registry.list(capabilities).some((definition) => definition.name.startsWith("tool_private_"))).toBe(
				true,
			);
			expect(manager.serverStatus("fixture")).toMatchObject({ status: "ready", tool_count: 6 });
			const sum = registry.describe("fixture.sum_values", capabilities);
			expect(sum).toMatchObject({
				name: "fixture.sum_values",
				pythonReturnType: "McpResult",
				inputSchema: {
					type: "object",
					required: ["input"],
					properties: { input: expect.objectContaining({ type: "object" }) },
					additionalProperties: false,
				},
			});

			const result = objectValue(
				await registry.dispatch(
					request("fixture.sum_values", { input: { left: 19, right: 23 } }),
					capabilities,
					signal,
				),
			);
			expect(result.$riemann).toBe("mcp_result");
			expect(objectValue(mcpJson(result.structured_content)).total).toBe(42);

			await expect(
				registry.dispatch(request("fixture.fail", { input: {} }), capabilities, signal),
			).rejects.toMatchObject({
				code: "mcp_tool_error",
				details: expect.objectContaining({ $riemann: "mcp_result" }),
			});

			const imageWire = objectValue(
				await registry.dispatch(request("fixture.show_pixel", { input: {} }), capabilities, signal),
			);
			expect(JSON.stringify(imageWire)).not.toContain("iVBORw0KGgo");
			const imageContent = Array.isArray(imageWire.content) ? mcpJson(imageWire.content[0]) : null;
			expect(imageContent).toEqual(
				expect.objectContaining({ type: "image", mimeType: "image/png", artifact: expect.any(Object) }),
			);
			const imageArtifact = objectValue(Array.isArray(imageWire.artifacts) ? imageWire.artifacts[0] : undefined);
			expect(typeof imageArtifact.handle).toBe("string");
			expect((await artifacts.readBuffer(String(imageArtifact.handle))).byteLength).toBeGreaterThan(0);

			const resourceWire = objectValue(
				await registry.dispatch(request("fixture.show_resource_pixel", { input: {} }), capabilities, signal),
			);
			expect(JSON.stringify(resourceWire)).not.toContain("iVBORw0KGgo");
			const resourceContent = Array.isArray(resourceWire.content) ? mcpJson(resourceWire.content[0]) : null;
			expect(resourceContent).toEqual({
				type: "resource",
				resource: expect.objectContaining({
					uri: "fixture://pixel.png",
					mimeType: "image/png",
					_meta: { fixture: true },
					artifact: expect.any(Object),
				}),
			});
		} finally {
			await manager.close();
		}
	}, 30_000);

	test("uses the same capability boundary for inventory and connection", async () => {
		const registry = new FunctionRegistry();
		const manager = new RiemannMcpManager(
			{
				public_docs: { description: "Search approved internal product documentation.", command: "private" },
				hidden_docs: { description: "Hidden documentation.", command: "hidden", exposeToModel: false },
			},
			import.meta.dirname,
			registry,
			artifacts,
			new Set(["mcp.open", "mcp.public_docs"]),
		);
		try {
			expect(manager.promptInventory(new Set(["mcp.open", "mcp.public_docs"]))).toContain("public_docs");
			expect(manager.promptInventory(new Set(["mcp.open", "mcp.hidden_docs"]))).toBe("");
			await expect(manager.open("hidden_docs", new AbortController().signal)).rejects.toMatchObject({
				code: "permission_denied",
			} satisfies Partial<RiemannHostError>);
		} finally {
			await manager.close();
		}
	});

	test("maps colliding server names deterministically independent of config order", async () => {
		const firstRegistry = new FunctionRegistry();
		const secondRegistry = new FunctionRegistry();
		const capabilities = new Set(["mcp.*"]);
		const first = new RiemannMcpManager(
			{
				"fixture-a": fixtureConfig(),
				fixture_a: fixtureConfig(),
				shell: fixtureConfig(),
				Artifact: fixtureConfig(),
				mcp_shell_ce635c4e: fixtureConfig(),
			},
			import.meta.dirname,
			firstRegistry,
			artifacts,
			capabilities,
		);
		const second = new RiemannMcpManager(
			{
				mcp_shell_ce635c4e: fixtureConfig(),
				Artifact: fixtureConfig(),
				shell: fixtureConfig(),
				fixture_a: fixtureConfig(),
				"fixture-a": fixtureConfig(),
			},
			import.meta.dirname,
			secondRegistry,
			artifacts,
			capabilities,
		);
		const signal = new AbortController().signal;
		try {
			for (const name of ["fixture-a", "fixture_a", "shell", "Artifact", "mcp_shell_ce635c4e"]) {
				const left = objectValue(await first.open(name, signal));
				const right = objectValue(await second.open(name, signal));
				expect(left.namespace).toBe(right.namespace);
				if (name === "Artifact") expect(left.namespace).not.toBe("Artifact");
				if (name === "shell") expect(left.namespace).not.toBe("mcp_shell_ce635c4e");
				expect(typeof left.namespace).toBe("string");
			}
		} finally {
			await first.close();
			await second.close();
		}
	}, 30_000);
});
