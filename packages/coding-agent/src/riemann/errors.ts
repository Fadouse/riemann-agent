import type { JsonValue } from "./kernel/types.ts";

export type ErrorRecovery = "none" | "retry" | "refresh" | "fix_arguments" | "reauthorize";

export function errorRecovery(code: string, retryable = false): ErrorRecovery {
	if (code === "invalid_arguments" || code === "response_too_large") return "fix_arguments";
	if (code === "conflict" || code === "not_found" || code === "cursor_expired") return "refresh";
	if (code === "permission_denied" || code === "approval_required") return "reauthorize";
	return retryable ? "retry" : "none";
}

export class RiemannHostError extends Error {
	readonly code: string;
	readonly details?: JsonValue;
	readonly retryable: boolean;
	readonly recovery: ErrorRecovery;
	resultRef?: string;

	constructor(code: string, message: string, details?: JsonValue, retryable = false, recovery?: ErrorRecovery) {
		super(message);
		this.name = "RiemannHostError";
		this.code = code;
		this.details = details;
		this.retryable = retryable;
		this.recovery = recovery ?? errorRecovery(code, retryable);
	}
}
