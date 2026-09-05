/** Run: node --expose-gc test/editor-performance-bench.ts (from packages/tui).
 * Fixed full-text workloads; allocation samples include collected objects.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

if (!globalThis.gc) throw new Error("Run with --expose-gc");
const session = new Session();
session.connect();
const text = "word 中文 👩🏽‍💻 é ".repeat(2500);
const paste = "paste 中文 👩🏽‍💻\t\r\n\x00".repeat(50000);
const cleanPaste = paste.replace(/\r\n/g, "\n").replace(/\t/g, "    ").replace(/\x00/g, "");
let checksum = 0;
function editorWithText(value: string): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
	editor.setText(value);
	return editor;
}
interface SamplingNode {
	selfSize: number;
	children: SamplingNode[];
}
function sumProfile(node: SamplingNode): number {
	let bytes = node.selfSize;
	for (const child of node.children) bytes += sumProfile(child);
	return bytes;
}
const results = [];
for (const name of ["horizontal", "render", "edit-render", "paste"] as const) {
	if (process.argv[2] && process.argv[2] !== name) continue;
	const editor = editorWithText(name === "paste" ? "" : text);
	const iterations = name === "horizontal" ? 100 : name === "paste" ? 10 : 20;
	const run = () => {
		for (let i = 0; i < iterations; i++) {
			if (name === "horizontal") {
				editor.handleInput("\x01");
				editor.handleInput("\x1b[C");
				editor.handleInput("\x1b[D");
				assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
			} else if (name === "paste") {
				editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
				assert.equal(editor.getExpandedText(), cleanPaste);
				checksum += editor.getExpandedText().length;
				editor.handleInput("\r");
			} else {
				if (name === "edit-render") editor.handleInput("x");
				checksum += editor.render(80).join("").length;
			}
		}
	};
	run();
	globalThis.gc();
	const heapBefore = process.memoryUsage().heapUsed;
	const cpuBefore = process.cpuUsage();
	const start = performance.now();
	run();
	const elapsedMs = performance.now() - start;
	const cpu = process.cpuUsage(cpuBefore);
	globalThis.gc();
	const heapAfterGcBytes = process.memoryUsage().heapUsed;
	await session.post("HeapProfiler.startSampling", {
		samplingInterval: 4096,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	run();
	const allocatedBytes = await session
		.post("HeapProfiler.stopSampling")
		.then(({ profile }) => sumProfile(profile.head as SamplingNode));
	results.push({
		name,
		iterations,
		textCodeUnits: text.length,
		pasteCodeUnits: paste.length,
		elapsedMs,
		cpuMs: (cpu.user + cpu.system) / 1000,
		allocatedBytes,
		retainedHeapBytes: heapAfterGcBytes - heapBefore,
		heapAfterGcBytes,
	});
}
session.disconnect();
console.log(JSON.stringify({ results, checksum }, null, 2));
