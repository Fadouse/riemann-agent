import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	getCapabilities,
	getKeybindings,
	Input,
	type ScrollViewScrollbar,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type {
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	TuiMode,
	WarningSettings,
} from "../../../core/settings-manager.ts";
import type { RiemannConfig, RiemannSettingPath } from "../../../riemann/config.ts";
import {
	getSelectListTheme,
	getSettingsListTheme,
	parseAutoThemeSetting,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	warnings: WarningSettings;
	riemann: RiemannConfig;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onTuiModeChange: (mode: TuiMode) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onRiemannChange: (path: RiemannSettingPath, value: unknown) => Promise<void>;
	onError: (message: string) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

function themeItems(availableThemes: string[]): SelectItem[] {
	return availableThemes.map((name) => ({ value: name, label: name }));
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[]): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(availableThemes),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private readonly callbacks: SettingsCallbacks;
	private inputComponent: Component | undefined;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose Automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

const SETTINGS_CATEGORIES = ["Interface", "Interaction", "Model", "Context", "Agents", "MCP Servers"] as const;
type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

const GENERAL_SETTING_CATEGORIES: Record<Exclude<SettingsCategory, "Agents" | "MCP Servers">, readonly string[]> = {
	Interface: [
		"theme",
		"tui-mode",
		"fullscreen-exit-output",
		"fullscreen-scrollbar",
		"show-images",
		"image-width-cells",
		"auto-resize-images",
		"block-images",
		"mermaid-rendering",
		"hide-thinking",
		"show-hardware-cursor",
		"editor-padding",
		"output-padding",
		"autocomplete-max-visible",
		"clear-on-shrink",
		"terminal-progress",
	],
	Interaction: [
		"steering-mode",
		"follow-up-mode",
		"skill-commands",
		"default-project-trust",
		"double-escape-action",
		"tree-filter-mode",
		"warnings",
		"collapse-changelog",
		"quiet-startup",
		"install-telemetry",
	],
	Model: ["transport", "http-idle-timeout", "thinking"],
	Context: ["autocompact", "cache-miss-notices"],
};

const RIEMANN_NUMBER_CHOICES = {
	"limits.maxAgentsPerRun": [1, 2, 4, 8, 16, 32, 64],
	"limits.maxConcurrentPerRun": [1, 2, 4, 8, 16, 32],
	"limits.maxConcurrentPerModel": [1, 2, 4, 8, 16],
	"limits.maxDepth": [0, 1, 2, 3, 4, 6, 8],
	"limits.maxCellOutputChars": [10_000, 25_000, 50_000, 100_000, 250_000, 500_000],
	"limits.maxArtifactPreviewChars": [1_000, 4_000, 8_000, 12_000, 20_000, 50_000],
	"retention.maxAgeDays": [0, 7, 14, 30, 60, 90, 180, 365],
	"retention.maxArtifactBytes": [0, 268_435_456, 536_870_912, 1_073_741_824, 2_147_483_648, 5_368_709_120],
	"retention.maxSnapshotBytes": [0, 134_217_728, 268_435_456, 536_870_912, 1_073_741_824, 2_147_483_648],
	"retention.maxWorktreeBytes": [0, 1_073_741_824, 2_147_483_648, 5_368_709_120, 10_737_418_240],
} as const;

function bytesLabel(bytes: number): string {
	if (bytes === 0) return "unlimited";
	if (bytes >= 1_073_741_824) return `${bytes / 1_073_741_824} GiB`;
	return `${bytes / 1_048_576} MiB`;
}

function parseRiemannValue(path: string, display: string): unknown {
	if (path.endsWith(".enabled") || path.endsWith(".exposeToModel")) return display === "true";
	if (path.endsWith("TimeoutMs")) return Number.parseInt(display, 10);
	if (path === "compaction.strategy" || path.startsWith("agents.")) return display;
	if (display === "unlimited") return 0;
	if (display.endsWith(" days")) return Number.parseInt(display, 10);
	if (display.endsWith(" GiB")) return Number.parseFloat(display) * 1_073_741_824;
	if (display.endsWith(" MiB")) return Number.parseFloat(display) * 1_048_576;
	if (display.endsWith("K chars")) return Number.parseFloat(display) * 1_000;
	return Number.parseFloat(display);
}

function rNumberItem(
	config: RiemannConfig,
	path: keyof typeof RIEMANN_NUMBER_CHOICES,
	label: string,
	value: number,
	format: (value: number) => string = String,
): SettingItem {
	const project = config.projectOverrides.has(path);
	return {
		id: path,
		label,
		description: project
			? "Read-only because the trusted project config overrides this value."
			: "Applies to new runs.",
		currentValue: project ? `${format(value)} · project` : format(value),
		values: project ? undefined : RIEMANN_NUMBER_CHOICES[path].map(format),
	};
}

function agentSettingItems(config: RiemannConfig): SettingItem[] {
	const projectCompaction = config.projectOverrides.has("compaction.strategy");
	const projectMainPermissions = config.projectOverrides.has("agents.main.permissions");
	const projectDefaultWorkspace = config.projectOverrides.has("agents.defaults.workspace");
	const projectDefaultPermissions = config.projectOverrides.has("agents.defaults.permissions");
	return [
		{
			id: "agents.main.permissions",
			label: "Main Agent permissions",
			description: projectMainPermissions
				? "Read-only because the trusted project config overrides this value."
				: "Host allows host filesystem access; workspace confines IPython and shell to the project workspace.",
			currentValue: projectMainPermissions
				? `${config.mainAgent.permissions} · project`
				: config.mainAgent.permissions,
			values: projectMainPermissions ? undefined : ["host", "workspace"],
		},
		{
			id: "agents.defaults.workspace",
			label: "Subagent workspace",
			description: projectDefaultWorkspace
				? "Read-only because the trusted project config overrides this value."
				: "Shared uses the parent workspace; worktree creates an independent detached Git worktree.",
			currentValue: projectDefaultWorkspace
				? `${config.agentDefaults.workspace} · project`
				: config.agentDefaults.workspace,
			values: projectDefaultWorkspace ? undefined : ["shared", "worktree"],
		},
		{
			id: "agents.defaults.permissions",
			label: "Subagent permissions",
			description: projectDefaultPermissions
				? "Read-only because the trusted project config overrides this value."
				: "Default filesystem scope for Subagents; a child cannot exceed its parent permissions.",
			currentValue: projectDefaultPermissions
				? `${config.agentDefaults.permissions} · project`
				: config.agentDefaults.permissions,
			values: projectDefaultPermissions ? undefined : ["host", "workspace"],
		},
		{
			id: "compaction.strategy",
			label: "Compaction strategy",
			description: projectCompaction
				? "Read-only because the trusted project config overrides this value."
				: "Context compaction implementation; applies to new runs.",
			currentValue: projectCompaction ? `${config.compaction.strategy} · project` : config.compaction.strategy,
			values: projectCompaction ? undefined : ["default", "snapshot", "openai"],
		},
		rNumberItem(config, "limits.maxAgentsPerRun", "Agents per run", config.limits.maxAgentsPerRun),
		rNumberItem(config, "limits.maxConcurrentPerRun", "Concurrent agents", config.limits.maxConcurrentPerRun),
		rNumberItem(config, "limits.maxConcurrentPerModel", "Concurrent per model", config.limits.maxConcurrentPerModel),
		rNumberItem(config, "limits.maxDepth", "Subagent depth", config.limits.maxDepth),
		rNumberItem(
			config,
			"limits.maxCellOutputChars",
			"Cell output limit",
			config.limits.maxCellOutputChars,
			(value) => `${value / 1_000}K chars`,
		),
		rNumberItem(
			config,
			"limits.maxArtifactPreviewChars",
			"Artifact preview",
			config.limits.maxArtifactPreviewChars,
			(value) => `${value / 1_000}K chars`,
		),
		rNumberItem(config, "retention.maxAgeDays", "Run retention", config.retention.maxAgeDays, (value) =>
			value === 0 ? "unlimited" : `${value} days`,
		),
		rNumberItem(
			config,
			"retention.maxArtifactBytes",
			"Artifact budget",
			config.retention.maxArtifactBytes,
			bytesLabel,
		),
		rNumberItem(
			config,
			"retention.maxSnapshotBytes",
			"Snapshot budget",
			config.retention.maxSnapshotBytes,
			bytesLabel,
		),
		rNumberItem(
			config,
			"retention.maxWorktreeBytes",
			"Worktree budget",
			config.retention.maxWorktreeBytes,
			bytesLabel,
		),
		...Object.entries(config.profiles).map(([name, profile]) => ({
			id: `profile.${name}`,
			label: `Profile: ${name}`,
			description: `${profile.description ?? "Configured agent profile."} Definition is read-only.`,
			currentValue: `${profile.workspace ?? config.agentDefaults.workspace} · ${profile.permissions ?? config.agentDefaults.permissions}`,
		})),
	];
}

class ToolFilterEditor extends Container {
	private readonly input = new Input();
	constructor(title: string, value: string, done: (value?: string) => void) {
		super();
		this.input.setValue(value);
		this.input.onSubmit = (next) => done(next);
		this.input.onEscape = () => done();
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Comma-separated tool names; use 'all' to clear."), 1, 0));
		this.addChild(this.input);
		this.addChild(new Text(theme.fg("dim", "Enter save · Esc cancel"), 1, 0));
	}
	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

function mcpSettingItems(config: RiemannConfig): SettingItem[] {
	return Object.entries(config.mcpServers).flatMap(([name, server]) => {
		const prefix = `mcp.servers.${name}`;
		const editable = (field: string) => !config.projectOverrides.has(`${prefix}.${field}` as RiemannSettingPath);
		const display = (field: string, value: string) => (editable(field) ? value : `${value} · project`);
		const tools = (value: string[] | undefined) => (value?.length ? value.join(",") : "all");
		const transport =
			server.url ?? (server.command ? `${server.command} ${(server.args ?? []).join(" ")}`.trim() : "invalid");
		return [
			{
				id: `server.${name}`,
				label: `Server: ${name}`,
				description: `Connection is read-only. ${server.description ?? ""}`,
				currentValue: transport,
			},
			{
				id: `${prefix}.enabled`,
				label: `${name}: enabled`,
				description: "Applies to new runs.",
				currentValue: display("enabled", server.enabled === false ? "false" : "true"),
				values: editable("enabled") ? ["true", "false"] : undefined,
			},
			{
				id: `${prefix}.exposeToModel`,
				label: `${name}: model-visible`,
				description: "Applies to new runs.",
				currentValue: display("exposeToModel", server.exposeToModel === false ? "false" : "true"),
				values: editable("exposeToModel") ? ["true", "false"] : undefined,
			},
			{
				id: `${prefix}.startupTimeoutMs`,
				label: `${name}: startup timeout`,
				description: "Applies to new runs.",
				currentValue: display("startupTimeoutMs", `${server.startupTimeoutMs ?? 10_000} ms`),
				values: editable("startupTimeoutMs")
					? ["1000 ms", "5000 ms", "10000 ms", "30000 ms", "60000 ms"]
					: undefined,
			},
			{
				id: `${prefix}.toolTimeoutMs`,
				label: `${name}: tool timeout`,
				description: "Applies to new runs.",
				currentValue: display("toolTimeoutMs", `${server.toolTimeoutMs ?? 120_000} ms`),
				values: editable("toolTimeoutMs")
					? ["10000 ms", "30000 ms", "60000 ms", "120000 ms", "300000 ms"]
					: undefined,
			},
			{
				id: `${prefix}.enabledTools`,
				label: `${name}: enabled tools`,
				description: "Comma-separated allowlist; 'all' clears it.",
				currentValue: display("enabledTools", tools(server.enabledTools)),
				submenu: editable("enabledTools")
					? (value, done) => new ToolFilterEditor(`${name}: enabled tools`, value, done)
					: undefined,
			},
			{
				id: `${prefix}.disabledTools`,
				label: `${name}: disabled tools`,
				description: "Comma-separated denylist; 'all' clears it.",
				currentValue: display("disabledTools", tools(server.disabledTools)),
				submenu: editable("disabledTools")
					? (value, done) => new ToolFilterEditor(`${name}: disabled tools`, value, done)
					: undefined,
			},
		];
	});
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;
	private readonly items: SettingItem[];
	private readonly config: SettingsConfig;
	private categoryIndex = 0;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();
		this.config = config;

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		let currentWarnings = { ...config.warnings };

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid diagrams",
				description: "Render Mermaid code blocks as Unicode diagrams",
				currentValue: config.mermaidRenderingMode,
				values: ["off", "final", "streaming"],
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				description: "Show transcript notices for significant prompt-cache misses",
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "install-telemetry",
				label: "Install telemetry",
				description: "Send an anonymous version/update ping after changelog-detected updates",
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "default-project-trust",
				label: "Default project trust",
				description: "Fallback behavior when no extension or saved trust decision decides project trust",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "warnings",
				label: "Warnings",
				description: "Enable or disable individual warnings",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			{
				id: "thinking",
				label: "Thinking level",
				description: "Reasoning depth for thinking-capable models",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"Select reasoning depth for thinking-capable models",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "tui-mode",
				label: "TUI mode",
				description: "Interface layout; fullscreen mode is experimental",
				currentValue: config.tuiMode,
				values: ["regular", "fullscreen"],
			},
			{
				id: "fullscreen-exit-output",
				label: "Fullscreen exit output",
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
				currentValue: config.fullscreenExitOutput,
				values: ["transcript", "resume-hint"],
			},
			{
				id: "fullscreen-scrollbar",
				label: "Fullscreen scrollbar",
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
				currentValue: config.fullscreenScrollbar,
				values: ["auto", "always", "hidden"],
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
		];

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: "Image width",
				description: "Preferred inline image width in terminal cells",
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Output padding toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "output-padding",
			label: "Output padding",
			description: "Horizontal padding for user messages, assistant messages, and thinking",
			currentValue: String(config.outputPad),
			values: ["0", "1"],
		});

		// Autocomplete max visible toggle (insert after output-padding)
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		items.splice(outputPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "Terminal progress",
			description: "Show OSC 9;4 progress indicators in the terminal tab bar",
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
		});

		this.items = items;

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "mermaid-rendering":
						callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(newValue === "true");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "install-telemetry":
						callbacks.onEnableInstallTelemetryChange(newValue === "true");
						break;
					case "default-project-trust": {
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
					case "tui-mode":
						callbacks.onTuiModeChange(newValue as TuiMode);
						break;
					case "fullscreen-exit-output":
						callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
						break;
					case "fullscreen-scrollbar":
						callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
					default:
						if (id.startsWith("profile.") || id.startsWith("server.")) break;
						if (id.endsWith("enabledTools") || id.endsWith("disabledTools")) {
							const value =
								newValue === "all"
									? []
									: newValue
											.split(",")
											.map((entry) => entry.trim())
											.filter(Boolean);
							void callbacks
								.onRiemannChange(id as RiemannSettingPath, value)
								.catch((error) => callbacks.onError(error instanceof Error ? error.message : String(error)));
							break;
						}
						void callbacks
							.onRiemannChange(id as RiemannSettingPath, parseRiemannValue(id, newValue))
							.catch((error) => callbacks.onError(error instanceof Error ? error.message : String(error)));
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.applyCategory();
		this.rebuild();
	}

	private currentCategory(): SettingsCategory {
		return SETTINGS_CATEGORIES[this.categoryIndex];
	}

	private applyCategory(): void {
		const category = this.currentCategory();
		if (category === "Agents") {
			this.settingsList.setItems(agentSettingItems(this.config.riemann));
			return;
		}
		if (category === "MCP Servers") {
			this.settingsList.setItems(mcpSettingItems(this.config.riemann));
			return;
		}
		this.settingsList.setItems(this.items.filter((item) => GENERAL_SETTING_CATEGORIES[category].includes(item.id)));
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(`${theme.bold("Settings")}  ${this.renderCategories()}`, 1, 0));
		this.addChild(this.settingsList);
		this.addChild(new Text(theme.fg("dim", "  ←/→ category"), 1, 0));
		this.addChild(new DynamicBorder());
	}

	private renderCategories(): string {
		return SETTINGS_CATEGORIES.map((category, index) =>
			index === this.categoryIndex ? theme.fg("accent", `[ ${category} ]`) : theme.fg("muted", `  ${category}  `),
		).join(" ");
	}

	handleInput(data: string): void {
		if (!this.settingsList.hasOpenSubmenu()) {
			const keybindings = getKeybindings();
			const queryActive = this.settingsList.getFilterQuery().length > 0;
			if (!queryActive && keybindings.matches(data, "tui.editor.cursorLeft")) {
				this.categoryIndex = (this.categoryIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
				this.applyCategory();
				this.rebuild();
				return;
			}
			if (!queryActive && keybindings.matches(data, "tui.editor.cursorRight")) {
				this.categoryIndex = (this.categoryIndex + 1) % SETTINGS_CATEGORIES.length;
				this.applyCategory();
				this.rebuild();
				return;
			}
		}
		this.settingsList.handleInput(data);
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
