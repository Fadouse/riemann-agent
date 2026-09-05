import type { TUI } from "@earendil-works/pi-tui";
import { type Theme, theme } from "../theme/theme.ts";

export const TOOL_STATUS_FRAME_MS = 80;
const PERIOD_MS = 2_000;
const FRAME_COUNT = PERIOD_MS / TOOL_STATUS_FRAME_MS;
const palettes = new WeakMap<Theme, { dim: string; text: string; mode: string; frames: string[] }>();
const pendingFrames = new WeakMap<TUI, NodeJS.Timeout>();

/** Codex's two-second cosine sweep, adapted to the current theme's neutral colors.
 * https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/shimmer.rs
 * Only the foreground changes; even the limited-color fallback keeps the same glyph.
 */
export function runningToolMarker(now = Date.now()): string {
	const dim = theme.getFgAnsi("dim");
	const text = theme.getFgAnsi("text");
	const mode = theme.getColorMode();
	let palette = palettes.get(theme);
	if (!palette || palette.dim !== dim || palette.text !== text || palette.mode !== mode) {
		const low = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(dim)?.slice(1).map(Number);
		const high = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(text)?.slice(1).map(Number);
		const frames = Array.from({ length: FRAME_COUNT }, (_, frame) => {
			const distance = Math.abs(10 - Math.floor((frame / FRAME_COUNT) * 21));
			const intensity = distance <= 5 ? 0.5 * (1 + Math.cos((Math.PI * distance) / 5)) : 0;
			if (mode === "truecolor" && low && high) {
				const rgb = low.map((channel, index) =>
					Math.round(channel + ((high[index] ?? channel) - channel) * intensity),
				);
				return `\x1b[38;2;${rgb.join(";")}m●\x1b[39m`;
			}
			return theme.fg(intensity < 0.2 ? "dim" : intensity < 0.6 ? "muted" : "text", "●");
		});
		palette = { dim, text, mode, frames };
		palettes.set(theme, palette);
	}
	return palette.frames[Math.floor((((now % PERIOD_MS) + PERIOD_MS) % PERIOD_MS) / TOOL_STATUS_FRAME_MS)]!;
}

/** Update only renderer-owned marker prefixes, never tool output or syntax highlighting. */
export function refreshToolMarkers(lines: string[], rows: readonly number[], previous: string, next: string): string[] {
	if (previous === next || rows.length === 0) return lines;
	let updated = lines;
	// Truncation can rewrite the trailing foreground reset to a full SGR reset.
	// Keep that reset intact and replace only the color plus the visible dot.
	const prefix = ` ${previous.slice(0, -"\x1b[39m".length)}`;
	const replacement = ` ${next.slice(0, -"\x1b[39m".length)}`;
	for (const row of rows) {
		const line = lines[row];
		// A narrow viewport may have clipped the marker entirely.
		if (!line?.startsWith(prefix)) continue;
		if (updated === lines) updated = lines.slice();
		updated[row] = replacement + line.slice(prefix.length);
	}
	return updated;
}

/** One outstanding frame per TUI, renewed only by rendered, running tools.
 * Removed/hidden tools cannot retain a periodic timer; the final pending frame expires once.
 */
export function requestToolStatusFrame(ui: TUI): void {
	if (pendingFrames.has(ui)) return;
	const timer = setTimeout(() => {
		pendingFrames.delete(ui);
		ui.requestRender();
	}, TOOL_STATUS_FRAME_MS);
	timer.unref?.();
	pendingFrames.set(ui, timer);
}
