import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { JsonValue, JupyterHeader, JupyterMessage } from "./types.ts";

const DELIMITER = Buffer.from("<IDS|MSG>");
const EMPTY_OBJECT = Buffer.from("{}");

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

type JsonContainer = Record<string, unknown> | unknown[];

function jsonPath(root: string, keys: readonly (string | number)[]): string {
	let path = root;
	for (const key of keys) path += typeof key === "number" ? `[${key}]` : `[${JSON.stringify(key)}]`;
	return path;
}

function validateJsonValue(
	value: unknown,
	root: string,
	active: Set<JsonContainer>,
	keys: (string | number)[] = [],
): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new TypeError(`Cannot encode non-finite float at ${jsonPath(root, keys)}: ${String(value)}`);
		if (Number.isInteger(value) && Math.abs(value) > MAX_SAFE_INTEGER) {
			throw new TypeError(`Cannot encode unsafe integer at ${jsonPath(root, keys)}: ${String(value)}`);
		}
		return;
	}
	if (typeof value !== "object") {
		throw new TypeError(`Cannot encode ${typeof value} as JSON at ${jsonPath(root, keys)}`);
	}
	const container = value as JsonContainer;
	if (active.has(container)) throw new TypeError(`Cannot encode cyclic JSON value at ${jsonPath(root, keys)}`);
	active.add(container);
	try {
		// Diagnostic paths are only formatted on errors, not once per payload field.
		if (Array.isArray(container)) {
			for (let index = 0; index < container.length; index += 1) {
				keys.push(index);
				validateJsonValue(container[index], root, active, keys);
				keys.pop();
			}
			return;
		}
		for (const key of Reflect.ownKeys(container)) {
			if (typeof key !== "string") {
				throw new TypeError(`Cannot encode non-string dict key at ${jsonPath(root, keys)}: ${String(key)}`);
			}
			keys.push(key);
			validateJsonValue(container[key], root, active, keys);
			keys.pop();
		}
	} finally {
		active.delete(container);
	}
}

function jsonFrame(value: unknown, path: string): Buffer {
	validateJsonValue(value, path, new Set());
	return Buffer.from(JSON.stringify(value));
}

function parseHeader(value: unknown): JupyterHeader | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const header = value as Partial<JupyterHeader>;
	if (
		typeof header.msg_id !== "string" ||
		typeof header.username !== "string" ||
		typeof header.session !== "string" ||
		typeof header.date !== "string" ||
		typeof header.msg_type !== "string" ||
		typeof header.version !== "string"
	) {
		return undefined;
	}
	return {
		msg_id: header.msg_id,
		username: header.username,
		session: header.session,
		date: header.date,
		msg_type: header.msg_type,
		version: header.version,
	};
}

function parseJsonRecord(frame: Buffer): Record<string, JsonValue> | undefined {
	try {
		const value: unknown = JSON.parse(frame.toString("utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		validateJsonValue(value, "frame", new Set());
		return value as Record<string, JsonValue>;
	} catch {
		return undefined;
	}
}

function signature(parts: readonly Buffer[], key: string): string {
	if (!key) return "";
	const hmac = createHmac("sha256", key);
	for (const part of parts) hmac.update(part);
	return hmac.digest("hex");
}

function signaturesMatch(actual: Buffer, expected: string): boolean {
	const expectedBuffer = Buffer.from(expected, "ascii");
	return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function encodeJupyterMessage(options: {
	type: string;
	content?: Record<string, JsonValue>;
	metadata?: Record<string, JsonValue>;
	parentHeader?: Partial<JupyterHeader>;
	session: string;
	username: string;
	key: string;
	identities?: readonly Buffer[];
	buffers?: readonly Buffer[];
}): { id: string; frames: Buffer[]; header: JupyterHeader } {
	const header: JupyterHeader = {
		msg_id: randomUUID(),
		username: options.username,
		session: options.session,
		date: new Date().toISOString(),
		msg_type: options.type,
		version: "5.3",
	};
	const signed = [
		jsonFrame(header, "header"),
		options.parentHeader ? jsonFrame(options.parentHeader, "parent_header") : EMPTY_OBJECT,
		options.metadata ? jsonFrame(options.metadata, "metadata") : EMPTY_OBJECT,
		options.content ? jsonFrame(options.content, "content") : EMPTY_OBJECT,
	];
	const frames = [
		...(options.identities ?? []),
		DELIMITER,
		Buffer.from(signature(signed, options.key), "ascii"),
		...signed,
		...(options.buffers ?? []),
	];
	return { id: header.msg_id, frames, header };
}

export function decodeJupyterMessage(frames: readonly Buffer[], key: string): JupyterMessage | undefined {
	const delimiterIndex = frames.findIndex((frame) => frame.equals(DELIMITER));
	if (delimiterIndex < 0 || frames.length < delimiterIndex + 6) return undefined;
	const signatureFrame = frames[delimiterIndex + 1];
	const headerFrame = frames[delimiterIndex + 2];
	const parentFrame = frames[delimiterIndex + 3];
	const metadataFrame = frames[delimiterIndex + 4];
	const contentFrame = frames[delimiterIndex + 5];
	if (!signatureFrame || !headerFrame || !parentFrame || !metadataFrame || !contentFrame) return undefined;
	if (!signaturesMatch(signatureFrame, signature([headerFrame, parentFrame, metadataFrame, contentFrame], key))) {
		return undefined;
	}
	const header = parseHeader(parseJsonRecord(headerFrame));
	const parentHeader = parseJsonRecord(parentFrame);
	const metadata = parseJsonRecord(metadataFrame);
	const content = parseJsonRecord(contentFrame);
	if (!header || !parentHeader || !metadata || !content) return undefined;
	return {
		identities: frames.slice(0, delimiterIndex),
		header,
		parentHeader: parentHeader as Partial<JupyterHeader>,
		metadata,
		content,
		buffers: frames.slice(delimiterIndex + 6),
	};
}
