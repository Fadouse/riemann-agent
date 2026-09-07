import { IsArray, IsObject, IsUnion, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { errorRecovery, RiemannHostError } from "../errors.ts";
import { isKernelHostResult, type JsonValue, type KernelHostRequest, type KernelHostResult } from "../kernel/types.ts";
import type { FunctionDefinition, FunctionUpdateCallback } from "./contracts.ts";

export type {
	FunctionCancellationSpecification,
	FunctionDefinition,
	FunctionEffectSpecification,
	FunctionErrorSpecification,
	FunctionIdempotency,
	FunctionPromptSpecification,
	FunctionUpdateCallback,
	FunctionVisibility,
} from "./contracts.ts";

export interface PythonFunctionSpecification {
	name: string;
	namespace: string;
	qualified_name: string;
	description: string;
	input_schema: JsonValue;
	output_schema: JsonValue;
	return_type: string;
	visibility: FunctionDefinition["visibility"];
}

export const OperationSummarySchema = Type.Object(
	{
		$riemann: Type.Literal("operation_summary"),
		name: Type.String(),
		signature: Type.String(),
		description: Type.String(),
		python_return_type: Type.String(),
		capability: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false, $id: "OperationSummary" },
);

const ErrorSpecificationSchema = Type.Object(
	{
		code: Type.String(),
		description: Type.String(),
		retryable: Type.Boolean(),
		recovery: Type.Union([
			Type.Literal("none"),
			Type.Literal("retry"),
			Type.Literal("refresh"),
			Type.Literal("fix_arguments"),
			Type.Literal("reauthorize"),
		]),
	},
	{ additionalProperties: false },
);

export const OperationSpecSchema = Type.Object(
	{
		name: Type.String(),
		description: Type.String(),
		signature: Type.String(),
		execution: Type.Union([Type.Literal("host"), Type.Literal("local")]),
		python_return_type: Type.String(),
		returns: Type.String(),
		defaults: Type.Record(Type.String(), Type.Unknown()),
		parameters: Type.Array(
			Type.Object(
				{
					name: Type.String(),
					type: Type.String(),
					required: Type.Boolean(),
					description: Type.String(),
					constraints: Type.Record(Type.String(), Type.Unknown()),
					default: Type.Optional(Type.Unknown()),
				},
				{ additionalProperties: false },
			),
		),
		errors: Type.Array(ErrorSpecificationSchema),
		effects: Type.Array(
			Type.Object({ kind: Type.String(), resource: Type.String() }, { additionalProperties: false }),
		),
		idempotency: Type.Union([
			Type.Literal("idempotent"),
			Type.Literal("non-idempotent"),
			Type.Literal("conditional"),
		]),
		cancellation: Type.Object(
			{
				supported: Type.Boolean(),
				description: Type.String(),
				before_start: Type.Literal("reject"),
				during_execution: Type.Union([Type.Literal("cooperative"), Type.Literal("settle")]),
				side_effects_may_remain: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		capability: Type.Union([Type.String(), Type.Null()]),
		example: Type.String(),
		input_schema: Type.Optional(Type.Unknown()),
		output_schema: Type.Optional(Type.Unknown()),
		update_schema: Type.Optional(Type.Unknown()),
		remote_output_schema: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false, $id: "OperationSpec" },
);

export const COMMON_FUNCTION_ERRORS = [
	{ code: "not_found", description: "The operation or resource is unavailable.", retryable: false },
	{ code: "permission_denied", description: "The operation is not permitted.", retryable: false },
	{ code: "invalid_arguments", description: "Arguments do not satisfy the input contract.", retryable: false },
	{ code: "cancelled", description: "The call was cancelled before execution.", retryable: false },
	{ code: "invalid_output", description: "The result does not satisfy the output contract.", retryable: false },
	{ code: "internal_error", description: "The host operation failed unexpectedly.", retryable: false },
] as const;

const HANDLE_METHODS = new Map<string, { operation: string; bound: readonly string[] }>([
	["Artifact.read", { operation: "artifacts.get", bound: ["handle"] }],
	["Artifact.materialize", { operation: "artifacts.materialize", bound: ["handle"] }],
	["Artifact.view", { operation: "artifacts.view", bound: ["handle"] }],
	["ImageSnapshot.view", { operation: "artifacts.view", bound: ["handle"] }],
	...["AgentTurnHandle", "AgentInfo", "AgentResult"].flatMap((typeName) =>
		["info", "wait", "steer", "stop", "release"].map(
			(method): [string, { operation: string; bound: readonly string[] }] => [
				`${typeName}.${method}`,
				{ operation: `agents.${method}`, bound: ["agent_id", "turn_id"] },
			],
		),
	),
	...["status", "refresh", "close"].map((method): [string, { operation: string; bound: readonly string[] }] => [
		`McpNamespace.${method}`,
		{ operation: `mcp.${method}`, bound: ["server_name"] },
	]),
]);

const PROMPT_NAMESPACE_ORDER = new Map(
	["fs", "shell", "web", "artifacts", "agents", "mcp", "catalog", "state"].map((namespace, index) => [
		namespace,
		index,
	]),
);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PYTHON_KEYWORDS = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
]);

function isPythonIdentifier(value: string): boolean {
	return IDENTIFIER.test(value) && !PYTHON_KEYWORDS.has(value);
}

function words(value: string): string[] {
	return value.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function metadataValue(value: unknown): JsonValue {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) return null;
	return JSON.parse(encoded) as JsonValue;
}

function schemaConstraints(schema: TSchema): Record<string, JsonValue> {
	const constraints: Record<string, JsonValue> = {};
	for (const key of [
		"minimum",
		"maximum",
		"exclusiveMinimum",
		"exclusiveMaximum",
		"multipleOf",
		"minLength",
		"maxLength",
		"minItems",
		"maxItems",
		"pattern",
		"format",
		"enum",
		"const",
	]) {
		if (key in schema)
			constraints[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = metadataValue(
				(schema as Record<string, unknown>)[key],
			);
	}
	if (IsUnion(schema))
		constraints.alternatives = schema.anyOf.map((branch) => ({
			type: schemaType(branch),
			...schemaConstraints(branch),
		}));
	return constraints;
}

function schemaType(schema: TSchema): string {
	if (IsUnion(schema)) return schema.anyOf.map(schemaType).join(" | ");
	if (IsArray(schema)) return `list[${schemaType(schema.items)}]`;
	return "type" in schema && typeof schema.type === "string" ? schema.type : "JSON";
}

function pointerValue(value: unknown, pointer: string): unknown {
	for (const part of pointer.replace(/^#/, "").split("/").slice(1)) {
		const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
		if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

type ValidationIssue = { path: string; message: string; received: string; expected: string };

function validationDetails(schema: TSchema, value: unknown): { errors: ValidationIssue[] } {
	const issues: ValidationIssue[] = [];
	for (const error of Value.Errors(schema, value)) {
		const parent = pointerValue(schema, error.schemaPath);
		const constraint = typeof parent === "object" && parent !== null ? (parent as TSchema) : schema;
		const keys =
			error.keyword === "additionalProperties"
				? error.params.additionalProperties
				: error.keyword === "required"
					? error.params.requiredProperties
					: [undefined];
		for (const key of keys) {
			const path =
				key === undefined
					? error.instancePath
					: `${error.instancePath}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
			const received = pointerValue(value, path);
			const expectedSchema =
				key !== undefined && IsObject(constraint) && key in constraint.properties
					? constraint.properties[key]
					: constraint;
			const expected =
				error.keyword === "additionalProperties" && IsObject(constraint)
					? `available names: ${Object.keys(constraint.properties).join(", ")}`
					: `${schemaType(expectedSchema)} ${JSON.stringify(schemaConstraints(expectedSchema))}`;
			issues.push({
				path,
				message: error.message,
				expected,
				received:
					received === undefined
						? "omitted"
						: received === null
							? "null"
							: Array.isArray(received)
								? `array (${received.length} items)`
								: typeof received === "number"
									? `${Number.isInteger(received) ? "integer" : "number"} (${received})`
									: typeof received,
			});
			if (issues.length === 8) return { errors: issues };
		}
	}
	return { errors: issues };
}

function parameterUsage(schema: FunctionDefinition["inputSchema"]): JsonValue[] {
	return Object.entries(schema.properties).map(([name, parameter]) => ({
		name,
		type: schemaType(parameter),
		required: schema.required?.includes(name) ?? false,
		description: "description" in parameter && typeof parameter.description === "string" ? parameter.description : "",
		constraints: schemaConstraints(parameter),
		...("default" in parameter ? { default: metadataValue(parameter.default) } : {}),
	}));
}

function consumptionExample(definition: FunctionDefinition): string {
	const example = definition.prompt.example;
	if (definition.pythonReturnType === "None") return example;
	const assigned = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*await\s/.exec(example)?.[1];
	if (!assigned && !example.startsWith("await ")) return example;
	const variable = assigned ?? "result";
	const call = assigned ? example : `${variable} = ${example}`;
	return /^(Page|list)\[/.test(definition.pythonReturnType)
		? `${call}\nfor item in ${variable}[:3]:\n    print(item)`
		: `${call}\nprint(${variable})`;
}

function schemaDefaults(definition: FunctionDefinition): JsonValue {
	const defaults: Record<string, JsonValue> = {};
	for (const [name, schema] of Object.entries(definition.inputSchema.properties)) {
		if ("default" in schema) defaults[name] = metadataValue(schema.default);
	}
	return defaults;
}

export function hasCapability(capabilities: ReadonlySet<string>, capability: string, namespace: string): boolean {
	if (capabilities.has("*") || capabilities.has(capability) || capabilities.has(`${namespace}.*`)) return true;
	return [...capabilities].some(
		(candidate) => candidate.endsWith(".*") && capability.startsWith(candidate.slice(0, -1)),
	);
}

function isFunctionAvailable(definition: FunctionDefinition, capabilities: ReadonlySet<string> | undefined): boolean {
	return (
		capabilities === undefined ||
		definition.capability === undefined ||
		hasCapability(capabilities, definition.capability, definition.namespace)
	);
}

function publicDefinitions(
	definitions: readonly FunctionDefinition[],
	capabilities: ReadonlySet<string> | undefined,
): FunctionDefinition[] {
	return definitions.filter(
		(definition) => definition.visibility === "public" && isFunctionAvailable(definition, capabilities),
	);
}

function pythonLiteral(value: JsonValue): string {
	if (value === null) return "None";
	if (typeof value === "boolean") return value ? "True" : "False";
	if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
	if (typeof value === "object")
		return `{${Object.entries(value)
			.map(([key, item]) => `${JSON.stringify(key)}: ${pythonLiteral(item)}`)
			.join(", ")}}`;
	return JSON.stringify(value);
}

function promptArgument(name: string, schema: TSchema, required: boolean): string {
	if ("default" in schema) return `${name}=${pythonLiteral(metadataValue(schema.default))}`;
	return required ? `${name}=...` : `${name}=<omitted>`;
}

const PYTHON_RETURN_METHODS = new Map<string, readonly string[]>([
	["TextSnapshot", ["lines(*, start=1, end=None) [local]"]],
	["Page", ["next()", "iteration and indexing [local]"]],
	["ArtifactSlice", ["data"]],
]);

function visibleOutputFields(schema: TSchema): string[] {
	if (IsObject(schema)) {
		return Object.keys(schema.properties).filter((name) => !name.startsWith("$") && !name.startsWith("_"));
	}
	if (IsArray(schema)) return visibleOutputFields(schema.items);
	if (IsUnion(schema)) return [];
	return [];
}

function formatNamedReturnShape(
	returnType: string,
	schema: TSchema,
	definitions: readonly FunctionDefinition[],
): string {
	const fields = returnType === "McpNamespace" ? [] : visibleOutputFields(schema);
	const typeName = returnType.split("[", 1)[0];
	const methods = [...(PYTHON_RETURN_METHODS.get(typeName) ?? [])];
	for (const [name, alias] of HANDLE_METHODS) {
		if (!name.startsWith(`${typeName}.`)) continue;
		const definition = definitions.find(
			(item) => `${item.namespace}.${item.name}` === alias.operation && item.visibility !== "internal",
		);
		if (!definition) continue;
		const inputSchema = Type.Object(
			Object.fromEntries(
				Object.entries(definition.inputSchema.properties).filter(([key]) => !alias.bound.includes(key)),
			),
			{ additionalProperties: false },
		);
		methods.push(
			promptInventoryItem({ ...definition, name: name.slice(typeName.length + 1), inputSchema }).slice(1, -1),
		);
	}
	const details = [fields.join(", "), methods.join(", ")].filter(Boolean).join("; ");
	return details ? `${returnType}(${details})` : returnType;
}

function formatPythonReturnShape(
	returnType: string,
	schema: TSchema,
	definitions: readonly FunctionDefinition[],
): string {
	if (IsUnion(schema))
		return schema.anyOf
			.map((branch) =>
				formatNamedReturnShape(
					"$id" in branch && typeof branch.$id === "string" ? branch.$id : returnType,
					branch,
					definitions,
				),
			)
			.join(" | ");
	const listMatch = /^list\[(.+)]$/.exec(returnType);
	if (listMatch && IsArray(schema)) return `list[${formatNamedReturnShape(listMatch[1], schema.items, definitions)}]`;
	return formatNamedReturnShape(returnType, schema, definitions);
}

function promptInventoryItem(definition: FunctionDefinition): string {
	const required = new Set(definition.inputSchema.required ?? []);
	const argumentsText = Object.entries(definition.inputSchema.properties)
		.map(([name, schema]) => promptArgument(name, schema, required.has(name)))
		.join(", ");
	return `\`${definition.name}(${argumentsText ? `*, ${argumentsText}` : ""}) -> ${definition.pythonReturnType}\``;
}

export class FunctionRegistry {
	private readonly definitions = new Map<string, FunctionDefinition>();
	private cachedPrompt?: { capabilities: string; text: string };

	register(definition: FunctionDefinition): void {
		if (!isPythonIdentifier(definition.namespace) || !isPythonIdentifier(definition.name)) {
			throw new Error(`Invalid Python function name: ${definition.namespace}.${definition.name}`);
		}
		const qualifiedName = `${definition.namespace}.${definition.name}`;
		if (this.definitions.has(qualifiedName)) throw new Error(`Function is already registered: ${qualifiedName}`);
		if (
			definition.inputSchema.type !== "object" ||
			!("additionalProperties" in definition.inputSchema) ||
			definition.inputSchema.additionalProperties !== false
		) {
			throw new Error(`Input schema for ${qualifiedName} must be an object with additionalProperties false`);
		}
		for (const name of Object.keys(definition.inputSchema.properties)) {
			if (!isPythonIdentifier(name)) throw new Error(`Invalid parameter name: ${name}`);
		}
		this.definitions.set(qualifiedName, definition);
		this.cachedPrompt = undefined;
	}

	unregisterNamespace(namespace: string): void {
		this.cachedPrompt = undefined;
		for (const name of this.definitions.keys()) {
			if (name.startsWith(`${namespace}.`)) this.definitions.delete(name);
		}
	}

	get(name: string): FunctionDefinition | undefined {
		return this.definitions.get(name);
	}

	list(capabilities?: ReadonlySet<string>): FunctionDefinition[] {
		return [...this.definitions.values()]
			.filter((definition) => isFunctionAvailable(definition, capabilities))
			.sort((left, right) => {
				const leftName = `${left.namespace}.${left.name}`;
				const rightName = `${right.namespace}.${right.name}`;
				return leftName.localeCompare(rightName);
			});
	}

	pythonSpecifications(namespace?: string, capabilities?: ReadonlySet<string>): PythonFunctionSpecification[] {
		return this.list(capabilities)
			.filter((definition) => definition.visibility !== "internal")
			.filter((definition) => namespace === undefined || definition.namespace === namespace)
			.map((definition) => ({
				name: definition.name,
				namespace: definition.namespace,
				qualified_name: `${definition.namespace}.${definition.name}`,
				description: definition.description,
				input_schema: metadataValue(definition.inputSchema),
				output_schema: metadataValue(definition.outputSchema),
				return_type: definition.pythonReturnType,
				visibility: definition.visibility,
			}));
	}

	search(query: string, limit = 8, capabilities?: ReadonlySet<string>): JsonValue {
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
			throw new RiemannHostError("invalid_arguments", "limit must be an integer from 1 to 50");
		}
		return (this.searchAll(query, capabilities) as JsonValue[]).slice(0, limit);
	}

	searchAll(query: string, capabilities?: ReadonlySet<string>): JsonValue[] {
		const terms = words(query);
		return publicDefinitions(this.list(capabilities), capabilities)
			.map((definition) => {
				const qualifiedName = `${definition.namespace}.${definition.name}`;
				const haystack = words(
					`${qualifiedName} ${definition.description} ${definition.capability ?? ""} ${JSON.stringify(definition.inputSchema)}`,
				);
				const score = terms.reduce((total, term) => {
					if (qualifiedName.toLowerCase() === term) return total + 20;
					if (qualifiedName.toLowerCase().includes(term)) return total + 8;
					return total + haystack.filter((word) => word.includes(term)).length;
				}, 0);
				return { definition, qualifiedName, score };
			})
			.filter((item) => terms.length === 0 || item.score > 0)
			.sort((left, right) => right.score - left.score || left.qualifiedName.localeCompare(right.qualifiedName))
			.map(({ definition, qualifiedName }) => ({
				$riemann: "operation_summary",
				name: qualifiedName,
				signature: promptInventoryItem({ ...definition, name: qualifiedName }).slice(1, -1),
				description: definition.description,
				python_return_type: definition.pythonReturnType,
				capability: definition.capability ?? null,
			}));
	}

	describe(name: string, capabilities?: ReadonlySet<string>, detail: "usage" | "schema" = "usage"): JsonValue {
		if (detail !== "usage" && detail !== "schema")
			throw new RiemannHostError("invalid_arguments", "detail must be usage or schema");
		const localMethod = /^(TextSnapshot)\.(lines)$|^(Page)\.(next)$/.exec(name);
		if (localMethod) {
			const [typeName, method] = name.split(".");
			const owner = this.describe(typeName, capabilities, "schema");
			if (typeof owner !== "object" || owner === null || Array.isArray(owner))
				throw new RiemannHostError("not_found", `Type not found: ${typeName}`);
			const inputSchema =
				method === "lines"
					? Type.Object(
							{
								start: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
								end: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { default: null })),
							},
							{ additionalProperties: false },
						)
					: Type.Object({}, { additionalProperties: false });
			const outputSchema = method === "lines" ? Type.String() : owner.output_schema;
			const { input_schema: _input, output_schema: _output, ...usage } = owner;
			return {
				...usage,
				name,
				description: `Read-only ${name} method.`,
				execution: method === "lines" ? "local" : "host",
				...(method === "lines"
					? {
							effects: [],
							idempotency: "idempotent",
							capability: null,
							cancellation: {
								supported: false,
								description: "Local synchronous text slicing.",
								before_start: "reject",
								during_execution: "settle",
								side_effects_may_remain: false,
							},
							errors: [
								{
									code: "ValueError",
									description: "The line range must be positive and ordered.",
									retryable: false,
									recovery: "fix_arguments",
								},
							],
						}
					: {}),
				signature: method === "lines" ? `${name}(*, start=1, end=None) -> str` : `${name}() -> Page`,
				python_return_type: method === "lines" ? "str" : "Page",
				returns: method === "lines" ? "str" : usage.returns,
				defaults: method === "lines" ? { start: 1, end: null } : {},
				parameters: parameterUsage(inputSchema),
				example: method === "lines" ? "snapshot.lines(start=1, end=10)" : "await page.next()",
				...(detail === "schema"
					? { input_schema: metadataValue(inputSchema), output_schema: metadataValue(outputSchema) }
					: {}),
			};
		}
		const alias = HANDLE_METHODS.get(name);
		let definition = this.definitions.get(alias?.operation ?? name);
		if (!definition || definition.visibility === "internal" || !isFunctionAvailable(definition, capabilities)) {
			definition = undefined;
		}
		let outputSchema: TSchema | undefined;
		if (!definition && !alias) {
			const visit = (schema: TSchema, typeName?: string): TSchema | undefined => {
				if (("$id" in schema && schema.$id === name) || typeName === name || typeName?.split("[", 1)[0] === name)
					return schema;
				if (IsUnion(schema)) return schema.anyOf.map((item) => visit(item)).find(Boolean);
				if (IsArray(schema)) return visit(schema.items, typeName?.match(/^list\[(.+)]$/)?.[1]);
				if (IsObject(schema) && "additionalProperties" in schema && schema.additionalProperties === false) {
					const tag = schema.properties.$riemann;
					const taggedName =
						tag && "const" in tag && typeof tag.const === "string"
							? tag.const
									.split("_")
									.map((part) => part[0].toUpperCase() + part.slice(1))
									.join("")
							: undefined;
					const recordName =
						"$id" in schema && typeof schema.$id === "string"
							? schema.$id
							: (typeName?.split("[", 1)[0] ?? taggedName);
					if (taggedName === name) return schema;
					return Object.entries(schema.properties)
						.map(([key, item]) => {
							const childName = `${recordName ?? ""}${key
								.split("_")
								.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
								.join("")}`;
							const hint =
								recordName === "Page" && key === "items" && typeName?.startsWith("Page[")
									? `list[${typeName.slice(5, -1)}]`
									: IsArray(item)
										? `list[${childName}Item]`
										: childName;
							return visit(item, hint);
						})
						.find(Boolean);
				}
				return undefined;
			};
			for (const candidate of this.list(capabilities).filter((item) => item.visibility !== "internal")) {
				outputSchema = visit(candidate.outputSchema, candidate.pythonReturnType);
				if (outputSchema) {
					definition = candidate;
					break;
				}
			}
		}
		if (!definition) throw new RiemannHostError("not_found", `Function or type not found: ${name}`);
		const typeQuery = outputSchema !== undefined;
		const inputSchema = typeQuery
			? Type.Object({}, { additionalProperties: false })
			: alias
				? Type.Object(
						Object.fromEntries(
							Object.entries(definition.inputSchema.properties).filter(([key]) => !alias.bound.includes(key)),
						),
						{ additionalProperties: false },
					)
				: definition.inputSchema;
		const described = { ...definition, name, inputSchema, outputSchema: outputSchema ?? definition.outputSchema };
		const errors = new Map([...COMMON_FUNCTION_ERRORS, ...definition.errors].map((item) => [item.code, item]));
		return {
			name,
			description: typeQuery ? `Read-only ${name} result record.` : definition.description,
			execution: typeQuery ? "local" : "host",
			signature: typeQuery ? name : promptInventoryItem(described).slice(1, -1),
			returns: formatPythonReturnShape(
				typeQuery ? name : definition.pythonReturnType,
				described.outputSchema,
				this.list(capabilities),
			),
			defaults: schemaDefaults(described),
			parameters: parameterUsage(inputSchema),
			python_return_type: typeQuery ? name : definition.pythonReturnType,
			errors: [...errors.values()].map((item) => ({
				...item,
				recovery:
					"recovery" in item
						? (item.recovery ?? errorRecovery(item.code, item.retryable))
						: errorRecovery(item.code, item.retryable),
			})),
			effects: metadataValue(definition.effects),
			idempotency: definition.idempotency,
			cancellation: {
				...definition.cancellation,
				before_start: "reject",
				during_execution: definition.cancellation.supported ? "cooperative" : "settle",
				side_effects_may_remain: definition.effects.some((effect) => effect.kind !== "read"),
			},
			capability: definition.capability ?? null,
			example: consumptionExample(definition),
			...(detail === "schema"
				? {
						input_schema: metadataValue(inputSchema),
						output_schema: metadataValue(described.outputSchema),
						...(definition.updateSchema ? { update_schema: metadataValue(definition.updateSchema) } : {}),
						...(definition.remoteOutputSchema
							? { remote_output_schema: metadataValue(definition.remoteOutputSchema) }
							: {}),
					}
				: {}),
		};
	}

	promptInventory(capabilities: ReadonlySet<string>): string {
		const capabilityKey = [...capabilities].sort().join("\n");
		if (this.cachedPrompt?.capabilities === capabilityKey) return this.cachedPrompt.text;
		const available = this.list(capabilities);
		const visible = publicDefinitions(available, capabilities);
		const grouped = new Map<string, string[]>();
		const returnTypes = new Map<string, string>();
		const collect = (name: string, schema: TSchema): void => {
			if (IsArray(schema) && name.startsWith("list[")) {
				collect(name.slice(5, -1), schema.items);
				return;
			}
			if (IsUnion(schema)) {
				const branches = schema.anyOf.filter((branch) => "$id" in branch && typeof branch.$id === "string");
				if (branches.length) {
					returnTypes.set(
						name,
						`${name} = ${branches.map((branch) => ("$id" in branch ? String(branch.$id) : "")).join(" | ")}`,
					);
					for (const branch of branches)
						if ("$id" in branch && typeof branch.$id === "string") collect(branch.$id, branch);
					return;
				}
			}
			if (name.startsWith("Page[") && IsObject(schema)) {
				returnTypes.set("Page", formatNamedReturnShape("Page", schema, available));
				const items = schema.properties.items;
				if (IsArray(items)) collect(name.slice(5, -1), items.items);
				return;
			}
			if (/^[A-Z]/.test(name)) returnTypes.set(name, formatPythonReturnShape(name, schema, available));
		};
		for (const definition of [...visible].sort((left, right) => {
			const namespaceOrder =
				(PROMPT_NAMESPACE_ORDER.get(left.namespace) ?? Number.MAX_SAFE_INTEGER) -
				(PROMPT_NAMESPACE_ORDER.get(right.namespace) ?? Number.MAX_SAFE_INTEGER);
			if (namespaceOrder !== 0) return namespaceOrder;
			return left.name.localeCompare(right.name);
		})) {
			const items = grouped.get(definition.namespace) ?? [];
			items.push(promptInventoryItem(definition));
			collect(definition.pythonReturnType, definition.outputSchema);
			grouped.set(definition.namespace, items);
		}
		const inventory = [...grouped].map(([namespace, items]) => `- \`${namespace}\`: ${items.join("; ")}`).join("\n");
		const summary = returnTypes.size
			? `${inventory}\n- Return types: ${[...returnTypes.values()].map((shape) => `\`${shape}\``).join("; ")}. Use \`output.show(value=..., fields=None)\` for explicit display.`
			: inventory;
		const contracts = visible.map((definition) =>
			[
				`### ${definition.namespace}.${definition.name}`,
				definition.description,
				`Input contract (JSON Schema; construct arguments as Python values):\n\`\`\`json\n${JSON.stringify(definition.inputSchema)}\n\`\`\``,
				`Example:\n\`\`\`python\n${consumptionExample(definition)}\n\`\`\``,
			].join("\n\n"),
		);
		const text = [summary, ...contracts].join("\n\n");
		this.cachedPrompt = { capabilities: capabilityKey, text };
		return text;
	}

	promptGuidelines(capabilities: ReadonlySet<string>): string[] {
		const guidelines = new Set<string>();
		for (const definition of publicDefinitions(this.list(capabilities), capabilities)) {
			for (const guideline of definition.prompt.guidelines ?? []) {
				const normalized = guideline.replace(/\s+/g, " ").trim();
				if (normalized) guidelines.add(normalized);
			}
		}
		return [...guidelines];
	}

	async dispatch(
		request: KernelHostRequest,
		capabilities: ReadonlySet<string>,
		signal: AbortSignal,
		onUpdate?: FunctionUpdateCallback,
		retain?: (value: JsonValue) => Promise<string | undefined>,
	): Promise<JsonValue | KernelHostResult> {
		const definition = this.definitions.get(request.operation);
		if (!definition) throw new RiemannHostError("not_found", `Function is not registered: ${request.operation}`);
		if (!isFunctionAvailable(definition, capabilities)) {
			throw new RiemannHostError(
				"permission_denied",
				`Capability ${definition.capability} is not available to this agent`,
			);
		}
		if (signal.aborted)
			throw new RiemannHostError("cancelled", `Call cancelled before execution: ${request.operation}`);
		const args = { ...request.arguments };
		for (const [name, schema] of Object.entries(definition.inputSchema.properties)) {
			if (!Object.hasOwn(args, name) && "default" in schema) args[name] = metadataValue(schema.default);
		}
		if (!Value.Check(definition.inputSchema, args)) {
			const details = validationDetails(definition.inputSchema, args);
			const first = details.errors[0];
			throw new RiemannHostError(
				"invalid_arguments",
				`Invalid arguments for ${request.operation}${first ? `: ${first.path || "/"}: expected ${first.expected}; received ${first.received}` : ""}`,
				details,
			);
		}
		let updateError: RiemannHostError | undefined;
		const update = (value: JsonValue): void => {
			if (updateError) return;
			if (definition.updateSchema && !Value.Check(definition.updateSchema, value)) {
				updateError = new RiemannHostError(
					"invalid_output",
					`Invalid update from ${request.operation}`,
					validationDetails(definition.updateSchema, value),
				);
				return;
			}
			try {
				onUpdate?.(value);
			} catch {
				updateError = new RiemannHostError("internal_error", `Update observer failed for ${request.operation}`);
			}
		};
		let result: JsonValue | KernelHostResult;
		try {
			result = await definition.handler(args, signal, onUpdate || definition.updateSchema ? update : undefined);
		} catch (error) {
			if (error instanceof RiemannHostError) throw error;
			if (signal.aborted) throw new RiemannHostError("cancelled", `Call cancelled: ${request.operation}`);
			throw new RiemannHostError(
				"internal_error",
				`Host operation failed: ${request.operation}`,
				error instanceof Error
					? {
							name: error.name,
							message: error.message,
							stack: error.stack ?? null,
							cause:
								error.cause instanceof Error
									? { name: error.cause.name, message: error.cause.message, stack: error.cause.stack ?? null }
									: null,
						}
					: undefined,
			);
		}
		const output = isKernelHostResult(result) ? result.value : result;
		const ref = await retain?.(output);
		if (updateError)
			throw new RiemannHostError(updateError.code, updateError.message, {
				ref: ref ?? null,
				errors: updateError.details ?? null,
			});
		if (!Value.Check(definition.outputSchema, output)) {
			throw new RiemannHostError("invalid_output", `Invalid output from ${request.operation}`, {
				...validationDetails(definition.outputSchema, output),
				ref: ref ?? null,
			});
		}
		return result;
	}
}
