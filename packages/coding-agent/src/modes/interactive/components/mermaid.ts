import { Marked, type Token } from "@earendil-works/pi-tui";
import { type MermaidArt, render, type Span } from "grok-mermaid";
import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
import type { Theme } from "../theme/theme.ts";

const markdownParser = new Marked();

interface MermaidTransformerOptions {
	getMode: () => MermaidRenderingMode;
	theme?: Theme;
}

interface MermaidTransformCache {
	markdown: string;
	mode: MermaidRenderingMode;
	messageType: MarkdownTransformContext["messageType"];
	isStreaming: boolean;
	availableWidth: number;
	themeSignature: string | null | undefined;
	result: string;
}

function isMermaid(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function codeSpan(line: string): string {
	// Encode each diagram row as inline code (` ... `) so Markdown preserves its spacing and
	// box-drawing characters. Use a non-breaking space for blank rows because an
	// empty code span has no visible height.
	const content = line || "\u00a0";
	// CommonMark code spans use matching backtick delimiters, so choose one
	// longer than any backtick run in the content (``hel`lo`` -> <code>hel`lo</code>).
	// If the content starts or ends with a backtick, separating it from the
	// delimiter with a space keeps that backtick as content; CommonMark removes
	// the padding when rendering (`` `edge` `` -> <code>`edge`</code>).
	// Mermaid labels can preserve backticks, for example:
	//   `┌──────────────┐    ┌──────────────┐`
	// ```│ plain ` tick ├───▶│ two `` ticks │```
	//   `└──────────────┘    └──────────────┘`
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function styleSpan(span: Span, theme: Theme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		case "none":
			return span.text;
	}
}

function themedLines(art: MermaidArt, theme: Theme): string[] {
	return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}

function getThemeSignature(theme: Theme): string {
	const marker = "\u0000";
	return JSON.stringify([
		theme.fg("borderMuted", marker),
		theme.fg("text", marker),
		theme.fg("accent", marker),
		theme.fg("muted", marker),
		theme.fg("warning", marker),
		theme.bold(marker),
	]);
}

/** Create a transformer that replaces top-level Mermaid code blocks with Unicode terminal diagrams. */
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
	let cache: MermaidTransformCache | undefined;

	return (markdown, context) => {
		const mode = options.getMode();
		if (
			mode === "off" ||
			context.messageType === "assistant-thinking" ||
			(context.isStreaming && mode !== "streaming")
		) {
			return markdown;
		}

		// Fenced code requires at least three backticks or tildes. Avoid lexing ordinary messages.
		if (!/mermaid/i.test(markdown) || (!markdown.includes("```") && !markdown.includes("~~~"))) {
			return markdown;
		}

		if (
			cache?.markdown === markdown &&
			cache.mode === mode &&
			cache.messageType === context.messageType &&
			cache.isStreaming === context.isStreaming &&
			cache.availableWidth === context.availableWidth
		) {
			if (cache.themeSignature === undefined) return cache.result;
			const themeSignature = options.theme ? getThemeSignature(options.theme) : null;
			if (cache.themeSignature === themeSignature) return cache.result;
		}

		let dependsOnTheme = false;
		const result = markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = render(token.text);
				if (!art || art.width > context.availableWidth) return token.raw;
				if (!context.isStreaming && art.warnings.length > 0) {
					const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
					const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
					let styledWarning = warning;
					dependsOnTheme = true;
					if (options.theme) {
						styledWarning = options.theme.fg("warning", warning);
					}
					return `${token.raw}\n${codeSpan(styledWarning)}  \n`;
				}
				dependsOnTheme = true;
				const lines = options.theme ? themedLines(art, options.theme) : art.plain;
				// Markdown hard breaks keep every diagram row on its own line.
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");

		cache = {
			markdown,
			mode,
			messageType: context.messageType,
			isStreaming: context.isStreaming,
			availableWidth: context.availableWidth,
			themeSignature: dependsOnTheme ? (options.theme ? getThemeSignature(options.theme) : null) : undefined,
			result,
		};
		return result;
	};
}
