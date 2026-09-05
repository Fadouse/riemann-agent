import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.ts";
import {
	refreshToolMarkers,
	requestToolStatusFrame,
	runningToolMarker,
} from "../src/modes/interactive/components/tool-status-marker.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	initTheme("dark");
});

describe("tool marker color animation", () => {
	test("updates only marked prefixes and leaves clipped rows and tool output alone", () => {
		initTheme("dark");
		const first = runningToolMarker(0);
		const next = runningToolMarker(960);
		const lines = [` ${first} python`, " ", `output: ${first} must stay unchanged`];
		const updated = refreshToolMarkers(lines, [0, 1], first, next);
		expect(updated).toEqual([` ${next} python`, lines[1], lines[2]]);
		expect(lines[0]).toBe(` ${first} python`);
		expect(refreshToolMarkers(updated, [0], next, next)).toBe(updated);
	});

	test("coalesces concurrent tools into one bounded frame request per TUI", async () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const ui = { requestRender } as unknown as TUI;
		for (let i = 0; i < 100; i++) requestToolStatusFrame(ui);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(80);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	test("color-only frames do not split large expanded source or output again", () => {
		initTheme("dark");
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const component = new IPythonCellComponent({
			code: "await work()",
			content: [{ type: "text", text: "unchanged output\n".repeat(10_000) }],
			details: { status: "running" },
			isPartial: true,
			executionStarted: true,
			expanded: true,
		});
		const first = component.render(80);
		const split = vi.spyOn(String.prototype, "split");
		for (let frame = 1; frame < 25; frame++) {
			now.mockReturnValue(frame * 80);
			const lines = component.render(80);
			expect(lines.length).toBe(first.length);
			expect(lines.at(-1)).toBe(first.at(-1));
		}
		expect(split).not.toHaveBeenCalled();
	});
});
