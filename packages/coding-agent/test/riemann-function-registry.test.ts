import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { RiemannHostError } from "../src/riemann/errors.ts";
import { type FunctionDefinition, FunctionRegistry, OperationSpecSchema } from "../src/riemann/functions/registry.ts";
import { type JsonValue, type KernelHostRequest, kernelHostResult } from "../src/riemann/kernel/types.ts";

const NEVER_ABORTED = new AbortController().signal;

function request(operation: string, arguments_: Record<string, JsonValue> = {}): KernelHostRequest {
	return { requestId: `test-${operation}`, operation, arguments: arguments_ };
}

function readDefinition(handler: FunctionDefinition["handler"] = async () => "contents"): FunctionDefinition {
	return {
		name: "read",
		namespace: "fs",
		description: "Read a file.",
		inputSchema: Type.Object(
			{
				path: Type.String({ minLength: 1, description: "Path to read" }),
				encoding: Type.Optional(Type.String({ default: "utf-8", description: "Text encoding" })),
			},
			{ additionalProperties: false },
		),
		outputSchema: Type.String(),
		pythonReturnType: "str",
		errors: [{ code: "not_found", description: "The path does not exist.", retryable: false }],
		effects: [{ kind: "read", resource: "filesystem" }],
		idempotency: "idempotent",
		cancellation: { supported: true, description: "Stops the pending file read." },
		visibility: "public",
		prompt: {
			inventory: "Read a file.",
			example: 'await fs.read(path="README.md")',
		},
		capability: "fs.read",
		handler,
	};
}

function editDefinition(): FunctionDefinition {
	return {
		name: "edit",
		namespace: "fs",
		description: "Edit a file snapshot.",
		inputSchema: Type.Object(
			{
				snapshot: Type.String({ description: "Snapshot token" }),
				operations: Type.Array(Type.Object({}, { additionalProperties: true }), {
					description: "Non-overlapping edits",
				}),
			},
			{ additionalProperties: false },
		),
		outputSchema: Type.String(),
		pythonReturnType: "str",
		errors: [],
		effects: [{ kind: "write", resource: "filesystem" }],
		idempotency: "conditional",
		cancellation: { supported: false, description: "Atomic write cannot be cancelled." },
		visibility: "public",
		prompt: {
			inventory: "Edit a file snapshot.",
			example: "await fs.edit(snapshot=snapshot, operations=operations)",
			guidelines: ["Read before editing."],
		},
		capability: "workspace.write",
		handler: async () => "edited",
	};
}

function registerFixtureFunctions(registry: FunctionRegistry): void {
	registry.register(readDefinition());
	registry.register(editDefinition());
	registry.register({
		name: "get",
		namespace: "artifacts",
		description: "Read an artifact.",
		inputSchema: Type.Object({ handle: Type.String() }, { additionalProperties: false }),
		outputSchema: Type.String(),
		pythonReturnType: "str",
		errors: [],
		effects: [{ kind: "read", resource: "artifact-store" }],
		idempotency: "idempotent",
		cancellation: { supported: false, description: "Not cancellable." },
		visibility: "handle-method",
		prompt: { inventory: "Read an artifact.", example: "await artifact.read()" },
		handler: async () => "artifact",
	});
}

async function expectHostError(promise: Promise<unknown>, code: string): Promise<void> {
	try {
		await promise;
		throw new Error("Expected dispatch to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(RiemannHostError);
		expect((error as RiemannHostError).code).toBe(code);
	}
}

describe("Riemann function registry", () => {
	test("renders executable Python literals and preserves explicit null defaults", async () => {
		const registry = new FunctionRegistry();
		registry.register({
			...readDefinition(async (args) => args),
			inputSchema: Type.Object(
				{ flag: Type.Optional(Type.Union([Type.Boolean(), Type.Null()], { default: false })) },
				{ additionalProperties: false },
			),
			outputSchema: Type.Object(
				{ flag: Type.Union([Type.Boolean(), Type.Null()]) },
				{ additionalProperties: false },
			),
		});
		expect(registry.promptInventory(new Set(["fs.read"]))).toContain("flag=False");
		expect(await registry.dispatch(request("fs.read"), new Set(["fs.read"]), NEVER_ABORTED)).toEqual({ flag: false });
		expect(await registry.dispatch(request("fs.read", { flag: null }), new Set(["fs.read"]), NEVER_ABORTED)).toEqual({
			flag: null,
		});
		registry.register({
			...readDefinition(async (args) => args),
			namespace: "quantity",
			pythonReturnType: "dict",
			inputSchema: Type.Object(
				{
					max_items: Type.Optional(
						Type.Integer({ minimum: 1, maximum: 3, default: 2, description: "Maximum returned entries" }),
					),
				},
				{ additionalProperties: false },
			),
			outputSchema: Type.Object({ max_items: Type.Integer() }, { additionalProperties: false }),
		});
		expect(registry.describe("quantity.read")).toMatchObject({
			parameters: [
				{
					name: "max_items",
					type: "integer",
					required: false,
					description: "Maximum returned entries",
					default: 2,
					constraints: { minimum: 1, maximum: 3 },
				},
			],
		});
		expect(await registry.dispatch(request("quantity.read"), new Set(["fs.read"]), NEVER_ABORTED)).toEqual({
			max_items: 2,
		});
		await expect(
			registry.dispatch(request("quantity.read", { max_items: 4 }), new Set(["fs.read"]), NEVER_ABORTED),
		).rejects.toMatchObject({
			code: "invalid_arguments",
			message: expect.stringContaining("maximum"),
			details: {
				errors: [
					{
						path: "/max_items",
						received: "integer (4)",
						expected: expect.stringContaining("3"),
						message: expect.any(String),
					},
				],
			},
		});
	});

	test("does not execute pre-cancelled calls or override instance recovery", async () => {
		let calls = 0;
		const registry = new FunctionRegistry();
		registry.register(
			readDefinition(async () => {
				calls += 1;
				throw new RiemannHostError("not_found", "gone", undefined, true);
			}),
		);
		const controller = new AbortController();
		controller.abort();
		await expectHostError(
			registry.dispatch(request("fs.read", { path: "x" }), new Set(["fs.read"]), controller.signal),
			"cancelled",
		);
		expect(calls).toBe(0);
		const cancelled = new FunctionRegistry();
		const during = new AbortController();
		cancelled.register(
			readDefinition(async () => {
				during.abort();
				throw during.signal.reason;
			}),
		);
		await expect(
			cancelled.dispatch(request("fs.read", { path: "x" }), new Set(["fs.read"]), during.signal),
		).rejects.toMatchObject({ code: "cancelled", recovery: "none" });

		await expect(
			registry.dispatch(request("fs.read", { path: "x" }), new Set(["fs.read"]), NEVER_ABORTED),
		).rejects.toMatchObject({ retryable: true });
	});

	test("rejects Python keywords in namespaces, names, and parameters", () => {
		const keywordName = { ...readDefinition(), name: "class" };
		expect(() => new FunctionRegistry().register(keywordName)).toThrow("Invalid Python function name");
		const keywordParameter = {
			...readDefinition(),
			inputSchema: Type.Object({ class: Type.String() }, { additionalProperties: false }),
		};
		expect(() => new FunctionRegistry().register(keywordParameter)).toThrow("Invalid parameter name: class");
	});

	test("rejects duplicate qualified names", () => {
		const registry = new FunctionRegistry();
		registry.register(readDefinition());
		expect(() => registry.register(readDefinition())).toThrow("Function is already registered: fs.read");
	});

	test("strictly rejects unknown input properties before invoking the handler", async () => {
		let invoked = false;
		const registry = new FunctionRegistry();
		registry.register(
			readDefinition(async () => {
				invoked = true;
				return "contents";
			}),
		);

		await expectHostError(
			registry.dispatch(
				request("fs.read", { path: "README.md", unexpected: true }),
				new Set(["fs.read"]),
				NEVER_ABORTED,
			),
			"invalid_arguments",
		);
		expect(invoked).toBe(false);
		await expect(
			registry.dispatch(
				request("fs.read", { path: "README.md", unexpected: true }),
				new Set(["fs.read"]),
				NEVER_ABORTED,
			),
		).rejects.toMatchObject({
			details: {
				errors: expect.arrayContaining([
					expect.objectContaining({
						path: "/unexpected",
						received: "boolean",
						expected: expect.stringContaining("path"),
					}),
				]),
			},
		});
	});

	test("search indexes capability names and respects capability visibility", () => {
		const registry = new FunctionRegistry();
		registerFixtureFunctions(registry);

		expect(registry.search("workspace.write", 8, new Set(["workspace.write"]))).toEqual([
			{
				$riemann: "operation_summary",
				name: "fs.edit",
				signature: "fs.edit(*, snapshot=..., operations=...) -> str",
				description: "Edit a file snapshot.",
				python_return_type: "str",
				capability: "workspace.write",
			},
		]);
		expect(JSON.stringify(registry.search("fs", 8, new Set(["fs.read"])))).not.toContain("fs.edit");
		expect(() => registry.search("fs", 0)).toThrow("limit must be an integer from 1 to 50");
	});

	test("describe returns exact metadata, schemas, and defaults", () => {
		const registry = new FunctionRegistry();
		registry.register(readDefinition());

		const described = registry.describe("fs.read", new Set(["fs.read"]), "schema");
		expect(Value.Check(OperationSpecSchema, described)).toBe(true);
		expect(described).toMatchObject({
			name: "fs.read",
			description: "Read a file.",
			input_schema: readDefinition().inputSchema,
			output_schema: { type: "string" },
			defaults: { encoding: "utf-8" },
			python_return_type: "str",
			errors: expect.arrayContaining([
				{ code: "not_found", description: "The path does not exist.", retryable: false, recovery: "refresh" },
			]),
		});
		const usage = registry.describe("fs.read", new Set(["fs.read"]));
		expect(Value.Check(OperationSpecSchema, usage)).toBe(true);
		expect(usage).not.toHaveProperty("input_schema");
		expect(usage).not.toHaveProperty("output_schema");
		expect(usage).toMatchObject({
			execution: "host",
			cancellation: { before_start: "reject", during_execution: "cooperative", side_effects_may_remain: false },
		});
	});

	test("validates direct and KernelHostResult output values", async () => {
		const direct = new FunctionRegistry();
		direct.register(readDefinition(async () => 42));
		await expectHostError(
			direct.dispatch(request("fs.read", { path: "README.md" }), new Set(["fs.read"]), NEVER_ABORTED),
			"invalid_output",
		);

		const wrapped = new FunctionRegistry();
		wrapped.register(readDefinition(async () => kernelHostResult(42)));
		await expectHostError(
			wrapped.dispatch(request("fs.read", { path: "README.md" }), new Set(["fs.read"]), NEVER_ABORTED),
			"invalid_output",
		);
	});

	test("generates keyword-only Python specifications from schemas", () => {
		const registry = new FunctionRegistry();
		registerFixtureFunctions(registry);
		const readOnly = new Set(["fs.read"]);

		expect(registry.pythonSpecifications(undefined, readOnly).filter((item) => item.visibility === "public")).toEqual(
			[
				{
					name: "read",
					namespace: "fs",
					qualified_name: "fs.read",
					description: "Read a file.",
					input_schema: {
						type: "object",
						required: ["path"],
						properties: {
							path: { type: "string", minLength: 1, description: "Path to read" },
							encoding: { type: "string", default: "utf-8", description: "Text encoding" },
						},
						additionalProperties: false,
					},
					return_type: "str",
					output_schema: { type: "string" },
					visibility: "public",
				},
			],
		);
	});

	test("describes permission-filtered handle methods and schema-derived result types", () => {
		const registry = new FunctionRegistry();
		registerFixtureFunctions(registry);
		expect(registry.describe("Artifact.read")).toMatchObject({
			name: "Artifact.read",
			signature: "Artifact.read() -> str",
		});
		registry.register({
			...readDefinition(),
			namespace: "records",
			outputSchema: Type.Object({ path: Type.String() }, { additionalProperties: false, $id: "TextSnapshot" }),
			pythonReturnType: "TextSnapshot",
		});
		expect(registry.describe("TextSnapshot", new Set(["fs.read"]), "schema")).toMatchObject({
			output_schema: { $id: "TextSnapshot" },
		});
		expect(() => registry.describe("TextSnapshot", new Set())).toThrow(RiemannHostError);
		expect(registry.describe("TextSnapshot.lines", new Set(["fs.read"]))).toMatchObject({
			execution: "local",
			example: "snapshot.lines(start=1, end=10)",
		});
		const inventory = registry.promptInventory(new Set(["fs.read"]));
		expect(inventory).toContain('read(*, path=..., encoding="utf-8") -> TextSnapshot');
		expect(inventory).toContain("Return types:");
		expect(inventory.match(/TextSnapshot\(path/g)).toHaveLength(1);

		registry.register({ ...readDefinition(), namespace: "hidden", visibility: "internal" });
		expect(() => registry.describe("hidden.read", new Set(["*"]))).toThrow(RiemannHostError);
	});

	test("validates updates without throwing through callbacks and preserves native error diagnostics", async () => {
		const registry = new FunctionRegistry();
		let delivered = false;
		registry.register({
			...readDefinition(async (_args, _signal, update) => {
				expect(() => update?.({ unexpected: true })).not.toThrow();
				return "contents";
			}),
			updateSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
		});
		await expect(
			registry.dispatch(request("fs.read", { path: "x" }), new Set(["fs.read"]), NEVER_ABORTED, () => {
				delivered = true;
			}),
		).rejects.toMatchObject({ code: "invalid_output" });
		expect(delivered).toBe(false);
		const failing = new FunctionRegistry();
		failing.register(
			readDefinition(async () => {
				throw new Error("disk failed", { cause: new Error("native cause") });
			}),
		);
		await expect(
			failing.dispatch(request("fs.read", { path: "x" }), new Set(["fs.read"]), NEVER_ABORTED),
		).rejects.toMatchObject({
			code: "internal_error",
			recovery: "none",
			details: { message: "disk failed", stack: expect.any(String), cause: { message: "native cause" } },
		});
	});

	test("normalizes unknown registry lookups to host not-found errors", async () => {
		const registry = new FunctionRegistry();
		expect(() => registry.describe("fs.missing")).toThrow(RiemannHostError);
		await expectHostError(registry.dispatch(request("fs.missing", {}), new Set(["*"]), NEVER_ABORTED), "not_found");
	});
});
