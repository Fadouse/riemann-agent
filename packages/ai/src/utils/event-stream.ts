import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

const QUEUE_COMPACTION_THRESHOLD = 1024;

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private queueHead = 0;
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private waitingHead = 0;
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting[this.waitingHead];
		if (waiter) {
			this.waitingHead++;
			if (this.waitingHead === this.waiting.length) {
				this.waiting = [];
				this.waitingHead = 0;
			} else if (this.waitingHead >= QUEUE_COMPACTION_THRESHOLD && this.waitingHead * 2 >= this.waiting.length) {
				this.waiting = this.waiting.slice(this.waitingHead);
				this.waitingHead = 0;
			}
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		for (; this.waitingHead < this.waiting.length; this.waitingHead++) {
			this.waiting[this.waitingHead]!({ value: undefined, done: true });
		}
		this.waiting = [];
		this.waitingHead = 0;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queueHead < this.queue.length) {
				const event = this.queue[this.queueHead]!;
				this.queueHead++;
				if (this.queueHead === this.queue.length) {
					this.queue = [];
					this.queueHead = 0;
				} else if (this.queueHead >= QUEUE_COMPACTION_THRESHOLD && this.queueHead * 2 >= this.queue.length) {
					this.queue = this.queue.slice(this.queueHead);
					this.queueHead = 0;
				}
				yield event;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
