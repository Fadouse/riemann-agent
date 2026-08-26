import type { TObject, TSchema } from "typebox";
import type { JsonValue, KernelHostResult } from "../kernel/types.ts";

export type FunctionUpdateCallback = (update: JsonValue) => void;

export type FunctionVisibility = "public" | "handle-method" | "internal";
export type FunctionIdempotency = "idempotent" | "non-idempotent" | "conditional";

export interface FunctionErrorSpecification {
	code: string;
	description: string;
	retryable: boolean;
}

export interface FunctionEffectSpecification {
	kind: string;
	resource: string;
}

export interface FunctionCancellationSpecification {
	supported: boolean;
	description: string;
}

export interface FunctionPromptSpecification {
	inventory: string;
	example: string;
	guidelines?: readonly string[];
}

export interface FunctionDefinition {
	name: string;
	namespace: string;
	description: string;
	inputSchema: TObject;
	outputSchema: TSchema;
	pythonReturnType: string;
	errors: readonly FunctionErrorSpecification[];
	effects: readonly FunctionEffectSpecification[];
	idempotency: FunctionIdempotency;
	cancellation: FunctionCancellationSpecification;
	visibility: FunctionVisibility;
	prompt: FunctionPromptSpecification;
	capability?: string;
	handler: (
		args: Record<string, JsonValue>,
		signal: AbortSignal,
		onUpdate?: FunctionUpdateCallback,
	) => Promise<JsonValue | KernelHostResult>;
}
