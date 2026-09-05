/** Run from packages/tui: node --expose-gc test/editor-undo-bench.ts */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

if (!globalThis.gc) throw new Error("Run with --expose-gc");
const paste = "x".repeat(1024 * 1024);
const snapshots = 64;
const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
const marker = editor.getText();
const states = [marker];
const session = new Session();
session.connect();
interface SamplingNode {
	selfSize: number;
	children: SamplingNode[];
}
function sumProfile(node: SamplingNode): number {
	let bytes = node.selfSize;
	for (const child of node.children) bytes += sumProfile(child);
	return bytes;
}
globalThis.gc();
const heapBefore = process.memoryUsage().heapUsed;
await session.post("HeapProfiler.startSampling", {
	samplingInterval: 4096,
	includeObjectsCollectedByMajorGC: true,
	includeObjectsCollectedByMinorGC: true,
});
const cpuBefore = process.cpuUsage();
const start = performance.now();
for (let i = 0; i < snapshots; i++) {
	editor.insertTextAtCursor(` ${i}`);
	states.push(editor.getText());
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuBefore);
const allocatedBytes = await session
	.post("HeapProfiler.stopSampling")
	.then(({ profile }) => sumProfile(profile.head as SamplingNode));
globalThis.gc();
const heapAfterGcBytes = process.memoryUsage().heapUsed;
for (let i = snapshots - 1; i >= 0; i--) {
	editor.handleInput("\x1f");
	assert.equal(editor.getText(), states[i]);
	assert.equal(editor.getExpandedText(), paste + states[i].slice(marker.length));
}
editor.handleInput("\x1f");
assert.equal(editor.getText(), "");
globalThis.gc();
const heapAfterUndoBytes = process.memoryUsage().heapUsed;
session.disconnect();
console.log(
	JSON.stringify(
		{
			pasteBytes: Buffer.byteLength(paste),
			snapshots,
			elapsedMs,
			cpuMs: (cpu.user + cpu.system) / 1000,
			allocatedBytes,
			retainedHeapBytes: heapAfterGcBytes - heapBefore,
			heapAfterGcBytes,
			heapAfterUndoBytes,
		},
		null,
		2,
	),
);
