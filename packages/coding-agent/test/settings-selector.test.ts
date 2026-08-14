import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
			riemann: {
				limits: {
					maxAgentsPerRun: 8,
					maxConcurrentPerRun: 4,
					maxConcurrentPerModel: 2,
					maxDepth: 3,
					maxCellOutputChars: 100_000,
					maxArtifactPreviewChars: 12_000,
				},
				retention: {
					maxAgeDays: 30,
					maxArtifactBytes: 1_073_741_824,
					maxSnapshotBytes: 536_870_912,
					maxWorktreeBytes: 5_368_709_120,
				},
				compaction: { strategy: "default" },
				mainAgent: { permissions: "host" },
				agentDefaults: { workspace: "shared", permissions: "workspace" },
				modelRoles: {},
				profiles: {},
				mcpServers: {},
				web: { searchBackend: "exa" },
				files: [],
				projectOverrides: new Set(),
			},
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});

	it("uses one component to navigate all functional categories", async () => {
		const config = {
			autoCompact: true,
			showImages: true,
			imageWidthCells: 80,
			autoResizeImages: true,
			blockImages: false,
			enableSkillCommands: true,
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			transport: "auto",
			httpIdleTimeoutMs: 300_000,
			thinkingLevel: "high",
			currentTheme: "dark",
			terminalTheme: "dark",
			hideThinkingBlock: false,
			mermaidRenderingMode: "streaming",
			showCacheMissNotices: false,
			collapseChangelog: true,
			enableInstallTelemetry: false,
			doubleEscapeAction: "tree",
			treeFilterMode: "default",
			showHardwareCursor: false,
			editorPaddingX: 0,
			outputPad: 1,
			autocompleteMaxVisible: 5,
			quietStartup: false,
			defaultProjectTrust: "ask",
			clearOnShrink: true,
			showTerminalProgress: false,
			tuiMode: "regular",
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			warnings: {},
			availableThinkingLevels: [],
			availableThemes: [],
			riemann: {
				limits: {
					maxAgentsPerRun: 8,
					maxConcurrentPerRun: 4,
					maxConcurrentPerModel: 2,
					maxDepth: 3,
					maxCellOutputChars: 100_000,
					maxArtifactPreviewChars: 12_000,
				},
				retention: {
					maxAgeDays: 30,
					maxArtifactBytes: 1_073_741_824,
					maxSnapshotBytes: 536_870_912,
					maxWorktreeBytes: 5_368_709_120,
				},
				compaction: { strategy: "default" },
				mainAgent: { permissions: "host" },
				agentDefaults: { workspace: "shared", permissions: "workspace" },
				modelRoles: {},
				profiles: {},
				mcpServers: {},
				web: { searchBackend: "exa" },
				files: [],
				projectOverrides: new Set(),
			},
		} as unknown as SettingsConfig;
		const onRiemannChange = vi.fn(async () => {});
		const callbacks = { onCancel: vi.fn(), onRiemannChange } as unknown as SettingsCallbacks;
		const selector = new SettingsSelectorComponent(config, callbacks);
		for (const label of ["Interface", "Interaction", "Model", "Context", "Agents", "MCP Servers"]) {
			const rendered = selector.render(120).join("\n");
			expect(rendered).toContain(`[ ${label} ]`);
			if (label === "Agents") {
				expect(rendered).toContain("Main Agent permissions");
				expect(rendered).toContain("Subagent workspace");
				expect(rendered).toContain("Subagent permissions");
				expect(rendered).toContain("host");
				selector.handleInput("\r");
				await vi.waitFor(() =>
					expect(onRiemannChange).toHaveBeenCalledWith("agents.main.permissions", "workspace"),
				);
				selector.handleInput("\x1b[B");
				selector.handleInput("\r");
				await vi.waitFor(() =>
					expect(onRiemannChange).toHaveBeenCalledWith("agents.defaults.workspace", "worktree"),
				);
			}
			selector.handleInput("\x1b[C");
		}
		expect(selector.render(120).join("\n")).toContain("[ Interface ]");
	});
});
