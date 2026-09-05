import { type FileHandle, mkdtemp, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { RiemannStore } from "../src/riemann/state/store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function artifactHandle(value: JsonValue): string {
	if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.handle !== "string") {
		throw new Error("Expected artifact handle");
	}
	return value.handle;
}

describe("Riemann artifact storage", () => {
	test("preserves text and binary range semantics", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-artifacts-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("artifact-ranges", root);
		const artifacts = new ArtifactStore(store, run.id);
		try {
			const textHandle = artifactHandle(await artifacts.putText("0123456789"));
			expect(await artifacts.get(textHandle, { offset: 3, limit: 4 })).toEqual({
				handle: textHandle,
				mime_type: "text/plain; charset=utf-8",
				size: 10,
				offset: 3,
				next_offset: 7,
				content: "3456",
				truncated: true,
			});
			expect(await artifacts.get(textHandle, { offset: -2, limit: 3 })).toMatchObject({
				offset: 0,
				content: "012",
				truncated: true,
			});
			await expect(artifacts.get(textHandle, { offset: 3, limit: -1 })).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(artifacts.get(textHandle, { limit: 1_048_577 })).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			expect(await artifacts.get(textHandle, { offset: 50, limit: 4 })).toMatchObject({
				offset: 10,
				next_offset: 10,
				content: "",
				truncated: false,
			});
			expect(await artifacts.get(textHandle, { offset: 7 })).toMatchObject({
				content: "789",
				truncated: false,
			});

			const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
			const binaryHandle = artifactHandle(
				await artifacts.putBuffer(binary, { mimeType: "application/octet-stream" }),
			);
			expect(await artifacts.get(binaryHandle, { offset: 2, limit: 3 })).toEqual({
				handle: binaryHandle,
				mime_type: "application/octet-stream",
				size: binary.length,
				offset: 2,
				next_offset: 5,
				base64: binary.subarray(2, 5).toString("base64"),
				truncated: true,
			});
		} finally {
			store.close();
		}
	});

	test("keeps metadata identity stable and rounds UTF-8 slices to complete code points", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-artifact-identity-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("artifact-identity", root);
		const artifacts = new ArtifactStore(store, run.id);
		try {
			const first = artifactHandle(await artifacts.putText("😀x", { name: "first.txt" }));
			const second = artifactHandle(
				await artifacts.putBuffer(Buffer.from("😀x"), { name: "second.bin", mimeType: "application/octet-stream" }),
			);
			expect(first).not.toBe(second);
			expect(artifacts.getMetadata(first).name).toBe("first.txt");
			expect(artifacts.getMetadata(second).name).toBe("second.bin");
			expect(await artifacts.get(first, { offset: 0, limit: 3 })).toMatchObject({
				offset: 0,
				next_offset: 0,
				content: "",
				truncated: true,
			});
			expect(await artifacts.get(first, { offset: 0, limit: 4 })).toMatchObject({
				next_offset: 4,
				content: "😀",
			});
		} finally {
			store.close();
		}
	});

	test("reads a bounded range without loading a large sparse artifact", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "riemann-artifact-range-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("artifact-bounded-range", root);
		const artifacts = new ArtifactStore(store, run.id);
		try {
			const handle = artifactHandle(
				await artifacts.putBuffer(Buffer.from([0]), { mimeType: "application/octet-stream" }),
			);
			const fileSize = 2 ** 31;
			const tail = Buffer.from("tail");
			const file = await open(artifacts.getMetadata(handle).path, "r+");
			try {
				await file.truncate(fileSize);
				await file.write(tail, 0, tail.length, fileSize - tail.length);
			} finally {
				await file.close();
			}

			expect(await artifacts.get(handle, { offset: fileSize - tail.length, limit: tail.length })).toMatchObject({
				size: 1,
				offset: fileSize - tail.length,
				base64: tail.toString("base64"),
				truncated: false,
			});
		} finally {
			store.close();
		}
	});
	describe("streamed artifacts", () => {
		test("matches contiguous UTF-8 encoding across text chunk boundaries", async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-artifact-stream-"));
			roots.push(root);
			const store = new RiemannStore(join(root, ".agent"));
			const run = store.openRun("stream", root);
			const artifacts = new ArtifactStore(store, run.id);
			try {
				const parts = ["a\ud83d", "", "\ude00b", "\ud800", "c", "\udfff", "\ud800"];
				const options = { name: "stream.txt" };
				const streamed = await artifacts.putTextParts(parts, options);
				const contiguous = await artifacts.putText(parts.join(""), options);
				expect(streamed).toEqual(contiguous);
				expect(await artifacts.readBuffer(artifactHandle(streamed))).toEqual(Buffer.from(parts.join("")));
				expect(await artifacts.putTextParts([])).toEqual(await artifacts.putText(""));
			} finally {
				store.close();
			}
		});

		test("does not rewrite an existing text artifact when persisting parts", async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-artifact-text-dedupe-"));
			roots.push(root);
			const store = new RiemannStore(join(root, ".agent"));
			const run = store.openRun("text-dedupe", root);
			const artifacts = new ArtifactStore(store, run.id);
			try {
				const parts = ["x".repeat(65_535), "😀", "y".repeat(65_537), "\ud800"];
				const existing = await artifacts.putText(parts.join(""));
				const file = await open(artifacts.getMetadata(artifactHandle(existing)).path, "r");
				const prototype = Object.getPrototypeOf(file) as FileHandle;
				await file.close();
				// Reusing existing content must not require another write/fsync.
				const sync = vi.spyOn(prototype, "sync");
				try {
					expect(await artifacts.putTextParts(parts)).toEqual(existing);
					expect(sync).not.toHaveBeenCalled();
				} finally {
					sync.mockRestore();
				}
			} finally {
				store.close();
			}
		});

		test("streams binary chunks and cleans staging files on producer failure", async () => {
			const root = await mkdtemp(join(tmpdir(), "riemann-artifact-stream-error-"));
			roots.push(root);
			const store = new RiemannStore(join(root, ".agent"));
			const run = store.openRun("stream-error", root);
			const artifacts = new ArtifactStore(store, run.id);
			try {
				const options = { mimeType: "application/octet-stream" };
				const data = Buffer.from([0, 255, 128, 1]);
				async function* chunks() {
					yield data.subarray(0, 1);
					yield Buffer.alloc(0);
					yield data.subarray(1);
				}
				expect(await artifacts.putStream(chunks(), options)).toEqual(await artifacts.putBuffer(data, options));
				async function* failed() {
					yield data;
					throw new Error("producer failed");
				}
				await expect(artifacts.putStream(failed(), options)).rejects.toThrow("producer failed");
				expect((await readdir(store.artifactsDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
			} finally {
				store.close();
			}
		});
	});
});
