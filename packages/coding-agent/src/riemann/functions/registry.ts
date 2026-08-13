import { RiemannHostError } from "../errors.ts";
import type { JsonValue, KernelHostRequest } from "../kernel/types.ts";

export interface FunctionParameter {
	name: string;
	description: string;
	type: string;
	required: boolean;
}

export type FunctionUpdateCallback = (update: JsonValue) => void;

export interface FunctionDefinition {
	name: string;
	namespace: string;
	description: string;
	parameters: FunctionParameter[];
	returns: string;
	examples?: string[];
	capability?: string;
	promptSnippet?: string;
	includeInSystemPrompt?: boolean;
	promptGuidelines?: readonly string[];
	handler: (
		args: Record<string, JsonValue>,
		signal: AbortSignal,
		onUpdate?: FunctionUpdateCallback,
	) => Promise<JsonValue>;
}

export interface PythonFunctionSpecification {
	name: string;
	namespace: string;
	qualified_name: string;
	description: string;
	parameters: Array<{ name: string; required: boolean }>;
}

const PROMPT_NAMESPACE_ORDER = new Map(
	["workspace", "shell", "web", "artifacts", "agents", "mcp", "catalog", "state"].map((namespace, index) => [
		namespace,
		index,
	]),
);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function words(value: string): string[] {
	return value.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
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

function promptInventoryLine(definition: FunctionDefinition): string {
	const qualifiedName = `${definition.namespace}.${definition.name}`;
	const parameters = definition.parameters
		.map((parameter) => (parameter.required ? parameter.name : `${parameter.name}=None`))
		.join(", ");
	const description = (definition.promptSnippet ?? definition.description).replace(/\s+/g, " ").trim();
	return `- \`${qualifiedName}(${parameters}) -> ${definition.returns}\`: ${description}`;
}

export class FunctionRegistry {
	private readonly definitions = new Map<string, FunctionDefinition>();

	register(definition: FunctionDefinition): void {
		if (!IDENTIFIER.test(definition.namespace) || !IDENTIFIER.test(definition.name)) {
			throw new Error(`Invalid Python function name: ${definition.namespace}.${definition.name}`);
		}
		const seen = new Set<string>();
		let optionalSeen = false;
		for (const parameter of definition.parameters) {
			if (!IDENTIFIER.test(parameter.name)) throw new Error(`Invalid parameter name: ${parameter.name}`);
			if (seen.has(parameter.name)) throw new Error(`Duplicate parameter name: ${parameter.name}`);
			seen.add(parameter.name);
			if (!parameter.required) optionalSeen = true;
			else if (optionalSeen) throw new Error(`Required parameter ${parameter.name} follows an optional parameter`);
		}
		this.definitions.set(`${definition.namespace}.${definition.name}`, definition);
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

	namespaces(capabilities?: ReadonlySet<string>): string[] {
		return [...new Set(this.list(capabilities).map((definition) => definition.namespace))];
	}

	pythonSpecifications(namespace?: string, capabilities?: ReadonlySet<string>): PythonFunctionSpecification[] {
		return this.list(capabilities)
			.filter((definition) => namespace === undefined || definition.namespace === namespace)
			.map((definition) => ({
				name: definition.name,
				namespace: definition.namespace,
				qualified_name: `${definition.namespace}.${definition.name}`,
				description: definition.description,
				parameters: definition.parameters.map(({ name, required }) => ({ name, required })),
			}));
	}

	search(query: string, limit = 8, capabilities?: ReadonlySet<string>): JsonValue {
		const terms = words(query);
		return this.list(capabilities)
			.map((definition) => {
				const qualifiedName = `${definition.namespace}.${definition.name}`;
				const haystack = words(
					`${qualifiedName} ${definition.description} ${definition.parameters.map((item) => item.description).join(" ")}`,
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
			.slice(0, Math.max(1, Math.min(limit, 50)))
			.map(({ definition, qualifiedName }) => ({
				name: qualifiedName,
				description: definition.description,
				returns: definition.returns,
			}));
	}

	describe(name: string, capabilities?: ReadonlySet<string>): JsonValue {
		const definition = this.definitions.get(name);
		if (!definition || !isFunctionAvailable(definition, capabilities)) throw new Error(`Function not found: ${name}`);
		return {
			name,
			description: definition.description,
			parameters: definition.parameters.map((parameter) => ({
				name: parameter.name,
				type: parameter.type,
				required: parameter.required,
				description: parameter.description,
			})),
			returns: definition.returns,
			examples: definition.examples ?? [],
			capability: definition.capability ?? null,
		};
	}

	promptInventory(capabilities: ReadonlySet<string>): string {
		return this.list(capabilities)
			.filter((definition) => definition.includeInSystemPrompt !== false)
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
		for (const definition of this.list(capabilities)) {
			for (const guideline of definition.promptGuidelines ?? []) {
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
	): Promise<JsonValue> {
		const definition = this.definitions.get(request.type);
		if (!definition) throw new Error(`Function is not registered: ${request.type}`);
		if (!isFunctionAvailable(definition, capabilities)) {
			throw new RiemannHostError(
				"permission_denied",
				`Capability ${definition.capability} is not available to this agent`,
			);
		}
		return definition.handler(request.args, signal, onUpdate);
	}
}
