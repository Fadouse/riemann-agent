import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
				content: "3456",
				truncated: true,
			});
			expect(await artifacts.get(textHandle, { offset: -2, limit: 3 })).toMatchObject({
				offset: 0,
				content: "012",
				truncated: true,
			});
			expect(await artifacts.get(textHandle, { offset: 3, limit: -1 })).toMatchObject({
				offset: 3,
				content: "",
				truncated: true,
			});
			expect(await artifacts.get(textHandle, { offset: 50, limit: 4 })).toMatchObject({
				offset: 50,
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
				base64: binary.subarray(2, 5).toString("base64"),
				truncated: true,
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
});
