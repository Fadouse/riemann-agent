import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { RiemannHostError } from "../errors.ts";
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
	return_type: string;
}

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

function validationDetails(schema: TSchema, value: unknown): JsonValue {
	return {
		errors: [...Value.Errors(schema, value)].slice(0, 8).map((error) => ({
			path: error.instancePath,
			message: error.message,
		})),
	};
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

function promptArgument(name: string, schema: TSchema, required: boolean): string {
	if ("default" in schema) return `${name}=${JSON.stringify(schema.default)}`;
	return required ? `${name}=...` : `${name}=None`;
}

function promptInventoryLine(definition: FunctionDefinition): string {
	const qualifiedName = `${definition.namespace}.${definition.name}`;
	const required = new Set(definition.inputSchema.required ?? []);
	const argumentsText = Object.entries(definition.inputSchema.properties)
		.map(([name, schema]) => promptArgument(name, schema, required.has(name)))
		.join(", ");
	return `- \`await ${qualifiedName}(${argumentsText}) -> ${definition.pythonReturnType}\``;
}

export class FunctionRegistry {
	private readonly definitions = new Map<string, FunctionDefinition>();

	register(definition: FunctionDefinition): void {
		if (!isPythonIdentifier(definition.namespace) || !isPythonIdentifier(definition.name)) {
			throw new Error(`Invalid Python function name: ${definition.namespace}.${definition.name}`);
		}
		const qualifiedName = `${definition.namespace}.${definition.name}`;
		if (this.definitions.has(qualifiedName)) throw new Error(`Function is already registered: ${qualifiedName}`);
		if (definition.abiVersion !== 2) throw new Error(`Unsupported ABI version for ${qualifiedName}`);
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
	}

	unregisterNamespace(namespace: string): void {
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
		return publicDefinitions(this.list(capabilities), capabilities)
			.filter((definition) => namespace === undefined || definition.namespace === namespace)
			.map((definition) => ({
				name: definition.name,
				namespace: definition.namespace,
				qualified_name: `${definition.namespace}.${definition.name}`,
				description: definition.description,
				input_schema: metadataValue(definition.inputSchema),
				return_type: definition.pythonReturnType,
			}));
	}

	search(query: string, limit = 8, capabilities?: ReadonlySet<string>): JsonValue {
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
			throw new RiemannHostError("invalid_arguments", "limit must be an integer from 1 to 50");
		}
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
			.slice(0, limit)
			.map(({ definition, qualifiedName }) => ({
				name: qualifiedName,
				description: definition.description,
				pythonReturnType: definition.pythonReturnType,
				capability: definition.capability ?? null,
			}));
	}

	describe(name: string, capabilities?: ReadonlySet<string>): JsonValue {
		const definition = this.definitions.get(name);
		if (!definition || definition.visibility !== "public" || !isFunctionAvailable(definition, capabilities)) {
			throw new RiemannHostError("not_found", `Function not found: ${name}`);
		}
		return {
			abiVersion: definition.abiVersion,
			name,
			description: definition.description,
			inputSchema: metadataValue(definition.inputSchema),
			outputSchema: metadataValue(definition.outputSchema),
			defaults: schemaDefaults(definition),
			pythonReturnType: definition.pythonReturnType,
			errors: metadataValue(definition.errors),
			effects: metadataValue(definition.effects),
			idempotency: definition.idempotency,
			cancellation: metadataValue(definition.cancellation),
			capability: definition.capability ?? null,
			example: definition.prompt.example,
		};
	}

	promptInventory(capabilities: ReadonlySet<string>): string {
		return publicDefinitions(this.list(capabilities), capabilities)
			.sort((left, right) => {
				const namespaceOrder =
					(PROMPT_NAMESPACE_ORDER.get(left.namespace) ?? Number.MAX_SAFE_INTEGER) -
					(PROMPT_NAMESPACE_ORDER.get(right.namespace) ?? Number.MAX_SAFE_INTEGER);
				if (namespaceOrder !== 0) return namespaceOrder;
				return left.name.localeCompare(right.name);
			})
			.map(promptInventoryLine)
			.join("\n");
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
	): Promise<JsonValue | KernelHostResult> {
		const definition = this.definitions.get(request.operation);
		if (!definition) throw new RiemannHostError("not_found", `Function is not registered: ${request.operation}`);
		if (!isFunctionAvailable(definition, capabilities)) {
			throw new RiemannHostError(
				"permission_denied",
				`Capability ${definition.capability} is not available to this agent`,
			);
		}
		if (!Value.Check(definition.inputSchema, request.arguments)) {
			throw new RiemannHostError(
				"invalid_arguments",
				`Invalid arguments for ${request.operation}`,
				validationDetails(definition.inputSchema, request.arguments),
			);
		}
		let result: JsonValue | KernelHostResult;
		try {
			result = await definition.handler(request.arguments, signal, onUpdate);
		} catch (error) {
			if (error instanceof RiemannHostError) {
				const retryable = definition.errors.find((item) => item.code === error.code)?.retryable ?? error.retryable;
				throw new RiemannHostError(error.code, error.message, error.details, retryable);
			}
			throw error;
		}
		const output = isKernelHostResult(result) ? result.value : result;
		if (!Value.Check(definition.outputSchema, output)) {
			throw new RiemannHostError(
				"invalid_output",
				`Invalid output from ${request.operation}`,
				validationDetails(definition.outputSchema, output),
			);
		}
		return result;
	}
}
