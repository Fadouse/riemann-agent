import type { Usage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { formatRiemannSettingSaveStatus, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

test("reports when saved Riemann settings become active", () => {
	expect(formatRiemannSettingSaveStatus("compaction.strategy")).toBe(
		"Saved compaction.strategy; active for next compaction",
	);
	expect(formatRiemannSettingSaveStatus("agents.maxAgents")).toBe("Saved agents.maxAgents; applies to new runs");
});

describe("InteractiveMode compaction strategy warnings", () => {
	test("tracks successful strategy saves and ignores other settings", () => {
		type Strategy = "automatic" | "default" | "openai" | "snapshot";
		const state: { currentConfiguredCompactionStrategy: Strategy } = {
			currentConfiguredCompactionStrategy: "automatic",
		};
		const fakeThis = {
			showStatus: vi.fn(),
			showCompactionStrategySaveWarnings: vi.fn(),
		};
		const notify = Reflect.get(InteractiveMode.prototype, "showRiemannSettingSaveNotifications") as (
			this: typeof fakeThis,
			path: "agents.maxAgents" | "compaction.strategy",
			value: unknown,
			state: { currentConfiguredCompactionStrategy: Strategy },
		) => void;

		notify.call(fakeThis, "agents.maxAgents", 8, state);
		notify.call(fakeThis, "compaction.strategy", "default", state);
		notify.call(fakeThis, "compaction.strategy", "snapshot", state);

		expect(fakeThis.showCompactionStrategySaveWarnings.mock.calls).toEqual([
			["automatic", "default"],
			["default", "snapshot"],
		]);
		expect(state.currentConfiguredCompactionStrategy).toBe("snapshot");
		expect(fakeThis.showStatus).toHaveBeenCalledTimes(3);
	});

	test("shows every applicable warning from the current model and active branch", () => {
		type WarningModel = { provider: string; api: string; input: ("text" | "image")[] };
		const model: WarningModel = { provider: "anthropic", api: "anthropic-messages", input: ["text"] };
		const encryptedCompaction: SessionEntry = {
			type: "compaction",
			id: "compaction",
			parentId: null,
			timestamp: "2026-08-26T00:00:00.000Z",
			summary: "remote summary",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			preserveData: {
				openaiRemoteCompaction: {
					compactionItem: { type: "compaction", encrypted_content: "encrypted" },
					replacementHistory: [
						{ type: "compaction", encrypted_content: "encrypted" },
						{ type: "message", role: "user", content: [{ type: "input_text", text: "summary" }] },
					],
				},
			},
		};
		const fakeThis = {
			session: {
				model,
				modelRuntime: { isUsingOAuth: vi.fn(() => false) },
			},
			sessionManager: { getBranch: vi.fn(() => [encryptedCompaction]) },
			showWarning: vi.fn(),
		};
		const showWarnings = Reflect.get(InteractiveMode.prototype, "showCompactionStrategySaveWarnings") as (
			this: typeof fakeThis,
			previous: "automatic" | "default" | "openai" | "snapshot",
			next: "automatic" | "default" | "openai" | "snapshot",
		) => void;

		showWarnings.call(fakeThis, "openai", "snapshot");
		expect(fakeThis.showWarning.mock.calls.map(([message]) => message)).toEqual([
			expect.stringContaining("encrypted OpenAI compaction context"),
			expect.stringContaining("requires an image-capable model"),
		]);

		fakeThis.showWarning.mockClear();
		fakeThis.sessionManager.getBranch.mockReturnValue([]);
		showWarnings.call(fakeThis, "default", "openai");
		expect(fakeThis.showWarning).toHaveBeenCalledOnce();
		expect(fakeThis.showWarning).toHaveBeenCalledWith(
			expect.stringContaining("requires an active OpenAI Codex Responses model"),
		);

		fakeThis.showWarning.mockClear();
		model.provider = "openai-codex";
		model.api = "openai-codex-responses";
		model.input = ["text", "image"];
		showWarnings.call(fakeThis, "default", "openai");
		expect(fakeThis.showWarning).toHaveBeenCalledOnce();
		expect(fakeThis.showWarning).toHaveBeenCalledWith(
			expect.stringContaining("requires OpenAI Codex subscription OAuth"),
		);
	});

	test("compares effective strategies and reads OAuth without resolving auth", () => {
		const isUsingOAuth = vi.fn(() => true);
		const fakeThis = {
			session: {
				model: {
					provider: "openai-codex",
					api: "openai-codex-responses",
					input: ["text", "image"] as ("text" | "image")[],
				},
				modelRuntime: { isUsingOAuth },
			},
			sessionManager: {
				getBranch: () => [
					{
						type: "compaction" as const,
						id: "compaction",
						parentId: null,
						timestamp: "2026-08-26T00:00:00.000Z",
						summary: "remote summary",
						firstKeptEntryId: "kept",
						tokensBefore: 100,
						preserveData: {
							openaiRemoteCompaction: {
								compactionItem: { type: "compaction", encrypted_content: "encrypted" },
								replacementHistory: [
									{ type: "compaction", encrypted_content: "encrypted" },
									{
										type: "message",
										role: "user",
										content: [{ type: "input_text", text: "summary" }],
									},
								],
							},
						},
					},
				],
			},
			showWarning: vi.fn(),
		};
		const showWarnings = Reflect.get(InteractiveMode.prototype, "showCompactionStrategySaveWarnings") as (
			this: typeof fakeThis,
			previous: "automatic" | "default" | "openai" | "snapshot",
			next: "automatic" | "default" | "openai" | "snapshot",
		) => void;

		showWarnings.call(fakeThis, "automatic", "openai");

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(isUsingOAuth).toHaveBeenCalledWith("openai-codex");
	});
});

describe("InteractiveMode compaction events", () => {
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test("renders retained entries and appends the latest summary cost at the bottom", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const latestCompaction: SessionEntry = {
			type: "compaction",
			id: "latest",
			parentId: "previous",
			timestamp: "2025-01-02T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			usage,
		};
		const previousCompaction: SessionEntry = {
			type: "compaction",
			id: "previous",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			summary: "previous summary",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			usage,
		};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildContextEntries: vi.fn().mockReturnValue([latestCompaction, previousCompaction]) },
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				usage,
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousCompaction]);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
			type: "compaction_cost",
			kind: "compaction",
			usage,
		});
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [
				{
					text: "change direction",
					mode: "steer" as const,
					images: [{ type: "image" as const, data: "cG5n", mimeType: "image/png" }],
				},
			],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", {
			streamingBehavior: "steer",
			images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
		});
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
