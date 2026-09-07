import { randomBytes } from "node:crypto";
import { raceWithAbortSignal } from "../utils/abort.ts";
import type { IPythonToolDetails } from "./ipython.ts";
import type { KernelExecuteResult } from "./kernel/types.ts";

export interface PythonExecOptions {
	yield_time_ms: number;
	max_output_tokens: number;
	timeout_ms: number;
	persist: boolean;
}

export function parsePythonExec(source: string): PythonExecOptions {
	if (!source.trim()) throw new Error("Python source must not be empty");
	const options: PythonExecOptions = {
		yield_time_ms: 10000,
		max_output_tokens: 2000,
		timeout_ms: 300000,
		persist: false,
	};
	const firstLine = source.split(/\r?\n/, 1)[0];
	const pragma = /^\s*# @exec:\s*(.*)$/.exec(firstLine);
	if (!pragma) return options;
	const value: unknown = JSON.parse(pragma[1]);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("# @exec must contain a JSON object");
	for (const [key, item] of Object.entries(value)) {
		if (key === "persist") {
			if (typeof item !== "boolean") throw new Error("persist must be boolean");
			options.persist = item;
		} else if (key === "yield_time_ms" || key === "max_output_tokens" || key === "timeout_ms") {
			const [min, max] =
				key === "yield_time_ms" ? [0, 60000] : key === "max_output_tokens" ? [256, 16384] : [1, 86400000];
			if (typeof item !== "number" || !Number.isInteger(item) || item < min || item > max)
				throw new Error(`${key} must be an integer from ${min} to ${max}`);
			options[key] = item;
		} else throw new Error(`Unknown # @exec option: ${key}`);
	}
	return options;
}

export interface PythonCell {
	id: string;
	signal: AbortSignal;
	details: IPythonToolDetails;
	peek?: () => KernelExecuteResult | undefined;
}

interface ActiveCell extends PythonCell {
	controller: AbortController;
	done: Promise<void>;
	result?: KernelExecuteResult;
	stdout: number;
	stderr: number;
	displays: number;
	modelContent: number;
	polling: boolean;
}

/** Owns cell lifetime independently of any single exec/wait request. */
export class PythonCells {
	private cell?: ActiveCell;
	private closed = false;

	get active(): boolean {
		return this.cell !== undefined;
	}

	get pending(): { cell_id: string; status: "running" | "awaiting_collection"; next_tool: string } | null {
		return this.cell
			? {
					cell_id: this.cell.id,
					status: this.cell.result ? "awaiting_collection" : "running",
					next_tool: "ipython_wait",
				}
			: null;
	}

	cancel(id: string): void {
		if (this.cell?.id === id) this.cell.controller.abort(new Error("Python execution cancelled"));
	}

	start(options: PythonExecOptions, execute: (cell: PythonCell) => Promise<KernelExecuteResult>): string {
		if (this.closed) throw new Error("Python runtime is closed");
		if (this.cell) throw new Error(`Collect cell ${this.cell.id} with ipython_wait before starting another cell`);
		const controller = new AbortController();
		const cell: ActiveCell = {
			id: `c${randomBytes(4).toString("hex")}`,
			signal: controller.signal,
			controller,
			details: { status: "running", startedAt: Date.now() },
			done: Promise.resolve(),
			stdout: 0,
			stderr: 0,
			displays: 0,
			modelContent: 0,
			polling: false,
		};
		this.cell = cell;
		const timer = setTimeout(
			() => controller.abort(new DOMException("Python cell deadline exceeded", "TimeoutError")),
			options.timeout_ms,
		);
		cell.done = Promise.resolve()
			.then(() => execute(cell))
			.then(
				(result) => {
					cell.result = result;
				},
				(error: unknown) => {
					cell.result = {
						status: controller.signal.aborted
							? controller.signal.reason?.name === "TimeoutError"
								? "timeout"
								: "cancelled"
							: "error",
						stdout: "",
						stderr: "",
						displays: [],
						modelContent: [],
						durationMs: Date.now() - (cell.details.startedAt ?? Date.now()),
						error: {
							ename: error instanceof Error ? error.name : "Error",
							evalue: error instanceof Error ? error.message : String(error),
							traceback: [],
						},
					};
				},
			)
			.finally(() => clearTimeout(timer));
		return cell.id;
	}

	async poll<T>(
		id: string,
		yieldMs: number,
		terminate: boolean,
		signal: AbortSignal | undefined,
		consume: (result: KernelExecuteResult, running: boolean, cell: PythonCell) => Promise<T>,
	): Promise<T> {
		const cell = this.cell;
		if (!cell || cell.id !== id) throw new Error(`Unknown or already collected Python cell: ${id}`);
		if (cell.polling) throw new Error(`Python cell ${id} already has an active wait`);
		if (!Number.isInteger(yieldMs) || yieldMs < 0 || yieldMs > 60000)
			throw new Error("yield_time_ms must be an integer from 0 to 60000");
		cell.polling = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (terminate) cell.controller.abort(new Error("Python cell terminated"));
			const yielded = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, yieldMs);
			});
			await raceWithAbortSignal(Promise.race([cell.done, yielded]), signal);
			const current = cell.result ??
				cell.peek?.() ?? {
					status: "ok",
					stdout: "",
					stderr: "",
					displays: [],
					modelContent: [],
					durationMs: Date.now() - (cell.details.startedAt ?? Date.now()),
				};
			const running = cell.result === undefined;
			const result = await consume(
				{
					...current,
					stdout: current.stdout.slice(cell.stdout),
					stderr: current.stderr.slice(cell.stderr),
					displays: current.displays.slice(cell.displays),
					modelContent: current.modelContent.slice(cell.modelContent),
					...(running ? { error: undefined, result: undefined } : {}),
				},
				running,
				cell,
			);
			cell.stdout = current.stdout.length;
			cell.stderr = current.stderr.length;
			cell.displays = current.displays.length;
			cell.modelContent = current.modelContent.length;
			if (!running) this.cell = undefined;
			return result;
		} finally {
			clearTimeout(timer);
			cell.polling = false;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		const cell = this.cell;
		if (!cell) return;
		cell.controller.abort(new Error("Python runtime closed"));
		await cell.done;
		this.cell = undefined;
	}
}
