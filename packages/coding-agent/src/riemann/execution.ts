/** The cell owns the deadline; adapters only forward its remaining duration. */
const deadlines = new WeakMap<AbortSignal, number>();

export function setExecutionDeadline(signal: AbortSignal, deadline: number): void {
	deadlines.set(signal, deadline);
}

export function inheritExecutionDeadline(source: AbortSignal | undefined, target: AbortSignal): void {
	const deadline = source && deadlines.get(source);
	if (deadline !== undefined) deadlines.set(target, deadline);
}

export function remainingExecutionMs(signal: AbortSignal): number {
	signal.throwIfAborted();
	const deadline = deadlines.get(signal);
	// MCP requires a timer even when a caller supplies only cancellation. This
	// fallback exceeds the maximum cell lifetime and never shortens that lifetime.
	return deadline === undefined ? 2_147_483_647 : Math.max(1, deadline - Date.now());
}
