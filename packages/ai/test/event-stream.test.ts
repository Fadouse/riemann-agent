import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream", () => {
	it("preserves queued event order across compaction and resolves the terminal result", async () => {
		const terminalEvent = 4096;
		const stream = new EventStream<number, number>(
			(event) => event === terminalEvent,
			(event) => event,
		);

		for (let event = 0; event <= terminalEvent; event++) {
			stream.push(event);
		}
		stream.push(terminalEvent + 1);

		const received: number[] = [];
		for await (const event of stream) {
			received.push(event);
		}

		expect(received).toEqual(Array.from({ length: terminalEvent + 1 }, (_, index) => index));
		await expect(stream.result()).resolves.toBe(terminalEvent);
	});

	it("unblocks a waiting consumer when ended explicitly", async () => {
		const stream = new EventStream<number, string>(
			() => false,
			() => "unused",
		);
		const iterator = stream[Symbol.asyncIterator]();
		const nextEvent = iterator.next();

		stream.end("finished");

		await expect(nextEvent).resolves.toEqual({ value: undefined, done: true });
		await expect(stream.result()).resolves.toBe("finished");
	});

	it("delivers an error terminal event and exposes its result", async () => {
		type TestEvent = { type: "value"; value: number } | { type: "error"; error: Error };
		const stream = new EventStream<TestEvent, Error>(
			(event) => event.type === "error",
			(event) => {
				if (event.type === "error") return event.error;
				throw new Error("Expected an error event");
			},
		);
		const error = new Error("stream failed");
		const valueEvent = { type: "value", value: 1 } as const;
		const errorEvent = { type: "error", error } as const;

		stream.push(valueEvent);
		stream.push(errorEvent);
		stream.push({ type: "value", value: 2 });

		const received: TestEvent[] = [];
		for await (const event of stream) {
			received.push(event);
		}

		expect(received).toEqual([valueEvent, errorEvent]);
		await expect(stream.result()).resolves.toBe(error);
	});
});
