import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

it("width cache keys do not retain full historical backing strings", () => {
	const root = mkdtempSync(join(tmpdir(), "tui-width-cache-"));
	try {
		const script = join(root, "memory.mjs");
		writeFileSync(
			script,
			`
import { visibleWidth } from ${JSON.stringify(new URL("../src/utils.ts", import.meta.url).href)};
visibleWidth("warm 中文");
global.gc();
const before = process.memoryUsage().heapUsed;
function fill() {
 let total = 0;
 for (let i = 0; i < 128; i++) {
  const prefix = String.fromCharCode(0x4e00 + i) + "\\u0301".repeat(30);
  const source = prefix + "中".repeat(200000);
  total += visibleWidth(source.slice(0, 64));
 }
 return total;
}
const total = fill();
global.gc();
console.log(JSON.stringify({ total, retained: process.memoryUsage().heapUsed - before }));
`,
		);
		const child = spawnSync(process.execPath, ["--expose-gc", script], { encoding: "utf8" });
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout) as { total: number; retained: number };
		assert.equal(result.total, 128 * 68);
		// Short cache keys previously kept ~51 MB of unrelated source buffers alive.
		assert.ok(result.retained < 4_000_000, `retained ${result.retained} bytes for short keys`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
