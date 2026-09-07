import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import dart from "highlight.js/lib/languages/dart.js";
import go from "highlight.js/lib/languages/go.js";
import groovy from "highlight.js/lib/languages/groovy.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import lua from "highlight.js/lib/languages/lua.js";
import nix from "highlight.js/lib/languages/nix.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import python from "highlight.js/lib/languages/python.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scala from "highlight.js/lib/languages/scala.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import { decodeHtmlEntityAt } from "./html.ts";

// Highlight external executables only in command position. Bash's stock
// highlight.js grammar recognizes built-ins, but leaves git/rg/node unstyled.
function shellLanguage(api: Parameters<typeof bash>[0]): ReturnType<typeof bash> {
	const language = bash(api);
	const reserved = new Set<string>();
	if (language.keywords && typeof language.keywords === "object") {
		for (const words of Object.values(language.keywords)) {
			if (typeof words === "string") {
				for (const word of words.split(/\s+/)) reserved.add(word.split("|")[0]!);
			}
		}
	}
	const prefix =
		/(?:^|(?<!\\)[;&|\n(])[\t ]*(?:(?:if|then|elif|else|while|until|do|!|command|exec|builtin|env|sudo|nohup|time)[\t ]+|[A-Za-z_]\w*\+?=(?:\\.|"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|"'\\])+[\t ]+)*$/;
	const command: (typeof language.contains)[number] = {
		className: "title",
		begin: /[A-Za-z0-9_./][A-Za-z0-9_./:+-]*/,
		relevance: 0,
		"on:begin": (match, response) => {
			const index = match.index ?? 0;
			let before = match.input?.slice(0, index) ?? "";
			const lineStart = before.lastIndexOf("\n") + 1;
			if (lineStart > 0 && before[lineStart - 2] !== "\\") before = before.slice(lineStart);
			if (
				reserved.has(match[0]) ||
				match.input?.[index + match[0].length] === "=" ||
				before.endsWith("((") ||
				!prefix.test(before)
			)
				response.ignoreMatch();
		},
	};
	// Command substitutions inside quoted strings have their own nested mode.
	// Leave the original quote/comment/variable rules intact and ahead of this rule.
	const pending = [...language.contains];
	const seen = new Set<(typeof language.contains)[number]>();
	while (pending.length > 0) {
		const mode = pending.pop()!;
		if (seen.has(mode)) continue;
		seen.add(mode);
		if (mode.className === "subst") mode.contains = [...(mode.contains ?? []), command];
		for (const child of mode.contains ?? []) {
			if (child !== "self") pending.push(child);
		}
	}
	language.contains.push(command);
	return language;
}

const eagerLanguages = {
	python,
	java,
	go,
	javascript,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	nix,
	bash: shellLanguage,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
};

for (const [name, language] of Object.entries(eagerLanguages)) {
	hljs.registerLanguage(name, language);
}

let allLanguagesPromise: Promise<void> | undefined;

export function loadAllHighlightLanguages(): Promise<void> {
	if (!allLanguagesPromise) {
		allLanguagesPromise = new Promise((resolve) => {
			setImmediate(() => {
				void import("highlight.js/lib/index.js").then(
					() => {
						hljs.registerLanguage("bash", shellLanguage);
						resolve();
					},
					() => {
						// Eager languages and plaintext fallback remain available.
						resolve();
					},
				);
			});
		});
	}
	return allLanguagesPromise;
}

export type HighlightFormatter = (text: string) => string;
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

export interface HighlightOptions {
	language?: string;
	ignoreIllegals?: boolean;
	languageSubset?: string[];
	theme?: HighlightTheme;
}

const SPAN_CLOSE = "</span>";
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	let textBuffer = "";
	const scopes: Array<string | undefined> = [];

	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

export function highlight(code: string, options: HighlightOptions = {}): string {
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name) !== undefined;
}
