import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSession(
	options: {
		sessionName?: string;
		modelId?: string;
		provider?: string;
		reasoning?: boolean;
		thinkingLevel?: string;
		noModel?: boolean;
		percent?: number | null;
		noContext?: boolean;
		onUsageRead?: () => void;
		onContextRead?: () => void;
	} = {},
): AgentSession {
	return {
		state: {
			model: options.noModel
				? undefined
				: {
						id: options.modelId ?? "test-model",
						provider: options.provider ?? "test",
						contextWindow: 200_000,
						reasoning: options.reasoning ?? false,
					},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => {
				options.onUsageRead?.();
				return [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: {
								input: 12345,
								output: 6789,
								cacheRead: 50,
								cacheWrite: 50,
								cost: { total: 1.234 },
							},
						},
					},
				];
			},
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => {
			options.onContextRead?.();
			return options.noContext
				? undefined
				: { contextWindow: 200_000, percent: options.percent === undefined ? 12.3 : options.percent };
		},
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
}

function createFooterData(providerCount = 1, statuses = new Map<string, string>()): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
	};
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});
	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent compact layout", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps model and context on the left and the directory on the right", () => {
		const footer = new FooterComponent(createSession({ reasoning: true, thinkingLevel: "high" }), createFooterData());
		const lines = footer.render(80).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^test-model high • 12\.3%\/200k \(auto\)/);
		expect(lines[0]).toMatch(/\/tmp\/project \(main\)$/);
		expect(visibleWidth(lines[0])).toBe(80);
	});

	it("keeps context visible without the path at 40 columns", () => {
		const lines = new FooterComponent(createSession({ reasoning: true, thinkingLevel: "high" }), createFooterData())
			.render(40)
			.map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("12.3%/200k");
		expect(lines[0]).not.toContain("/tmp");
		expect(lines[0]).toMatch(/^test-model high •/);
		expect(visibleWidth(lines[0])).toBe(40);
	});

	it("does not show cumulative tokens, cache or cost or scan history", () => {
		let reads = 0;
		const footer = new FooterComponent(createSession({ onUsageRead: () => reads++ }), createFooterData());
		const text = footer.render(120).map(stripAnsi).join("\n");
		expect(text).not.toMatch(/↑|↓|CH|\$|R50|W50/);
		expect(reads).toBe(0);
	});

	it.each([40, 80])("retains a named session or its details entry at width %i", (width) => {
		const footer = new FooterComponent(createSession({ sessionName: "한글".repeat(30) }), createFooterData());
		const lines = footer.render(width).map(stripAnsi);
		expect(lines.join("\n")).toContain("한글");
		expect(lines.join("\n")).toContain("/session");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("keeps a short named session in one bounded row on wide terminals", () => {
		const lines = new FooterComponent(createSession({ sessionName: "release" }), createFooterData())
			.render(120)
			.map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/\/tmp\/project \(main\) release$/);
		expect(visibleWidth(lines[0])).toBe(120);
	});

	it("includes provider only when multiple providers are available and it fits", () => {
		const session = createSession({ provider: "provider-name", reasoning: true, thinkingLevel: "high" });
		expect(new FooterComponent(session, createFooterData(2)).render(120).map(stripAnsi).join("")).toContain(
			"(provider-name)",
		);
		expect(new FooterComponent(session, createFooterData(1)).render(120).map(stripAnsi).join("")).not.toContain(
			"(provider-name)",
		);
		const narrow = new FooterComponent(session, createFooterData(2)).render(40).map(stripAnsi).join("");
		expect(narrow).not.toContain("(provider-name)");
		expect(narrow).toContain("test-model");
		expect(narrow).toContain("12.3%/200k");
	});

	it("bounds the footer with a provider and manual compaction on wide terminals", () => {
		const footer = new FooterComponent(
			createSession({ provider: "openai-codex", modelId: "gpt-6-astra", reasoning: true, thinkingLevel: "medium" }),
			createFooterData(2),
		);
		footer.setAutoCompactEnabled(false);
		const lines = footer.render(120).map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\(openai-codex\) gpt-6-astra medium •/);
		expect(lines[0]).toContain("12.3%/200k (manual)");
		expect(visibleWidth(lines[0])).toBe(120);
	});

	it("reserves context when a long model identifier cannot fit and omits the path", () => {
		const lines = new FooterComponent(createSession({ modelId: "model".repeat(20) }), createFooterData())
			.render(20)
			.map(stripAnsi);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^modelm… • 12\.3%\/200k$/);
		expect(visibleWidth(lines[0])).toBe(20);
	});

	it.each([{ percent: null }, { noContext: true }, { noContext: true, noModel: true }])(
		"does not present unknown context as zero: %j",
		(options) => {
			const text = new FooterComponent(createSession(options), createFooterData())
				.render(40)
				.map(stripAnsi)
				.join("");
			expect(text).toContain("?/");
			expect(text).not.toContain("0.0%");
			if (options.noModel) expect(text).toContain("no-model");
		},
	);

	it("keeps extension statuses sorted, sanitized and width bounded in their existing line", () => {
		const statuses = new Map([
			["z", "last\nstatus"],
			["a", "first\tstatus"],
		]);
		const footer = new FooterComponent(createSession(), createFooterData(1, statuses));
		expect(stripAnsi(footer.render(80).at(-1)!)).toBe("first status last status");
		statuses.set("b", "模".repeat(100));
		const lines = footer.render(40);
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it.each([1, 8, 20, 40, 80])("bounds wide model, provider and session text at %i columns", (width) => {
		const session = createSession({
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			sessionName: "한글".repeat(30),
		});
		for (const line of new FooterComponent(session, createFooterData(2)).render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("caches context queries, including unknown results, until invalidated or switched", () => {
		let reads = 0;
		const session = createSession({ noContext: true, onContextRead: () => reads++ });
		const footer = new FooterComponent(session, createFooterData());
		footer.render(120);
		footer.render(40);
		expect(reads).toBe(1);
		footer.invalidate();
		footer.render(80);
		expect(reads).toBe(2);
		footer.setSession(createSession({ onContextRead: () => reads++ }));
		expect(footer.render(80).map(stripAnsi).join("")).toContain("12.3%/200k");
		expect(reads).toBe(3);
	});
});
