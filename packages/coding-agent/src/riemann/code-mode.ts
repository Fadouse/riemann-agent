import { raceWithAbortSignal } from "../utils/abort.ts";
import { RiemannHostError } from "./errors.ts";
import { setExecutionDeadline } from "./execution.ts";
import type { IPythonToolDetails } from "./ipython.ts";
import type { KernelExecuteResult } from "./kernel/types.ts";

export interface PythonExecOptions {
	timeout_ms: number;
}

export function parsePythonExec(source: string): PythonExecOptions {
	if (!source.trim()) throw new Error("Python source must not be empty");
	const options: PythonExecOptions = {
		timeout_ms: 300000,
	};
	const firstLine = source.split(/\r?\n/, 1)[0];
	const pragma = /^\s*# @exec:\s*(.*)$/.exec(firstLine);
	if (!pragma) return options;
	const value: unknown = JSON.parse(pragma[1]);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("# @exec must contain a JSON object");
	for (const [key, item] of Object.entries(value)) {
		if (key === "timeout_ms") {
			const [min, max] = [1, 86400000];
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
	notify: () => void;
	observers: Set<(details: IPythonToolDetails) => void>;
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
	changed: Promise<void>;
	wake: () => void;
	emptyPolls: number;
}

/** Owns cell lifetime independently of any single exec/wait request. */
export class PythonCells {
	private readonly cells = new Map<string, ActiveCell>();
	private sequence = 0;
	private readonly prefix: string;
	private readonly parallel: boolean;
	private closed = false;

	constructor(prefix = "c", parallel = false) {
		this.prefix = prefix;
		this.parallel = parallel;
	}

	get active(): boolean {
		return this.cells.size > 0;
	}

	get executing(): boolean {
		return [...this.cells.values()].some((cell) => !cell.result);
	}

	get pending(): { cell_id: string; status: "running" | "awaiting_collection"; next_tool: string } | null {
		const cell = this.cells.values().next().value;
		return cell
			? {
					cell_id: cell.id,
					status: cell.result ? "awaiting_collection" : "running",
					next_tool: "ipython_wait",
				}
			: null;
	}

	cancel(id: string): void {
		this.cells.get(id)?.controller.abort(new Error("Python execution cancelled"));
	}

	observe(id: string, observer: (details: IPythonToolDetails) => void): () => void {
		const cell = this.cells.get(id);
		if (!cell) throw new Error(`Unknown or already collected task: ${id}`);
		cell.observers.add(observer);
		observer(cell.details);
		return () => {
			cell.observers.delete(observer);
		};
	}

	has(id: string): boolean {
		return this.cells.has(id);
	}

	start(options: PythonExecOptions, execute: (cell: PythonCell) => Promise<KernelExecuteResult>): string {
		if (this.closed) throw new Error("Python runtime is closed");
		const active = [...this.cells.values()].find((cell) => !cell.result);
		if (!this.parallel && active)
			throw new Error(`Collect cell ${active.id} with ipython_wait before starting another cell`);
		const controller = new AbortController();
		setExecutionDeadline(controller.signal, Date.now() + options.timeout_ms);
		const cell: ActiveCell = {
			id: `${this.prefix}${(++this.sequence).toString(36)}`,
			signal: controller.signal,
			controller,
			details: { status: "running", startedAt: Date.now() },
			done: Promise.resolve(),
			stdout: 0,
			stderr: 0,
			displays: 0,
			modelContent: 0,
			polling: false,
			emptyPolls: 0,
			changed: Promise.resolve(),
			wake: () => {},
			observers: new Set(),
			notify: () => {
				cell.wake();
				cell.changed = new Promise((resolve) => {
					cell.wake = resolve;
				});
				for (const observer of cell.observers) observer(cell.details);
			},
		};
		cell.changed = new Promise((resolve) => {
			cell.wake = resolve;
		});
		this.cells.set(cell.id, cell);
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
					const retained = cell.peek?.();
					cell.result = {
						status: controller.signal.aborted
							? controller.signal.reason?.name === "TimeoutError"
								? "timeout"
								: "cancelled"
							: "error",
						stdout: retained?.stdout ?? "",
						stderr: retained?.stderr ?? "",
						displays: retained?.displays ?? [],
						modelContent: retained?.modelContent ?? [],
						durationMs: Date.now() - (cell.details.startedAt ?? Date.now()),
						error: {
							ename: error instanceof Error ? error.name : "Error",
							evalue: error instanceof Error ? error.message : String(error),
							traceback: [],
							...(error instanceof RiemannHostError ? { details: error.details } : {}),
						},
					};
				},
			)
			.finally(() => {
				clearTimeout(timer);
				cell.notify();
			});
		return cell.id;
	}

	async poll<T>(
		id: string,
		yieldMs: number | undefined,
		terminate: boolean,
		signal: AbortSignal | undefined,
		consume: (result: KernelExecuteResult, running: boolean, cell: PythonCell) => Promise<T>,
	): Promise<T> {
		const cell = this.cells.get(id);
		if (!cell) throw new Error(`Unknown or already collected task: ${id}`);
		if (cell.polling) throw new Error(`Python cell ${id} already has an active wait`);
		const waitMs = yieldMs ?? Math.min(60000, 10000 * 2 ** Math.min(cell.emptyPolls, 3));
		if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000)
			throw new Error("yield_time_ms must be an integer from 0 to 60000");
		cell.polling = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (terminate) cell.controller.abort(new Error("Python cell terminated"));
			const yielded = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, waitMs);
			});
			const deadline = Date.now() + waitMs;
			if (waitMs === 0) await raceWithAbortSignal(Promise.race([cell.done, yielded]), signal);
			while (!cell.result) {
				const preview = cell.peek?.();
				if (
					!terminate &&
					yieldMs === undefined &&
					preview &&
					(preview.stdout.length > cell.stdout ||
						preview.stderr.length > cell.stderr ||
						preview.modelContent.length > cell.modelContent ||
						preview.displays.length > cell.displays)
				)
					break;
				if (Date.now() >= deadline) break;
				await raceWithAbortSignal(Promise.race([cell.done, yielded, cell.changed]), signal);
			}
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
			const hasOutput =
				current.stdout.length > cell.stdout ||
				current.stderr.length > cell.stderr ||
				current.modelContent.length > cell.modelContent ||
				current.displays.length > cell.displays;
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
			cell.emptyPolls = running && !hasOutput ? cell.emptyPolls + 1 : 0;
			if (!running) this.cells.delete(id);
			return result;
		} finally {
			clearTimeout(timer);
			cell.polling = false;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const cell of this.cells.values()) cell.controller.abort(new Error("Python runtime closed"));
		await Promise.all([...this.cells.values()].map((cell) => cell.done));
		this.cells.clear();
	}
}
