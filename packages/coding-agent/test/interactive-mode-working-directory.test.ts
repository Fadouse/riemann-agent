import { describe, expect, test, vi } from "vitest";

const editInExternalEditorMock = vi.hoisted(() => vi.fn(async () => ({ status: "cancelled" as const })));

vi.mock("../src/modes/interactive/external-editor.ts", () => ({
	editInExternalEditor: editInExternalEditorMock,
}));

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type WorkingDirectoryUi = {
	setWorkingDirectory: (cwd: string) => void;
	start: () => void;
};

type StartInteractiveTuiContext = {
	ui: WorkingDirectoryUi;
	sessionManager: { getCwd: () => string };
};

type ApplyRuntimeSettingsContext = {
	activeStatusIndicator: undefined;
	applyFullscreenScrollbarSetting: () => void;
	defaultEditor: {
		setAutocompleteMaxVisible: (maxVisible: number) => void;
		setPaddingX: (padding: number) => void;
	};
	editor: ApplyRuntimeSettingsContext["defaultEditor"];
	footer: {
		setAutoCompactEnabled: (enabled: boolean) => void;
		setSession: (session: ApplyRuntimeSettingsContext["session"]) => void;
	};
	footerDataProvider: { setCwd: (cwd: string) => void };
	hideThinkingBlock: boolean;
	outputPad: number;
	session: { autoCompactionEnabled: boolean };
	sessionManager: { getCwd: () => string };
	settingsManager: {
		getAutocompleteMaxVisible: () => number;
		getClearOnShrink: () => boolean;
		getEditorPaddingX: () => number;
		getHideThinkingBlock: () => boolean;
		getHttpIdleTimeoutMs: () => number;
		getOutputPad: () => number;
		getShowHardwareCursor: () => boolean;
		getTerminalCapabilityOverrides: () => Record<string, never>;
	};
	statusContainer: { clear: () => void };
	ui: WorkingDirectoryUi & {
		getClearOnShrink: () => boolean;
		setClearOnShrink: (enabled: boolean) => void;
		setShowHardwareCursor: (enabled: boolean) => void;
	};
};

type ExternalEditorContext = {
	editor: {
		getText: () => string;
		setText: (text: string) => void;
	};
	settingsManager: { getExternalEditorCommand: () => string | undefined };
	startInteractiveTui: () => void;
	ui: {
		requestRender: (force?: boolean) => void;
		stop: () => void;
	};
};

type InteractiveModePrivate = {
	applyRuntimeSettings(this: ApplyRuntimeSettingsContext): void;
	handleOpenExternalEditor(this: ExternalEditorContext): Promise<void>;
	startInteractiveTui(this: StartInteractiveTuiContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

describe("InteractiveMode working directory", () => {
	test("sets the active session cwd before starting the TUI", () => {
		const calls: string[] = [];
		const context: StartInteractiveTuiContext = {
			ui: {
				setWorkingDirectory: (cwd) => calls.push(`cwd:${cwd}`),
				start: () => calls.push("start"),
			},
			sessionManager: { getCwd: () => "/workspace/initial" },
		};

		interactiveModePrototype.startInteractiveTui.call(context);

		expect(calls).toEqual(["cwd:/workspace/initial", "start"]);
	});

	test("updates the TUI cwd when runtime settings are rebound", () => {
		const defaultEditor = {
			setAutocompleteMaxVisible: vi.fn(),
			setPaddingX: vi.fn(),
		};
		const context: ApplyRuntimeSettingsContext = {
			activeStatusIndicator: undefined,
			applyFullscreenScrollbarSetting: vi.fn(),
			defaultEditor,
			editor: defaultEditor,
			footer: {
				setAutoCompactEnabled: vi.fn(),
				setSession: vi.fn(),
			},
			footerDataProvider: { setCwd: vi.fn() },
			hideThinkingBlock: false,
			outputPad: 1,
			session: { autoCompactionEnabled: true },
			sessionManager: { getCwd: () => "/workspace/rebound" },
			settingsManager: {
				getAutocompleteMaxVisible: () => 8,
				getClearOnShrink: () => false,
				getEditorPaddingX: () => 1,
				getHideThinkingBlock: () => false,
				getHttpIdleTimeoutMs: () => 30_000,
				getOutputPad: () => 1,
				getShowHardwareCursor: () => false,
				getTerminalCapabilityOverrides: () => ({}),
			},
			statusContainer: { clear: vi.fn() },
			ui: {
				getClearOnShrink: () => false,
				setClearOnShrink: vi.fn(),
				setShowHardwareCursor: vi.fn(),
				setWorkingDirectory: vi.fn(),
				start: vi.fn(),
			},
		};

		interactiveModePrototype.applyRuntimeSettings.call(context);

		expect(context.ui.setWorkingDirectory).toHaveBeenCalledWith("/workspace/rebound");
	});

	test("restarts the TUI after returning from an external editor", async () => {
		const calls: string[] = [];
		const context: ExternalEditorContext = {
			editor: {
				getText: () => "draft",
				setText: vi.fn(),
			},
			settingsManager: { getExternalEditorCommand: () => undefined },
			startInteractiveTui: () => calls.push("start"),
			ui: {
				requestRender: vi.fn(),
				stop: () => calls.push("stop"),
			},
		};

		await interactiveModePrototype.handleOpenExternalEditor.call(context);

		expect(editInExternalEditorMock).toHaveBeenCalledWith({ command: undefined, content: "draft" });
		expect(calls).toEqual(["stop", "start"]);
		expect(context.ui.requestRender).toHaveBeenCalledWith(true);
	});
});
