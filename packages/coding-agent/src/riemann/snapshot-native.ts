import { createRequire } from "node:module";
import type { SnapcompactRenderOptions } from "@oh-my-pi/pi-natives";

interface SnapshotNativeBindings {
	renderSnapcompactPng(text: string, options: SnapcompactRenderOptions): Promise<string>;
	snapcompactSupportedChars(font: string, chars: string): string;
}

const packageByTarget: Record<string, string> = {
	"linux-x64": "@oh-my-pi/pi-natives-linux-x64",
	"linux-arm64": "@oh-my-pi/pi-natives-linux-arm64",
	"darwin-x64": "@oh-my-pi/pi-natives-darwin-x64",
	"darwin-arm64": "@oh-my-pi/pi-natives-darwin-arm64",
	"win32-x64": "@oh-my-pi/pi-natives-win32-x64",
};

let bindings: SnapshotNativeBindings | undefined;

function loadBindings(): SnapshotNativeBindings {
	if (bindings) return bindings;
	const target = `${process.platform}-${process.arch}`;
	const packageName = packageByTarget[target];
	if (!packageName) throw new Error(`Snapshot compaction is unsupported on ${target}`);
	bindings = createRequire(import.meta.url)(packageName) as SnapshotNativeBindings;
	return bindings;
}

export function renderSnapshotPng(text: string, options: SnapcompactRenderOptions): Promise<string> {
	return loadBindings().renderSnapcompactPng(text, options);
}

export function snapshotSupportedChars(font: string, chars: string): string {
	return loadBindings().snapcompactSupportedChars(font, chars);
}
