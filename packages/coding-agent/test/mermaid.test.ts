import { Marked } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { MarkdownTransformContext } from "../src/core/extensions/types.ts";
import type { MermaidRenderingMode } from "../src/core/settings-manager.ts";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

interface TransformOptions {
	maxWidth?: number;
	isStreaming?: boolean;
	messageType?: MarkdownTransformContext["messageType"];
	mode?: MermaidRenderingMode;
	theme?: Theme;
}

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transformer = createMermaidMarkdownTransformer({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
	});
	return transformer(markdown, {
		availableWidth: options.maxWidth ?? 100,
		isStreaming: options.isStreaming ?? false,
		messageType: options.messageType ?? "assistant",
	});
}

describe("Mermaid rendering", () => {
	it("returns without lexing when the source cannot contain a Mermaid fence", () => {
		const lexer = vi.spyOn(Marked.prototype, "lexer");
		try {
			expect(transformMermaid("ordinary markdown")).toBe("ordinary markdown");
			expect(transformMermaid("Mermaid is mentioned without a fence")).toBe("Mermaid is mentioned without a fence");
			expect(transformMermaid("```ts\nconst diagram = true;\n```")).toBe("```ts\nconst diagram = true;\n```");
			expect(lexer).not.toHaveBeenCalled();
		} finally {
			lexer.mockRestore();
		}
	});

	it("caches exact transforms and invalidates width-dependent results", () => {
		const lexer = vi.spyOn(Marked.prototype, "lexer");
		try {
			const transformer = createMermaidMarkdownTransformer({ getMode: () => "streaming" });
			const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";
			const context: MarkdownTransformContext = {
				availableWidth: 100,
				isStreaming: false,
				messageType: "assistant",
			};

			const first = transformer(markdown, context);
			expect(transformer(markdown, context)).toBe(first);
			expect(lexer).toHaveBeenCalledTimes(1);

			transformer(markdown, { ...context, availableWidth: 10 });
			expect(lexer).toHaveBeenCalledTimes(2);
		} finally {
			lexer.mockRestore();
		}
	});

	it("does not reuse a themed transform after the theme output changes", () => {
		let palette = "first";
		const dynamicTheme = {
			fg: (color: string, text: string) => `<${palette}-${color}>${text}</${palette}-${color}>`,
			bold: (text: string) => `<${palette}-bold>${text}</${palette}-bold>`,
		} as Theme;
		const transformerOptions: { getMode: () => MermaidRenderingMode; theme?: Theme } = {
			getMode: () => "streaming",
			theme: dynamicTheme,
		};
		const transformer = createMermaidMarkdownTransformer(transformerOptions);
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";
		const context: MarkdownTransformContext = {
			availableWidth: 100,
			isStreaming: false,
			messageType: "assistant",
		};

		expect(transformer(markdown, context)).toContain("<first-accent>");
		palette = "second";
		expect(transformer(markdown, context)).toContain("<second-accent>");

		transformerOptions.theme = undefined;
		expect(transformer(markdown, context)).not.toContain("<second-accent>");
		transformerOptions.theme = dynamicTheme;
		expect(transformer(markdown, context)).toContain("<second-accent>");
	});

	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain("Before");
		expect(rendered).toContain("┌───────┐");
		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(rendered).toContain("└───────┘    └──────┘`\nAfter");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).toContain("After");
	});

	it("leaves unsupported and oversized diagrams unchanged", () => {
		const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
		const oversized = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

		expect(transformMermaid(unsupported)).toBe(unsupported);
		expect(transformMermaid(oversized, { maxWidth: 10 })).toBe(oversized);
	});

	it("maps semantic spans through the Pi theme", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<bold>${text}</bold>`,
		} as Theme;
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme });

		expect(rendered).toContain("<borderMuted>");
		expect(rendered).toContain("<accent>");
	});

	it("renders incomplete Mermaid blocks during streaming", () => {
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";

		expect(transformMermaid(partialMarkdown, { isStreaming: true })).toContain("───▶");
	});

	it("falls back to the code block with a warning after streaming", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
		const final = transformMermaid(markdown);
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);
		const streaming = transformMermaid(markdown, { isStreaming: true });

		expect(final).toContain(markdown);
		expect(final).toContain("```\n`Mermaid diagram not rendered");
		expect(final).toContain('dropped, expected a link: ":::highlight --> B[Bar]"');
		expect(final).not.toContain("more)");
		expect(followedByText).toContain("  \nFollowing text");
		expect(streaming).not.toContain("Mermaid diagram not rendered");
		expect(streaming).not.toContain("```mermaid");
		expect(streaming).toContain("│ Foo │");
	});

	it("summarizes additional partial-render warnings", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n  C[Baz]:::other --> D[Qux]\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain(markdown);
		expect(rendered).toContain('dropped, expected a link: ":::highlight --> B[Bar]"');
		expect(rendered).toContain("(+1 more)");
		expect(rendered).not.toContain('dropped, expected a link: ":::other --> D[Qux]"');
	});

	it("respects rendering modes and skips thinking blocks", () => {
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final" })).not.toContain("```mermaid");
		expect(transformMermaid(markdown, { messageType: "assistant-thinking" })).toBe(markdown);
	});
});
