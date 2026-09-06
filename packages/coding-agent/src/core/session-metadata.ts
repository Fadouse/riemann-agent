import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { graphemeSafePrefix } from "../utils/text.ts";
import type { SessionInfo } from "./session-manager.ts";

// Disposable metadata only: no message history, process-wide map, or warm-up scan.
// Records have no size ceiling. Only individual I/O buffers and JSON frames are bounded.
const IO_BUFFER_BYTES = 16 * 1024;
const STRING_CHUNK_UNITS = 16 * 1024;
const MAX_FRAME_UNITS = STRING_CHUNK_UNITS * 6 + 128;
const METADATA_FIELDS = new Set([
	"signature",
	"id",
	"cwd",
	"name",
	"parentSessionPath",
	"created",
	"modified",
	"messageCount",
	"firstMessage",
]);
export const SESSION_PREVIEW_LENGTH = 1024;

function metadataPath(sessionPath: string): string {
	const key = createHash("sha256").update(resolve(sessionPath)).digest("hex");
	return join(dirname(sessionPath), ".metadata", `${key}.json`);
}

export async function readSessionMetadata(
	path: string,
	signature: string,
	signal?: AbortSignal,
): Promise<SessionInfo | undefined> {
	try {
		signal?.throwIfAborted();
		const record: Record<string, unknown> = {};
		let started = false;
		let completed = false;
		let stringKey: string | undefined;
		let stringParts: string[] = [];
		const finishString = () => {
			if (stringKey === undefined) return;
			record[stringKey] = stringParts.length === 1 ? stringParts[0] : stringParts.join("");
			if (stringKey === "signature" && record.signature !== signature) throw new Error("Stale session metadata");
			stringKey = undefined;
			stringParts = [];
		};
		const consumeFrame = (line: string): boolean => {
			if (line.length > MAX_FRAME_UNITS || completed) return false;
			const frame: unknown = JSON.parse(line);
			if (!Array.isArray(frame)) return false;
			if (!started) {
				started = frame.length === 2 && frame[0] === "format" && frame[1] === 2;
				return started;
			}
			if (frame.length === 1 && frame[0] === "end") {
				finishString();
				completed = true;
				return true;
			}
			const [key, value] = frame;
			if (frame.length !== 2 || typeof key !== "string" || !METADATA_FIELDS.has(key)) return false;
			if (typeof value === "string") {
				if (value.length > STRING_CHUNK_UNITS) return false;
				if (stringKey !== key) {
					finishString();
					if (Object.hasOwn(record, key)) return false;
					stringKey = key;
				}
				stringParts.push(value);
			} else {
				finishString();
				if (Object.hasOwn(record, key) || (value !== null && typeof value !== "number")) return false;
				record[key] = value;
			}
			return true;
		};
		const handle = await open(metadataPath(path), "r");
		try {
			const size = (await handle.stat()).size;
			if (size === 0) return undefined;
			const buffer = Buffer.allocUnsafe(Math.min(size, IO_BUFFER_BYTES));
			const decoder = new StringDecoder("utf8");
			let offset = 0;
			let pending = "";
			while (offset < size) {
				signal?.throwIfAborted();
				const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
				if (bytesRead === 0) return undefined;
				offset += bytesRead;
				pending += decoder.write(buffer.subarray(0, bytesRead));
				let start = 0;
				let newline = pending.indexOf("\n", start);
				while (newline !== -1) {
					if (!consumeFrame(pending.slice(start, newline))) return undefined;
					start = newline + 1;
					newline = pending.indexOf("\n", start);
				}
				pending = pending.slice(start);
				if (pending.length > MAX_FRAME_UNITS) return undefined;
			}
			pending += decoder.end();
			if (pending && !consumeFrame(pending)) return undefined;
		} finally {
			await handle.close();
		}
		signal?.throwIfAborted();
		if (
			!completed ||
			record.signature !== signature ||
			typeof record.id !== "string" ||
			typeof record.cwd !== "string" ||
			(record.name !== undefined && typeof record.name !== "string") ||
			(record.parentSessionPath !== undefined && typeof record.parentSessionPath !== "string") ||
			(record.created !== null && typeof record.created !== "number") ||
			(record.modified !== null && typeof record.modified !== "number") ||
			typeof record.messageCount !== "number" ||
			!Number.isSafeInteger(record.messageCount) ||
			record.messageCount < 0 ||
			typeof record.firstMessage !== "string" ||
			record.firstMessage.length > SESSION_PREVIEW_LENGTH
		)
			return undefined;
		return {
			path,
			id: record.id,
			cwd: record.cwd,
			name: record.name,
			parentSessionPath: record.parentSessionPath,
			created: new Date(record.created ?? NaN),
			modified: new Date(record.modified ?? NaN),
			messageCount: record.messageCount,
			firstMessage: record.firstMessage,
			allMessagesText: "",
		};
	} catch {
		// Missing, obsolete, corrupt and read-only indexes never make a session unavailable.
		return undefined;
	}
}

function* metadataFrames(signature: string, info: SessionInfo): Generator<string> {
	yield '["format",2]\n';
	const fields = {
		signature,
		id: info.id,
		cwd: info.cwd,
		name: info.name,
		parentSessionPath: info.parentSessionPath,
		created: info.created.getTime(),
		modified: info.modified.getTime(),
		messageCount: info.messageCount,
		firstMessage: graphemeSafePrefix(info.firstMessage, SESSION_PREVIEW_LENGTH),
	};
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		if (typeof value === "string") {
			// JSON escapes split surrogate pairs; decoding and joining the parts restores
			// the exact UTF-16 value, including lone surrogates and embedded newlines.
			for (let offset = 0; offset < value.length || offset === 0; offset += STRING_CHUNK_UNITS) {
				yield `${JSON.stringify([key, value.slice(offset, offset + STRING_CHUNK_UNITS)])}\n`;
			}
		} else {
			yield `${JSON.stringify([key, value])}\n`;
		}
	}
	yield '["end"]\n';
}

export async function writeSessionMetadata(
	path: string,
	signature: string,
	info: SessionInfo,
	signal?: AbortSignal,
): Promise<void> {
	let temporary: string | undefined;
	try {
		signal?.throwIfAborted();
		const target = metadataPath(path);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		temporary = `${target}.${randomUUID()}.tmp`;
		// writeFile consumes the iterator with backpressure: no record-sized JSON string or buffer.
		await writeFile(temporary, metadataFrames(signature, info), { flag: "wx", mode: 0o600, signal });
		signal?.throwIfAborted();
		await rename(temporary, target);
	} catch {
		// The authoritative JSONL remains usable when the derived index cannot be written.
	} finally {
		if (temporary) await unlink(temporary).catch(() => {});
	}
}

export async function removeSessionMetadata(path: string): Promise<void> {
	await unlink(metadataPath(path)).catch(() => {});
}
