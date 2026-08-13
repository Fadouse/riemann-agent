import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import riemannExtension from "./riemann/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "Riemann Agent", factory: riemannExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
