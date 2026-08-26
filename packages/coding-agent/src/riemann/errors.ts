import type { JsonValue } from "./kernel/types.ts";

export class RiemannHostError extends Error {
	readonly code: string;
	readonly details?: JsonValue;
	readonly retryable: boolean;

	constructor(code: string, message: string, details?: JsonValue, retryable = false) {
		super(message);
		this.name = "RiemannHostError";
		this.code = code;
		this.details = details;
		this.retryable = retryable;
	}
}
