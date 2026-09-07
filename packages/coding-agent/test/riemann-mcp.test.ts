import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
	vi.restoreAllMocks();
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

describe("Riemann MCP tool bridge", () => {
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
			const sum = registry.describe("fixture.sum_values", capabilities, "schema");
			expect(sum).toMatchObject({
				name: "fixture.sum_values",
				python_return_type: "McpResult",
				input_schema: {
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
			expect(imageArtifact.handle).toMatch(/^r[0-9a-z]+$/);
			expect(objectValue(imageContent ?? undefined).artifact).toEqual(imageArtifact);
			const materialized = objectValue(
				await artifacts.materialize(String(imageArtifact.handle), join(root, "materialized.png")),
			);
			expect(materialized.handle).toBe(imageArtifact.handle);
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

	test("reserves built-in result types and namespaces", async () => {
		const names = [
			"output",
			"pages",
			"MaterializedArtifact",
			"Page",
			"PathEntry",
			"ArtifactSlice",
			"SearchMatch",
			"OperationSpec",
			"OperationSummary",
			"RuntimeStatus",
			"McpNamespace",
			"FileSnapshot",
		];
		const manager = new RiemannMcpManager(
			Object.fromEntries(names.map((name) => [name, fixtureConfig()])),
			root,
			new FunctionRegistry(),
			artifacts,
			new Set(["mcp.*"]),
		);
		try {
			for (const name of names) expect(objectValue(manager.serverStatus(name)).namespace).not.toBe(name);
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

describe("MCP startup concurrency", () => {
	function setup() {
		const registry = new FunctionRegistry();
		const manager = new RiemannMcpManager(
			{ fixture: fixtureConfig() },
			root,
			registry,
			artifacts,
			new Set(["mcp.*"]),
		);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(async (_transport, options) => {
			await gate;
			options?.signal?.throwIfAborted();
		});
		vi.spyOn(Client.prototype, "close").mockResolvedValue();
		vi.spyOn(Client.prototype, "listTools").mockResolvedValue({
			tools: [
				{
					name: "probe",
					inputSchema: { type: "object" },
					outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
				},
			],
		});
		return { manager, registry, release, connect };
	}

	test("isolates the first caller cancellation from a shared startup", async () => {
		const { manager, registry, release, connect } = setup();
		const first = new AbortController();
		const opened = manager.open("fixture", first.signal);
		const cancelled = expect(opened).rejects.toMatchObject({ code: "cancelled" });
		const second = manager.open("fixture", new AbortController().signal);
		await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
		first.abort();
		release();
		try {
			await cancelled;
			expect(objectValue(await second).namespace).toBe("fixture");
			expect(connect).toHaveBeenCalledOnce();
			expect(registry.describe("fixture.probe", undefined, "schema")).toMatchObject({
				remote_output_schema: { required: ["value"] },
			});
		} finally {
			await manager.close();
		}
	});

	test("pre-cancelled open has no startup side effect", async () => {
		const { manager, connect, release } = setup();
		const controller = new AbortController();
		controller.abort();
		try {
			await expect(manager.open("fixture", controller.signal)).rejects.toMatchObject({ code: "cancelled" });
			expect(connect).not.toHaveBeenCalled();
		} finally {
			release();
			await manager.close();
		}
	});

	test.each(["server", "manager"])("closing %s prevents a pending startup from installing tools", async (scope) => {
		const { manager, registry, release, connect } = setup();
		const opening = manager.open("fixture", new AbortController().signal);
		const rejected = expect(opening).rejects.toMatchObject({ code: expect.stringMatching(/closed|cancelled/) });
		await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
		const closing = scope === "server" ? manager.closeServer("fixture") : manager.close();
		release();
		await closing;
		await rejected;
		expect(manager.serverStatus("fixture")).toMatchObject({ status: "closed", tool_count: 0 });
		expect(registry.get("fixture.probe")).toBeUndefined();
		await manager.close();
	});

	test("does not publish a late tools/list result after close", async () => {
		const { manager, registry, release } = setup();
		release();
		let resolveList!: (value: { tools: [] }) => void;
		const list = vi.spyOn(Client.prototype, "listTools").mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveList = resolve;
				}),
		);
		const opening = manager.open("fixture", new AbortController().signal);
		const rejected = expect(opening).rejects.toMatchObject({ code: "closed" });
		await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
		await manager.close();
		await rejected;
		resolveList({ tools: [] });
		await Promise.resolve();
		expect(manager.serverStatus("fixture")).toMatchObject({ status: "closed", tool_count: 0 });
		expect(registry.get("fixture.probe")).toBeUndefined();
	});

	test("refresh replaces tools and explicit open can follow a settled server close", async () => {
		const { manager, registry, release, connect } = setup();
		release();
		try {
			await manager.open("fixture", new AbortController().signal);
			await manager.refresh("fixture", new AbortController().signal);
			expect(connect).toHaveBeenCalledTimes(2);
			expect(registry.get("fixture.probe")).toBeDefined();
			await manager.closeServer("fixture");
			expect(registry.get("fixture.probe")).toBeUndefined();
			await manager.open("fixture", new AbortController().signal);
			expect(connect).toHaveBeenCalledTimes(3);
		} finally {
			await manager.close();
		}
	});

	test("a close after refresh starts prevents refresh from reviving the server", async () => {
		const { manager, registry, release } = setup();
		const refreshing = manager.refresh("fixture", new AbortController().signal);
		const rejected = expect(refreshing).rejects.toMatchObject({ code: expect.stringMatching(/closed|cancelled/) });
		await manager.closeServer("fixture");
		release();
		await rejected;
		expect(registry.get("fixture.probe")).toBeUndefined();
		await manager.close();
	});

	test("maps asynchronous result normalization failures to MCP errors", async () => {
		const { manager, registry, release } = setup();
		release();
		await manager.open("fixture", new AbortController().signal);
		vi.spyOn(Client.prototype, "callTool").mockResolvedValue({
			content: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
					mimeType: "image/png",
				},
			],
		});
		const remote = { uri: "artifact://remote/original", handle: "artifact://remote/opaque", $riemann: "artifact" };
		const call = vi.spyOn(Client.prototype, "callTool");
		call.mockResolvedValueOnce({
			content: [{ type: "text", text: remote.uri }],
			structuredContent: remote,
			_meta: remote,
		});
		const opaque = objectValue(
			await registry.get("fixture.probe")!.handler({ input: {} }, new AbortController().signal),
		);
		expect(mcpJson(opaque.structured_content)).toEqual(remote);
		expect(mcpJson(opaque.metadata)).toEqual(remote);
		vi.spyOn(artifacts, "putBuffer").mockRejectedValue(new Error("artifact unavailable"));
		try {
			await expect(
				registry.get("fixture.probe")!.handler({ input: {} }, new AbortController().signal),
			).rejects.toMatchObject({ code: "mcp_error" });
		} finally {
			await manager.close();
		}
	});
});
