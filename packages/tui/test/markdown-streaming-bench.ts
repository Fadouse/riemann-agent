import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";

// node --expose-gc packages/tui/test/markdown-streaming-bench.ts
// Add --reuse to opt into stable block reuse, --math for inline math,
// or --append --reuse for the historical backing-string reproduction.
// Complete source updates; no renderer, history or output size limits.
const theme: MarkdownTheme = {
	heading: (text) => text,
	link: (text) => text,
	linkUrl: (text) => text,
	code: (text) => text,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => text,
	quote: (text) => text,
	quoteBorder: (text) => text,
	hr: (text) => text,
	listBullet: (text) => text,
	bold: (text) => text,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: (text) => text,
};
const paragraph =
	"## Analysis\n\n性能分析 **bold** and concrete examples with words wrapping across terminal rows.\n\n```ts\nconst result = render(width);\n```\n\n" +
	(process.argv.includes("--math") ? "Inline $x^2$ formula.\n\n" : "");
interface SamplingNode {
	selfSize: number;
	children: SamplingNode[];
}
function allocation(node: SamplingNode): number {
	return node.selfSize + node.children.reduce((sum, child) => sum + allocation(child), 0);
}
const reuseStableBlocks = process.argv.includes("--reuse");
const session = new Session();
session.connect();
for (const target of process.argv.includes("--append") ? [] : [100_000, 300_000]) {
	const text = paragraph.repeat(Math.ceil(target / paragraph.length));
	const component = new Markdown(text, 1, 0, theme, undefined, { reuseStableBlocks });
	component.render(80);
	for (let frame = 0; frame < 5; frame++) {
		component.setText(`${text}stream ${frame}`);
		component.render(80);
	}
	globalThis.gc?.();
	const heapBefore = process.memoryUsage().heapUsed;
	const cpuBefore = process.cpuUsage();
	const start = performance.now();
	for (let frame = 0; frame < 30; frame++) {
		component.setText(`${text}stream ${frame}`);
		component.render(80);
	}
	const wallMs = (performance.now() - start) / 30;
	const cpu = process.cpuUsage(cpuBefore);
	await session.post("HeapProfiler.startSampling", {
		samplingInterval: 4096,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	for (let frame = 0; frame < 30; frame++) {
		component.setText(`${text}allocation ${frame}`);
		component.render(80);
	}
	const bytes = await session
		.post("HeapProfiler.stopSampling")
		.then(({ profile }) => allocation(profile.head as SamplingNode));
	globalThis.gc?.();
	const heapAfter = process.memoryUsage().heapUsed;
	console.log(
		JSON.stringify({
			chars: text.length,
			reuseStableBlocks,
			frames: 30,
			wallMs,
			cpuMs: (cpu.user + cpu.system) / 1000 / 30,
			allocatedKiB: bytes / 30 / 1024,
			heapAfterGcMiB: heapAfter / 1024 / 1024,
			retainedDeltaKiB: (heapAfter - heapBefore) / 1024,
			lines: component.render(80).length,
		}),
	);
}
session.disconnect();

if (process.argv.includes("--append")) {
	const component = new Markdown("", 0, 0, theme, undefined, { reuseStableBlocks });
	let source = "Start.\n\n";
	for (let index = 0; index < 2_000; index++) {
		source += `entry ${index} with plain text and 中文 short paragraph.\n\n`;
		component.setText(source);
		component.render(80);
		if (index === 499 || index === 999 || index === 1999) {
			globalThis.gc?.();
			console.log(
				JSON.stringify({
					entries: index + 1,
					chars: source.length,
					heapAfterGcMiB: process.memoryUsage().heapUsed / 1024 / 1024,
				}),
			);
		}
	}
}
