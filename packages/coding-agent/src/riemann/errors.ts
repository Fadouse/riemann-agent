import type { JsonValue } from "./kernel/types.ts";

export class RiemannHostError extends Error {
	readonly code: string;
	readonly details?: JsonValue;

	constructor(code: string, message: string, details?: JsonValue) {
		super(message);
		this.name = "RiemannHostError";
		this.code = code;
		this.details = details;
	}
}
