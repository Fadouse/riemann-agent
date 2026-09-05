import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonContainer = JsonValue[] | { [key: string]: JsonValue };
interface JsonFrame {
	value: JsonContainer;
	state: "keyOrEnd" | "key" | "colon" | "valueOrEnd" | "value" | "commaOrEnd";
	key: string;
}
type JsonToken =
	| { kind: "string"; key: boolean; value: string; escape: string; trailingSpace: number }
	| { kind: "primitive"; value: string; whitespace: boolean };

// Copy containers, not immutable strings. structuredClone would copy the growing
// string on every delta. Neither earlier snapshots nor callers may mutate parser state.
function copyJsonValue(value: JsonValue): JsonValue {
	if (value === null || typeof value !== "object") return value;
	const root: JsonContainer = Array.isArray(value) ? [...value] : { ...value };
	const pending: Array<{ source: JsonContainer; target: JsonContainer }> = [{ source: value, target: root }];
	while (pending.length > 0) {
		const { source, target } = pending.pop()!;
		for (const key of Object.keys(source)) {
			const child = Array.isArray(source) ? source[Number(key)] : source[key];
			if (child === null || typeof child !== "object") continue;
			const copy: JsonContainer = Array.isArray(child) ? [...child] : { ...child };
			if (Array.isArray(target)) target[Number(key)] = copy;
			else target[key] = copy;
			pending.push({ source: child, target: copy });
		}
	}
	return root;
}

/**
 * Scan append-only JSON once, including strings/escapes split across deltas.
 * Each append returns an independent snapshot with the same partial values as
 * parseStreamingJson. Nonstandard/malformed input falls back to that parser for
 * the rest of the stream: its permissive parsing and repair precedence are part
 * of the existing API, not a grammar to silently tighten here.
 */
export class StreamingJsonParser<T = Record<string, unknown>> {
	private source = "";
	private frames: JsonFrame[] = [];
	private token: JsonToken | undefined;
	private root: JsonValue | undefined;
	private fallback = false;

	constructor(initial = "") {
		this.append(initial);
	}

	append(delta: string): T {
		this.source += delta;
		if (!this.fallback) {
			for (let index = 0; index < delta.length && !this.fallback; index++) {
				const char = delta[index];
				const token = this.token;
				if (token?.kind === "string") {
					this.stringCharacter(token, char);
					continue;
				}
				if (token?.kind === "primitive") {
					if (!" \t\r\n,]}".includes(char)) {
						if (token.whitespace) this.fallback = true;
						else token.value += char;
						continue;
					}
					try {
						const value: JsonValue = JSON.parse(token.value);
						this.token = undefined;
						this.commit(value);
					} catch {
						if (" \t\r\n".includes(char)) token.whitespace = true;
						else this.fallback = true;
						continue;
					}
				}
				this.structuralCharacter(char);
			}
		}
		return this.snapshot();
	}

	private commit(value: JsonValue): void {
		const frame = this.frames.at(-1);
		if (!frame) this.root = value;
		else {
			if (Array.isArray(frame.value)) frame.value.push(value);
			else frame.value[frame.key] = value;
			frame.state = "commaOrEnd";
		}
	}

	private structuralCharacter(char: string): void {
		if (" \t\r\n".includes(char)) return;
		const frame = this.frames.at(-1);
		if (frame) {
			const array = Array.isArray(frame.value);
			if ((char === "]" && array) || (char === "}" && !array)) {
				if (frame.state !== "commaOrEnd" && frame.state !== "keyOrEnd" && frame.state !== "valueOrEnd") {
					this.fallback = true;
					return;
				}
				this.frames.pop();
				this.commit(frame.value);
				return;
			}
			if (frame.state === "commaOrEnd") {
				if (char !== ",") this.fallback = true;
				else frame.state = array ? "value" : "key";
				return;
			}
			if (frame.state === "colon") {
				if (char !== ":") this.fallback = true;
				else frame.state = "value";
				return;
			}
			if (frame.state === "key" || frame.state === "keyOrEnd") {
				if (char !== '"') this.fallback = true;
				else this.token = { kind: "string", key: true, value: "", escape: "", trailingSpace: 0 };
				return;
			}
		} else if (this.root !== undefined) {
			this.fallback = true;
			return;
		}
		if (char === "{" || char === "[") {
			this.frames.push({ value: char === "[" ? [] : {}, state: char === "[" ? "valueOrEnd" : "keyOrEnd", key: "" });
		} else if (char === '"') {
			this.token = { kind: "string", key: false, value: "", escape: "", trailingSpace: 0 };
		} else if (/[0-9tfn-]/.test(char)) {
			this.token = { kind: "primitive", value: char, whitespace: false };
		} else {
			this.fallback = true;
		}
	}

	private stringCharacter(token: Extract<JsonToken, { kind: "string" }>, char: string): void {
		if (token.escape.startsWith("u")) {
			if (!/[0-9a-fA-F]/.test(char)) {
				this.fallback = true;
				return;
			}
			token.escape += char;
			if (token.escape.length === 5) {
				token.value += String.fromCharCode(Number.parseInt(token.escape.slice(1), 16));
				token.escape = "";
			}
			return;
		}
		if (token.escape === "\\") {
			if (char === "u") token.escape = "u";
			else if (VALID_JSON_ESCAPES.has(char)) {
				token.value += JSON.parse(`"\\${char}"`) as string;
				token.escape = "";
			} else this.fallback = true;
			return;
		}
		if (char === "\\") {
			token.escape = "\\";
			token.trailingSpace = 0;
		} else if (char === '"') {
			this.token = undefined;
			if (token.key) {
				// partial-json uses property assignment whereas JSON.parse defines an own
				// __proto__ property. Preserve both behaviors through the compatibility path.
				if (token.value === "__proto__") this.fallback = true;
				const frame = this.frames.at(-1)!;
				frame.key = token.value;
				frame.state = "colon";
			} else this.commit(token.value);
		} else if (char.charCodeAt(0) < 0x20) {
			this.fallback = true;
		} else {
			token.value += char;
			// partial-json trims the *source*, including whitespace at an open string's
			// end. Escaped whitespace must not be trimmed from the decoded value.
			token.trailingSpace = /\s/u.test(char) ? token.trailingSpace + 1 : 0;
		}
	}

	private snapshot(): T {
		if (this.fallback) {
			// The complete source owns compatibility recovery from here on; parsed
			// prefixes are no longer needed and must not retain a second tree.
			this.frames = [];
			this.token = undefined;
			this.root = undefined;
			return parseStreamingJson<T>(this.source);
		}
		let value: JsonValue | undefined;
		const token = this.token;
		if (token?.kind === "string" && !token.key) {
			value = token.trailingSpace ? token.value.slice(0, -token.trailingSpace) : token.value;
		} else if (token?.kind === "primitive") {
			try {
				value = JSON.parse(token.value) as JsonValue;
			} catch {
				try {
					value = partialParse(token.value) as JsonValue;
					if (this.frames.length === 0 && value === null) value = undefined;
				} catch {
					// Incomplete numbers have no value yet (e.g. '-' or '1.').
				}
			}
		}
		for (let index = this.frames.length - 1; index >= 0; index--) {
			const frame = this.frames[index];
			const copy = copyJsonValue(frame.value) as JsonContainer;
			if (value !== undefined) {
				if (Array.isArray(copy)) copy.push(value);
				else copy[frame.key] = value;
			}
			value = copy;
		}
		return (value !== undefined ? value : this.root === undefined ? {} : copyJsonValue(this.root)) as T;
	}
}
