import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { exportFromFile, exportSessionToHtml } from "../src/core/export-html/index.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SubagentConversationViewer } from "../src/extensions/riemann/subagent-view.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import type { SubagentUiSnapshot } from "../src/riemann/agents/supervisor.ts";
import type { RiemannRuntime } from "../src/riemann/runtime.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { isModelOnlyToolCall, ModelOnlyToolPresentation } from "../src/utils/model-only-tools.ts";

const calls: ToolCall[] = [
	{
		type: "toolCall",
		id: "history",
		namespace: "history",
		name: "search_contents",
		arguments: { query: "SECRET" },
		encryptedFunctionArgs: ["query"],
	},
	{ type: "toolCall", id: "notes", namespace: "notes", name: "write_file", arguments: { text: "SECRET" } },
	{ type: "toolCall", id: "reset", name: "new_context", arguments: {} },
	{ type: "toolCall", id: "budget", name: "get_context_remaining", arguments: {} },
];
const assistant: AssistantMessage = {
	role: "assistant",
	provider: "openai-codex",
	api: "openai-codex-responses",
	model: "gpt-test",
	content: [{ type: "text", text: "Public answer" }, ...calls],
	stopReason: "toolUse",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const results: ToolResultMessage[] = calls.map((call, index) => ({
	role: "toolResult",
	toolCallId: call.id,
	toolName: call.name,
	isError: false,
	timestamp: 2,
	content: index < 2 ? [] : [{ type: "text", text: "SECRET local result" }],
	...(index < 2
		? { openaiCodexOutput: [{ type: "input_image" as const, image_url: "data:image/png;base64,SECRET" }] }
		: {}),
}));
const messages: (AssistantMessage | ToolResultMessage)[] = [assistant, ...results];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

describe("native Codex display privacy", () => {
	test("projects private calls and results without changing model context", () => {
		const before = JSON.stringify(messages);
		const presentation = new ModelOnlyToolPresentation();
		const visible = messages.map((message) => presentation.message(message)).filter(Boolean);
		expect(visible).toEqual([{ ...assistant, content: [{ type: "text", text: "Public answer" }] }]);
		expect(JSON.stringify(messages)).toBe(before);
		expect(new ModelOnlyToolPresentation().message(results[0])).toBeUndefined();
	});

	test("does not hide same-name application tools on other providers or namespaces", () => {
		for (const call of calls) {
			expect(isModelOnlyToolCall({ ...assistant, provider: "openai" }, call)).toBe(false);
			expect(isModelOnlyToolCall({ ...assistant, api: "openai-responses" }, call)).toBe(false);
			expect(isModelOnlyToolCall(assistant, { ...call, namespace: "application" })).toBe(false);
		}
		expect(isModelOnlyToolCall(assistant, { ...calls[0], namespace: undefined })).toBe(false);
		const ordinary = { ...results[2], toolCallId: "ordinary" };
		expect(new ModelOnlyToolPresentation().message(ordinary)).toBe(ordinary);
	});

	test("hides native tools in expanded live and restored subagent transcripts", () => {
		for (const live of [true, false]) {
			const agent: SubagentUiSnapshot = {
				id: "a",
				name: "worker",
				turnId: "turn",
				task: "task",
				modelRole: "worker",
				turnCount: 0,
				toolUses: 0,
				tokens: 0,
				status: live ? "running" : "idle",
				model: "codex",
				workspace: "/tmp",
				messages: live ? [] : messages,
				streamingMessage: live ? assistant : undefined,
				live,
				createdAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			const viewer = new SubagentConversationViewer({
				context: { mode: "tui" } as ExtensionContext,
				runtime: {
					listSubagentsForUi: () => [agent],
					subscribeSubagentUi: () => () => {},
				} as unknown as RiemannRuntime,
				agentId: "a",
				tui: { terminal: { rows: 80 }, requestRender: () => {} } as unknown as TUI,
				theme,
				keybindings: new KeybindingsManager(),
				done: () => {},
				state: { toolsExpanded: true },
			});
			try {
				const rendered = stripAnsi(viewer.render(120).join("\n"));
				expect(rendered).toContain("Public answer");
				expect(rendered).not.toContain("SECRET");
				for (const call of calls) expect(rendered).not.toContain(call.name);
			} finally {
				viewer.dispose();
			}
		}
	});

	test("restores the interactive transcript without private tool cards or attachments", () => {
		const chatContainer = new Container();
		const addMessageToChat = vi.fn();
		const context = {
			pendingTools: new Map(),
			chatContainer,
			addMessageToChat,
			settingsManager: { getShowCacheMissNotices: () => false },
			ui: { requestRender: vi.fn() },
			maybeShowAssistantDiagnostics: vi.fn(),
		};
		const restore = Reflect.get(InteractiveMode.prototype, "renderSessionItems") as (
			this: typeof context,
			items: AgentMessage[],
		) => void;
		const before = JSON.stringify(messages);
		restore.call(context, messages);
		expect(chatContainer.children).toHaveLength(0);
		expect(context.pendingTools.size).toBe(0);
		expect(addMessageToChat).toHaveBeenCalledExactlyOnceWith(assistant);
		expect(JSON.stringify(messages)).toBe(before);
	});

	test("hides results even in the all-entries tree and retains public navigation", () => {
		const sm = SessionManager.inMemory();
		for (const message of messages) sm.appendMessage(message);
		const before = JSON.stringify(sm.getEntries());
		const selector = new TreeSelectorComponent(
			sm.getTree(),
			sm.getLeafId(),
			40,
			() => {},
			() => {},
			undefined,
			undefined,
			"all",
		);
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("Public answer");
		expect(rendered).not.toContain("SECRET");
		for (const call of calls) expect(rendered).not.toContain(call.name);
		expect(JSON.stringify(sm.getEntries())).toBe(before);
	});

	test("removes private payloads before HTML embedding and custom rendering, not from JSONL", async () => {
		const directory = mkdtempSync(join(tmpdir(), "codex-display-"));
		try {
			const input = join(directory, "session.jsonl");
			const entries: SessionEntry[] = messages.map((message, index) => ({
				type: "message",
				id: `m${index}`,
				parentId: index === 0 ? null : `m${index - 1}`,
				timestamp: new Date().toISOString(),
				message,
			}));
			entries.push({
				type: "custom",
				id: "private-state",
				parentId: "m4",
				timestamp: new Date().toISOString(),
				customType: "codex-context-window",
				data: { threadHint: "SECRET", initialMessages: messages },
			});
			const source = `${[
				{ type: "session", version: 3, id: "privacy-test", timestamp: new Date().toISOString(), cwd: directory },
				...entries,
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`;
			writeFileSync(input, source);
			const renderCall = vi.fn();
			const renderResult = vi.fn();
			for (const standalone of [true, false]) {
				const outputPath = join(directory, `${standalone}.html`);
				if (standalone) await exportFromFile(input, { outputPath });
				else
					await exportSessionToHtml(SessionManager.open(input), undefined, {
						outputPath,
						toolRenderer: { renderCall, renderResult },
					});
				const html = readFileSync(outputPath, "utf8");
				const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
				expect(encoded).toBeDefined();
				const decoded = Buffer.from(encoded!, "base64").toString("utf8");
				expect(decoded).toContain("Public answer");
				expect(decoded).not.toContain("SECRET");
				for (const call of calls) expect(decoded).not.toContain(call.name);
				expect(JSON.parse(decoded).leafId).toBe("m0");
			}
			expect(renderCall).not.toHaveBeenCalled();
			expect(renderResult).not.toHaveBeenCalled();
			expect(readFileSync(input, "utf8")).toBe(source);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
