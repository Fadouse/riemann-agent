interface HighlightJsResult {
	value: string;
}

interface HighlightJsOptions {
	language: string;
	ignoreIllegals?: boolean;
}

interface HighlightJsMode {
	className?: string;
	begin?: string | RegExp;
	relevance?: number;
	contains?: Array<HighlightJsMode | "self">;
	"on:begin"?: (match: RegExpMatchArray, response: { ignoreMatch(): void }) => void;
}

interface HighlightJsLanguageDefinition extends HighlightJsMode {
	readonly name?: string;
	keywords?: string | Record<string, unknown>;
	contains: HighlightJsMode[];
}

type HighlightJsLanguageFactory = (hljs: HighlightJsApi) => HighlightJsLanguageDefinition;

interface HighlightJsApi {
	highlight(code: string, options: HighlightJsOptions): HighlightJsResult;
	highlightAuto(code: string, languageSubset?: string[]): HighlightJsResult;
	getLanguage(name: string): HighlightJsLanguageDefinition | undefined;
	registerLanguage(name: string, language: HighlightJsLanguageFactory): void;
}

declare module "highlight.js/lib/core.js" {
	const hljs: HighlightJsApi;
	export default hljs;
}

declare module "highlight.js/lib/index.js" {
	const hljs: HighlightJsApi;
	export default hljs;
}

declare module "highlight.js/lib/languages/*.js" {
	const language: HighlightJsLanguageFactory;
	export default language;
}
