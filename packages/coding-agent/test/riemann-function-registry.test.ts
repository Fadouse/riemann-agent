import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import { RiemannHostError } from "../src/riemann/errors.ts";
import { type FunctionDefinition, FunctionRegistry } from "../src/riemann/functions/registry.ts";
import { type JsonValue, type KernelHostRequest, kernelHostResult } from "../src/riemann/kernel/types.ts";

const NEVER_ABORTED = new AbortController().signal;

function request(operation: string, arguments_: Record<string, JsonValue> = {}): KernelHostRequest {
	return { abiVersion: 2, requestId: `test-${operation}`, operation, arguments: arguments_ };
}

function readDefinition(handler: FunctionDefinition["handler"] = async () => "contents"): FunctionDefinition {
	return {
		abiVersion: 2,
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
		abiVersion: 2,
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
		abiVersion: 2,
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

describe("Riemann ABI v2 function registry", () => {
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
	});

	test("search indexes capability names and respects capability visibility", () => {
		const registry = new FunctionRegistry();
		registerFixtureFunctions(registry);

		expect(registry.search("workspace.write", 8, new Set(["workspace.write"]))).toEqual([
			{
				name: "fs.edit",
				description: "Edit a file snapshot.",
				pythonReturnType: "str",
				capability: "workspace.write",
			},
		]);
		expect(JSON.stringify(registry.search("fs", 8, new Set(["fs.read"])))).not.toContain("fs.edit");
		expect(() => registry.search("fs", 0)).toThrow("limit must be an integer from 1 to 50");
	});

	test("describe returns exact ABI metadata, schemas, and defaults", () => {
		const registry = new FunctionRegistry();
		registry.register(readDefinition());

		expect(registry.describe("fs.read", new Set(["fs.read"]))).toEqual({
			abiVersion: 2,
			name: "fs.read",
			description: "Read a file.",
			inputSchema: {
				type: "object",
				required: ["path"],
				properties: {
					path: { type: "string", minLength: 1, description: "Path to read" },
					encoding: { type: "string", default: "utf-8", description: "Text encoding" },
				},
				additionalProperties: false,
			},
			outputSchema: { type: "string" },
			defaults: { encoding: "utf-8" },
			pythonReturnType: "str",
			errors: [{ code: "not_found", description: "The path does not exist.", retryable: false }],
			effects: [{ kind: "read", resource: "filesystem" }],
			idempotency: "idempotent",
			cancellation: { supported: true, description: "Stops the pending file read." },
			capability: "fs.read",
			example: 'await fs.read(path="README.md")',
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

		expect(registry.pythonSpecifications(undefined, readOnly)).toEqual([
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
			},
		]);
	});

	test("normalizes unknown registry lookups to host not-found errors", async () => {
		const registry = new FunctionRegistry();
		expect(() => registry.describe("fs.missing")).toThrow(RiemannHostError);
		await expectHostError(registry.dispatch(request("fs.missing", {}), new Set(["*"]), NEVER_ABORTED), "not_found");
	});
});
