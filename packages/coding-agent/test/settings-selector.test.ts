import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createCompactionSettingsConfig(
	strategy: "automatic" | "default" | "openai" | "snapshot",
	projectOverrides: ReadonlySet<"compaction.strategy"> = new Set(),
): SettingsConfig {
	return {
		autoCompact: true,
		warnings: {},
		defaultModel: "not set",
		availableDefaultModels: [],
		availableThinkingLevels: [],
		modelThinkingLevels: {},
		availableThemes: [],
		riemann: {
			maxAgents: 8,
			maxConcurrentAgents: 4,
			limits: { maxCellOutputChars: 100_000, maxArtifactPreviewChars: 12_000 },
			retention: {
				maxAgeDays: 30,
				maxArtifactBytes: 1_073_741_824,
				maxSnapshotBytes: 536_870_912,
				maxWorktreeBytes: 5_368_709_120,
			},
			compaction: { strategy },
			mainAgent: {},
			agentDefaults: { workspace: "shared" },
			profiles: {},
			mcpServers: {},
			web: { searchBackend: "exa" },
			files: [],
			projectOverrides,
		},
	} as unknown as SettingsConfig;
}

describe("SettingsSelectorComponent", () => {
	let harness: Harness | undefined;
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			riemann: {
				maxAgents: 8,
				maxConcurrentAgents: 4,
				limits: {
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
				mainAgent: {},
				agentDefaults: { workspace: "shared" },
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
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
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
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = {
			...createCompactionSettingsConfig("default"),
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("    Automatic");
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = {
			...createCompactionSettingsConfig("default"),
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
			warnings: {},
		} as unknown as SettingsConfig;
		const callbacks = { onThemePreview: vi.fn(), onCancel: () => {} } as unknown as SettingsCallbacks;
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("keeps the configured per-model thinking level marked while browsing", async () => {
		harness = await createHarness({
			models: [{ id: "thinking-model", reasoning: true }],
		});
		const model = harness.getModel("thinking-model")!;
		const modelKey = `${model.provider}/${model.id}`;
		const config = {
			...createCompactionSettingsConfig("default"),
			defaultModel: modelKey,
			availableDefaultModels: [model],
			thinkingLevel: "high",
			modelThinkingLevels: { [modelKey]: "medium" },
		} as unknown as SettingsConfig;
		const callbacks = { onCancel: () => {} } as unknown as SettingsCallbacks;
		const selector = new SettingsSelectorComponent(config, callbacks);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[C");
		const list = selector.getSettingsList();

		list.selectItem("model-thinking");
		list.handleInput("\r");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ medium");
		expect(output).toContain("    (clear override)");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ medium");
		expect(output).toContain("→   high");
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
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
			availableAgentModels: ["openai/worker"],
			riemann: {
				maxAgents: 8,
				maxConcurrentAgents: 4,
				limits: {
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
				mainAgent: {},
				agentDefaults: { workspace: "shared" },
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
			if (label === "Context") {
				expect(rendered).toContain("Compaction strategy");
			}
			if (label === "Agents") {
				expect(rendered).toContain("Agent slots");
				expect(rendered).toContain("Default Agent model");
				expect(rendered).not.toContain("Main Agent permissions");
				expect(rendered).not.toContain("Subagent workspace");
				expect(rendered).not.toContain("Subagent permissions");
				selector.handleInput("\r");
				await vi.waitFor(() => expect(onRiemannChange).toHaveBeenCalledWith("agents.maxAgents", 16));
				selector.handleInput("\x1b[B");
				selector.handleInput("\r");
				await vi.waitFor(() =>
					expect(onRiemannChange).toHaveBeenCalledWith("agents.defaults.model", "openai/worker"),
				);
			}
			selector.handleInput("\x1b[C");
		}
		expect(selector.render(120).join("\n")).toContain("[ Interface ]");
	});

	it("shows and persists all configured compaction strategies", async () => {
		const config = createCompactionSettingsConfig("automatic");
		const onRiemannChange = vi.fn(async () => {});
		const selector = new SettingsSelectorComponent(config, {
			onCancel: vi.fn(),
			onError: vi.fn(),
			onRiemannChange,
		} as unknown as SettingsCallbacks);
		for (let index = 0; index < 3; index += 1) selector.handleInput("\x1b[C");
		const list = selector.getSettingsList();
		list.selectItem("compaction.strategy");

		expect(selector.render(120).join("\n")).toContain("Automatic");
		expect(selector.render(120).join("\n")).toContain("OpenAI Codex models");
		expect(selector.render(120).join("\n")).toContain("advanced image archive");
		for (const [label, literal] of [
			["Default", "default"],
			["OpenAI Codex", "openai"],
			["Snapshot", "snapshot"],
			["Automatic", "automatic"],
		] as const) {
			list.handleInput("\r");
			expect(selector.render(120).join("\n")).toContain(label);
			await vi.waitFor(() => expect(onRiemannChange).toHaveBeenLastCalledWith("compaction.strategy", literal));
		}
	});

	it("commits successful Riemann saves and rolls failed saves back", async () => {
		let rejectSave: ((error: Error) => void) | undefined;
		const failedSave = new Promise<void>((_resolve, reject) => {
			rejectSave = reject;
		});
		const onRiemannChange = vi
			.fn<(path: string, value: unknown) => Promise<void>>()
			.mockResolvedValueOnce()
			.mockReturnValueOnce(failedSave);
		const onError = vi.fn();
		const selector = new SettingsSelectorComponent(createCompactionSettingsConfig("automatic"), {
			onCancel: vi.fn(),
			onError,
			onRiemannChange,
		} as unknown as SettingsCallbacks);
		for (let index = 0; index < 3; index += 1) selector.handleInput("\x1b[C");
		let list = selector.getSettingsList();
		list.selectItem("compaction.strategy");

		list.handleInput("\r");
		await vi.waitFor(() => expect(onRiemannChange).toHaveBeenCalledWith("compaction.strategy", "default"));
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[D");
		list = selector.getSettingsList();
		list.selectItem("compaction.strategy");
		expect(selector.render(120).join("\n")).toContain("Default");

		list.handleInput("\r");
		expect(selector.render(120).join("\n")).toContain("OpenAI Codex");
		rejectSave?.(new Error("disk full"));
		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("disk full"));
		expect(selector.render(120).join("\n")).toContain("Default");
	});

	it("keeps trusted project compaction overrides read-only", () => {
		const onRiemannChange = vi.fn(async () => {});
		const selector = new SettingsSelectorComponent(
			createCompactionSettingsConfig("snapshot", new Set(["compaction.strategy"])),
			{
				onCancel: vi.fn(),
				onError: vi.fn(),
				onRiemannChange,
			} as unknown as SettingsCallbacks,
		);
		for (let index = 0; index < 3; index += 1) selector.handleInput("\x1b[C");
		const list = selector.getSettingsList();
		list.selectItem("compaction.strategy");

		expect(selector.render(120).join("\n")).toContain("Snapshot · project");
		list.handleInput("\r");
		expect(onRiemannChange).not.toHaveBeenCalled();
	});
});
