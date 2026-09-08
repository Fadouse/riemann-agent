import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { IPythonToolDetails } from "../src/riemann/ipython.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

test("yield keeps the task animation alive and hides protocol IDs", () => {
	initTheme("dark");
	const component = new IPythonCellComponent({
		code: 'print("hello")',
		isPartial: false,
		executionStarted: true,
		details: { status: "running", cellId: "cell-123", durationMs: 10000 },
		content: [{ type: "text", text: "Script running with cell ID cell-123" }],
	});
	const rendered = component.render(100).map(stripAnsi).join("\n");
	expect(rendered).not.toContain("Yielded");
	expect(rendered).not.toContain("cell-123");
	expect(rendered).not.toContain("cell ID");
	expect(rendered).not.toContain("ipython_wait");
	expect(component.hasRunningAnimation()).toBe(true);
});

test("interactive events and history replay coalesce empty waits without recomputing the task body", async () => {
	initTheme("dark");
	for (const live of [true, false]) {
		const ui = { requestRender: () => {} } as unknown as TUI;
		const context = {
			isInitialized: true,
			ui,
			footer: { invalidate() {} },
			chatContainer: new Container(),
			pendingTools: new Map<string, ToolExecutionComponent>(),
			toolOutputExpanded: true,
			settingsManager: {
				getShowImages: () => false,
				getImageWidthCells: () => 60,
				getShowCacheMissNotices: () => false,
			},
			sessionManager: { getCwd: () => process.cwd() },
			getRegisteredToolDefinition: () => undefined,
			addMessageToChat() {},
			maybeShowAssistantDiagnostics() {},
		};
		const prototype = InteractiveMode.prototype as unknown as {
			handleEvent(this: typeof context, event: AgentSessionEvent): Promise<void>;
			renderSessionItems(this: typeof context, items: AgentMessage[]): void;
		};
		const messages: AgentMessage[] = [];
		const details: IPythonToolDetails = {
			status: "running",
			cellId: "c1",
			taskKey: "internal-task-key",
			startedAt: Date.now(),
			activities: [{ id: "read-1", kind: "explore", operation: "read", status: "ok", target: "trace.log" }],
		};
		const call = async (
			name: string,
			id: string,
			text: string,
			resultDetails?: IPythonToolDetails,
			isError = false,
		) => {
			const args = name === "ipython" ? { code: 'print("first")' } : { id: "c1" };
			const result = { content: [{ type: "text" as const, text }], details: resultDetails };
			messages.push(
				{
					role: "assistant",
					content: [{ type: "toolCall", id, name, arguments: args }],
					api: "openai-responses",
					provider: "faux",
					model: "test",
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
				},
				{ role: "toolResult", toolCallId: id, toolName: name, ...result, isError, timestamp: 1 },
			);
			if (live) {
				await prototype.handleEvent.call(context, {
					type: "tool_execution_start",
					toolCallId: id,
					toolName: name,
					args,
				});
				if (resultDetails)
					await prototype.handleEvent.call(context, {
						type: "tool_execution_update",
						toolCallId: id,
						toolName: name,
						args,
						partialResult: { content: [], details: resultDetails },
					});
				await prototype.handleEvent.call(context, {
					type: "tool_execution_end",
					toolCallId: id,
					toolName: name,
					result,
					isError,
				});
			}
		};
		await call("ipython", "exec", "running id=c1\nfirst", details);
		context.chatContainer.render(100);
		const updates = vi.spyOn(IPythonCellComponent.prototype, "update");
		try {
			for (let index = 0; index < 20; index++)
				await call("ipython_wait", `wait-${index}`, `running id=c1\n\n\n\n[ref=r${index + 10}]`, {
					...details,
					resultRef: `r${index + 10}`,
					durationMs: index * 10000,
				});
			expect(updates).not.toHaveBeenCalled();
		} finally {
			updates.mockRestore();
		}
		await call("ipython_wait", "interrupted-wait", "wait failed", undefined, true);
		await call("ipython_wait", "final", "ok\n\nlast\nend\n\n[ref=r9; 42000 UTF-8 bytes omitted before]", {
			...details,
			status: "ok",
			resultRef: "r9",
			truncated: true,
		});
		const original = JSON.stringify(messages);
		if (!live) prototype.renderSessionItems.call(context, messages);
		expect(JSON.stringify(messages)).toBe(original);
		const rendered = context.chatContainer.render(100).map(stripAnsi).join("\n");
		expect(rendered.match(/^.*first$/gm)).toHaveLength(1);
		expect(rendered).toContain("last");
		expect(rendered.match(/trace\.log/g)).toHaveLength(1);
		expect(rendered.match(/\[ref r9\]/g)).toHaveLength(1);
		expect(rendered).not.toContain("Warning: output truncated");
		expect(rendered).not.toContain("UTF-8 bytes omitted");
		expect(rendered).not.toContain("internal-task-key");
		expect(rendered).not.toContain("running id=");
		expect(rendered).toContain("wait failed");
		expect(context.chatContainer.children.filter((component) => component.render(100).length > 0)).toHaveLength(2);
	}
});

test.each([false, true])("exec and wait show output references only when expanded (expanded=%s)", (expanded) => {
	initTheme("dark");
	for (const name of ["ipython", "ipython_wait"]) {
		const component = new ToolExecutionComponent(
			name,
			"tool-call",
			name === "ipython" ? { code: "print(42)" } : { id: "c1234abcd" },
			{ requestAnimationFrames: false },
			undefined,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(expanded);
		for (const status of ["running", "ok", "error"]) {
			const header = status === "running" ? "running id=c1234abcd; use ipython_wait; do not rerun" : status;
			component.updateResult({
				content: [
					{
						type: "text",
						text: `${header}\n\n[ref=r5]\nProcessHandle(id='p1')\nselected output\nfinal result\n\n[ref=r7; 42000 UTF-8 bytes omitted before; partial line]`,
					},
				],
				details: {
					status,
					cellId: "c1234abcd",
					resultRef: "r7",
					truncated: true,
					activities: [
						{
							id: "shell",
							kind: "shell",
							operation: "run",
							status: "ok",
							command: "pwd",
							stdout: "workspace",
							resultRef: "r6",
						},
					],
				},
				isError: status === "error",
			});
			const rendered = component.render(100).map(stripAnsi).join("\n");
			expect(rendered).not.toContain("c1234abcd");
			expect(rendered).not.toContain("cell_id");
			expect(rendered).not.toContain("id='p1'");
			expect(rendered).not.toContain("yield_time_ms");
			expect(rendered).not.toContain("Script running");
			expect(rendered).not.toContain("Warning: output truncated");
			expect(rendered).not.toContain("Boundary lines are partial");
			expect(rendered).not.toContain("UTF-8 bytes omitted");
			expect(rendered).toContain("selected output");
			expect(rendered).toContain("final result");
			for (const ref of ["r5", "r6", "r7"])
				expect(rendered.match(new RegExp(`\\[ref ${ref}\\]`, "g")) ?? []).toHaveLength(expanded ? 1 : 0);
		}
		component.updateResult({
			content: [
				{
					type: "text",
					text: "error\n\nipython_wait [runtime_error]: Unknown or already collected Python cell: c1234abcd\nError: Unknown or already collected Python cell: c1234abcd\n\n[ref=r8]",
				},
			],
			details: { status: "error", resultRef: "r8" },
			isError: true,
		});
		expect(component.render(100).map(stripAnsi).join("\n")).not.toContain("c1234abcd");
	}
});
