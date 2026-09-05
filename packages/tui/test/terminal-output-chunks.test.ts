import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ProcessTerminal, TerminalWriter } from "../src/terminal.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

const CHUNK_CHARS = 1024 * 1024;
const RESET = "\x1b[0m\x1b]8;;\x07";

class RecordingTerminal extends ProcessTerminal {
	readonly writes: Buffer[] = [];
	maxWriteChars = 0;
	override get columns(): number {
		return 80;
	}
	override get rows(): number {
		return 2;
	}
	override write(data: string): void {
		this.maxWriteChars = Math.max(this.maxWriteChars, data.length);
		this.writes.push(Buffer.from(data));
	}
}

class OutputScreen extends TuiAltScreen {
	enter(): void {
		this.stopped = false;
		this.beforeTerminalStart();
	}
	exit(): void {
		this.beforeTerminalStop({});
		this.afterTerminalStop({});
		this.stopped = true;
	}
	frame(): void {
		this.doRender();
	}
}

describe("complete terminal output chunking", () => {
	beforeEach(() => setCapabilities({ images: null, trueColor: true, hyperlinks: true }));
	afterEach(() => resetCapabilitiesCache());
	it("streams fullscreen exit history without retaining another history array", () => {
		const terminal = new RecordingTerminal();
		const screen = new OutputScreen(terminal);
		const lines = Array.from({ length: 50_000 }, (_, index) => `\x1b]133;A\x07${CURSOR_MARKER}条目🙂é ${index}`);
		screen.addChild({ render: () => lines, invalidate() {} });
		screen.enter();
		terminal.writes.length = 0;
		terminal.maxWriteChars = 0;
		screen.exit();
		const emitted = Buffer.concat(terminal.writes);
		const expected =
			"\x1b[?2026h\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?7h\x1b[?2026l" +
			"\x1b[?2026h\x1b[?1049l\x1b[?7l" +
			lines.map((_, index) => `\r\x1b[2K条目🙂é ${index}${RESET}`).join("\r\n") +
			"\x1b[0m\x1b[?7h\r\n\x1b[?25h\x1b[?2026l";
		assert.deepEqual(emitted, Buffer.from(expected));
		assert.ok(terminal.maxWriteChars <= CHUNK_CHARS, "exit constructed a full-history terminal write");
		assert.ok(
			!Object.hasOwn(screen, "lastDocument"),
			"stopped fullscreen UI retained a redundant normalized history array",
		);
		assert.equal(lines[0], `\x1b]133;A\x07${CURSOR_MARKER}条目🙂é 0`);
	});

	it("streams a complete large image frame in synchronized ANSI order", () => {
		const terminal = new RecordingTerminal();
		const screen = new OutputScreen(terminal);
		const image = `\x1b_Ga=T,f=100,q=2,i=23;${"A".repeat(2 * CHUNK_CHARS)}\x1b\\`;
		screen.setLayoutRoot({ render: () => [image, "中文🙂"], invalidate() {} });
		screen.enter();
		terminal.writes.length = 0;
		terminal.maxWriteChars = 0;
		screen.frame();
		const emitted = Buffer.concat(terminal.writes);
		assert.ok(emitted.includes(Buffer.from(image)), "image transmission was altered or dropped");
		assert.ok(emitted.includes(Buffer.from("中文🙂")));
		assert.ok(emitted.subarray(0, 8).equals(Buffer.from("\x1b[?2026h")));
		assert.ok(emitted.subarray(-8).equals(Buffer.from("\x1b[?2026l")));
		assert.equal(
			createHash("sha256").update(emitted).digest("hex"),
			"21bc49494976ee8a4d40de8b1897e437314241af1c1d6d132af3bac3b6bf1cc3",
		);
		assert.ok(terminal.maxWriteChars <= CHUNK_CHARS, "frame constructed a full-image terminal write");
		screen.exit();
	});
	it("does not segment normalized short rows that provably fit the terminal", (context) => {
		const terminal = new RecordingTerminal();
		const screen = new OutputScreen(terminal);
		const line = "\x1b[36m界🙂短行\x1b[0m";
		screen.addChild({ render: () => [line], invalidate() {} });
		screen.enter();
		const segment = context.mock.method(Intl.Segmenter.prototype, "segment");
		screen.exit();
		assert.ok(Buffer.concat(terminal.writes).includes(Buffer.from(`${line}${RESET}`)));
		assert.equal(
			segment.mock.calls.some((call) => String(call.arguments[0]).includes("短行")),
			false,
			"exit segmented text even though its UTF-16 upper bound fits",
		);
	});
	it("preserves surrogate pairs crossing separate appends at a write boundary", () => {
		for (const tail of ["\ude00", "x", ""]) {
			const parts = [`${"x".repeat(CHUNK_CHARS - 1)}\ud83d`, "", tail];
			const chunks: Buffer[] = [];
			const writer = new TerminalWriter((data) => chunks.push(Buffer.from(data)));
			for (const part of parts) writer.append(part);
			writer.flush();
			assert.deepEqual(Buffer.concat(chunks), Buffer.from(parts.join("")));
			assert.equal(
				writer.length,
				parts.reduce((length, part) => length + part.length, 0),
			);
			const writes = chunks.length;
			writer.flush();
			assert.equal(chunks.length, writes);
		}
	});
});
