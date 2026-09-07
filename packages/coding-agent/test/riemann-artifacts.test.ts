import { type FileHandle, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { JsonValue } from "../src/riemann/kernel/types.ts";
import { ArtifactStore } from "../src/riemann/state/artifacts.ts";
import { PageStore } from "../src/riemann/state/pages.ts";
import { OUTPUT_VIEW_MIME } from "../src/riemann/state/references.ts";
import { RiemannStore, type StoredAgent } from "../src/riemann/state/store.ts";

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

function childAgent(store: RiemannStore, parent: StoredAgent, name: string): StoredAgent {
	return store.createAgent({
		runId: parent.runId,
		parentId: parent.id,
		name,
		status: "idle",
		prompt: "",
		modelRole: "inherit",
		workspace: parent.workspace,
		workspaceMode: "shared",
		filesystem: parent.filesystem,
		network: parent.network,
		depth: 1,
		capabilities: ["fs.read"],
	});
}

describe("Riemann artifact storage", () => {
	test("authorizes short references by Agent grants and hides all internal media", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-artifact-grants-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("grants", root);
		const parent = store.ensureRootAgent(run.id, root);
		const source = childAgent(store, parent, "source");
		const peer = childAgent(store, parent, "peer");
		const system = new ArtifactStore(store, run.id);
		const childArtifacts = system.forAgent(source.id);
		const parentArtifacts = system.forAgent(parent.id);
		const peerArtifacts = system.forAgent(peer.id);
		try {
			const wire = await childArtifacts.putText("private payload");
			const ref = artifactHandle(wire);
			expect(ref).toBe("r1");
			const metadata = childArtifacts.getMetadata(ref);
			expect(metadata.handle).toMatch(/^artifact:\/\//);
			expect(store.getArtifact(ref)).toBeUndefined();
			expect(system.getMetadata(metadata.handle)).toEqual(metadata);
			expect(childArtifacts.open(ref)).toEqual(wire);
			expect(system.open(metadata.handle)).toEqual(wire);
			expect(() => peerArtifacts.getMetadata(ref)).toThrow("not granted");
			await expect(parentArtifacts.readBuffer(ref)).rejects.toMatchObject({ code: "permission_denied" });
			await expect(peerArtifacts.get(ref)).rejects.toMatchObject({ code: "permission_denied" });
			await expect(peerArtifacts.materialize(ref, join(root, "denied.txt"))).rejects.toMatchObject({
				code: "permission_denied",
			});
			for (const canonical of [metadata.handle, metadata.hash, metadata.path]) {
				expect(() => childArtifacts.getMetadata(canonical)).toThrow("Unknown short resource reference");
			}
			expect(() => peerArtifacts.grant(ref, parent.id)).toThrow("not granted");
			expect(() => childArtifacts.forAgent(peer.id)).toThrow("Cannot change the Agent");
			expect(() => childArtifacts.grantFromAgent(source.id, parent.id)).toThrow("Only the system");
			expect(() => system.grant("rzz", parent.id)).toThrow("Unknown short resource reference");
			const otherRun = store.openRun("other-grants", root);
			const other = store.ensureRootAgent(otherRun.id, root);
			expect(() => system.grant(ref, other.id)).toThrow("not present in this run");
			expect(() => system.forAgent(other.id)).toThrow("not present in this run");
			expect(() => new ArtifactStore(store, otherRun.id).grant(metadata.handle, other.id)).toThrow(
				"not present in this run",
			);
			system.grantFromAgent(source.id, parent.id);
			expect(await parentArtifacts.get(ref)).toMatchObject({ handle: ref, text: "private payload" });
			childArtifacts.grant(ref, peer.id);
			expect(await peerArtifacts.readBuffer(ref)).toEqual(Buffer.from("private payload"));
			// Re-registering identical content must not DELETE its reference or existing grants.
			expect(await childArtifacts.putText("private payload")).toEqual(wire);
			expect(peerArtifacts.open(ref)).toEqual(wire);
			const issue = vi.spyOn(store.references, "issue");
			expect(peerArtifacts.reference(ref)).toBe(ref);
			expect(await peerArtifacts.get(ref)).toMatchObject({ handle: ref });
			expect(issue).not.toHaveBeenCalled();
			issue.mockRestore();
			expect(await system.get(metadata.handle)).toMatchObject({ handle: ref });
			expect(await system.materialize(metadata.handle, join(root, "copy.txt"))).toMatchObject({ handle: ref });
			const systemRef = artifactHandle(await system.putText("system payload"));
			await expect(parentArtifacts.get(systemRef)).rejects.toMatchObject({ code: "permission_denied" });
			system.grant(systemRef, parent.id);
			expect(await parentArtifacts.get(systemRef)).toMatchObject({ handle: systemRef, text: "system payload" });
			for (const mimeType of [
				"application/vnd.riemann.page+json",
				"application/vnd.riemann.page-cursor+json",
				"application/vnd.riemann.output+json",
				"Application/Vnd.Riemann.Custom+Json; charset=utf-8",
			]) {
				const internal = artifactHandle(await childArtifacts.putText("internal manifest", { mimeType }));
				expect(await childArtifacts.readBuffer(internal)).toEqual(Buffer.from("internal manifest"));
				expect(() => childArtifacts.assertPublic(internal)).toThrow("Internal resources");
				expect(() => childArtifacts.open(internal)).toThrow("Internal resources");
				await expect(childArtifacts.get(internal)).rejects.toMatchObject({ code: "permission_denied" });
				await expect(childArtifacts.materialize(internal, join(root, "internal.txt"))).rejects.toMatchObject({
					code: "permission_denied",
				});
				system.grantFromAgent(source.id, parent.id);
				if (mimeType === OUTPUT_VIEW_MIME) {
					expect(parentArtifacts.getMetadata(internal).mimeType).toBe(OUTPUT_VIEW_MIME);
					expect(() => parentArtifacts.open(internal)).toThrow("Internal resources");
					await expect(parentArtifacts.get(internal)).rejects.toMatchObject({ code: "permission_denied" });
				} else expect(() => parentArtifacts.getMetadata(internal)).toThrow("not granted");
				expect(() => peerArtifacts.getMetadata(internal)).toThrow("not granted");
			}
		} finally {
			store.close();
		}
	});

	test("rejects UTF-8 continuation offsets and text limits that cannot progress", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-artifact-progress-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("artifact-progress", root);
		const artifacts = new ArtifactStore(store, run.id);
		try {
			const handle = artifactHandle(await artifacts.putText("😀x"));
			await expect(artifacts.get(handle, { offset: 1, limit: 4 })).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			await expect(artifacts.get(handle, { limit: 3 })).rejects.toMatchObject({ code: "invalid_arguments" });
			for (const offset of [2, 3, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
				await expect(artifacts.get(handle, { offset, limit: 4 })).rejects.toMatchObject({
					code: "invalid_arguments",
				});
			}
			const original = "\ufeffa😀中éz";
			const unicode = artifactHandle(await artifacts.putText(original));
			let offset = 0;
			let reconstructed = "";
			while (true) {
				const slice = await artifacts.get(unicode, { offset, limit: 4 });
				if (
					typeof slice !== "object" ||
					slice === null ||
					Array.isArray(slice) ||
					typeof slice.next_offset !== "number" ||
					typeof slice.text !== "string"
				)
					throw new Error("Invalid text slice");
				expect(slice).toMatchObject({ $riemann: "artifact_slice", kind: "text", offset });
				reconstructed += slice.text;
				if (slice.eof) break;
				expect(slice.next_offset).toBeGreaterThan(offset);
				offset = slice.next_offset;
			}
			expect(reconstructed).toBe(original);
			const malformed = artifactHandle(
				await artifacts.putBuffer(Buffer.from([97, 98, 99, 255, 100]), { mimeType: "text/plain" }),
			);
			await expect(artifacts.get(malformed, { limit: 4 })).rejects.toMatchObject({ code: "unsupported_media_type" });
			const incomplete = artifactHandle(
				await artifacts.putBuffer(Buffer.from([97, 0xf0]), { mimeType: "text/plain" }),
			);
			await expect(artifacts.get(incomplete)).rejects.toMatchObject({ code: "unsupported_media_type" });
			expect(await artifacts.materialize(handle, join(root, "output.txt"))).toMatchObject({
				$riemann: "materialized_artifact",
				handle,
				size: 5,
			});
		} finally {
			store.close();
		}
	});
	test("preserves text and binary range semantics", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-artifacts-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("artifact-ranges", root);
		const artifacts = new ArtifactStore(store, run.id);
		try {
			const textHandle = artifactHandle(await artifacts.putText("0123456789"));
			expect(await artifacts.get(textHandle, { offset: 3, limit: 4 })).toEqual({
				$riemann: "artifact_slice",
				kind: "text",
				handle: textHandle,
				mime_type: "text/plain; charset=utf-8",
				size: 10,
				offset: 3,
				next_offset: 7,
				text: "3456",
				eof: false,
			});
			await expect(artifacts.get(textHandle, { offset: -2, limit: 4 })).rejects.toMatchObject({
				code: "invalid_arguments",
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
				text: "",
				eof: true,
			});
			expect(await artifacts.get(textHandle, { offset: 7 })).toMatchObject({
				text: "789",
				eof: true,
			});

			const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
			const binaryHandle = artifactHandle(
				await artifacts.putBuffer(binary, { mimeType: "application/octet-stream" }),
			);
			expect(await artifacts.get(binaryHandle, { offset: 2, limit: 3 })).toEqual({
				$riemann: "artifact_slice",
				kind: "binary",
				handle: binaryHandle,
				mime_type: "application/octet-stream",
				size: binary.length,
				offset: 2,
				next_offset: 5,
				base64: binary.subarray(2, 5).toString("base64"),
				eof: false,
			});
		} finally {
			store.close();
		}
	});

	test("keeps metadata identity stable and returns complete UTF-8 code points", async () => {
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
			expect(first).toBe("r1");
			expect(second).toBe("r2");
			expect(first).not.toBe(second);
			expect(artifacts.getMetadata(first).name).toBe("first.txt");
			expect(artifacts.getMetadata(second).name).toBe("second.bin");
			await expect(artifacts.get(first, { offset: 0, limit: 3 })).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			expect(await artifacts.get(first, { offset: 0, limit: 4 })).toMatchObject({
				next_offset: 4,
				text: "😀",
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
				eof: true,
			});
		} finally {
			store.close();
		}
	});
	test("binds opaque page cursors to their owner, run, operation and bounded artifact snapshot", async () => {
		const root = await mkdtemp(join(tmpdir(), "riemann-page-cursor-"));
		roots.push(root);
		const store = new RiemannStore(join(root, ".agent"));
		const run = store.openRun("pages", root);
		const artifacts = new ArtifactStore(store, run.id);
		const pages = new PageStore(artifacts, "owner");
		const persisted = vi.spyOn(artifacts, "putText");
		try {
			expect(await pages.create("fs.glob", ["only"], { limit: 1, coverage: "complete" })).toEqual({
				$riemann: "page",
				items: ["only"],
				next_cursor: null,
				coverage: "complete",
				skipped: [],
			});
			expect(persisted).not.toHaveBeenCalled();
			const page = await pages.create("fs.glob", ["a", "b", "c"], { limit: 1, coverage: "complete" });
			if (typeof page !== "object" || page === null || Array.isArray(page) || typeof page.next_cursor !== "string")
				throw new Error("Missing page cursor");
			const cursor = page.next_cursor;
			expect(cursor).toMatch(/^r[1-9a-z][0-9a-z]*$/);
			await expect(artifacts.get(cursor)).rejects.toMatchObject({ code: "permission_denied" });
			const manifest = artifactHandle(await persisted.mock.results[0].value);
			const authorize = vi.fn();
			await expect(pages.next(manifest, authorize)).rejects.toMatchObject({ code: "invalid_arguments" });
			const ordinary = artifactHandle(
				await artifacts.putJson({
					handle: manifest,
					runId: run.id,
					ownerId: "owner",
					operation: "fs.glob",
					offset: 1,
					limit: 1,
				}),
			);
			await expect(pages.next(ordinary, authorize)).rejects.toMatchObject({ code: "invalid_arguments" });
			for (const forged of [`${cursor}x`, JSON.stringify({ handle: manifest, offset: 1, limit: 1 })]) {
				await expect(pages.next(forged, authorize)).rejects.toMatchObject({ code: "not_found" });
			}
			expect(authorize).not.toHaveBeenCalled();
			for (const change of [
				{ ownerId: "other" },
				{ runId: "other" },
				{ operation: "fs.remove" },
				{ offset: 0 },
				{ offset: 99 },
				{ offset: 1, limit: 2 },
				{ offset: 2, limit: 2 },
				{ limit: 0 },
				{ limit: 2 },
			]) {
				const altered = artifactHandle(
					await artifacts.putText(
						JSON.stringify({
							handle: manifest,
							runId: run.id,
							ownerId: "owner",
							operation: "fs.glob",
							offset: 1,
							limit: 1,
							...change,
						}),
						{ mimeType: "application/vnd.riemann.page-cursor+json" },
					),
				);
				await expect(pages.next(altered, () => {})).rejects.toMatchObject({ code: "invalid_arguments" });
			}
			const oversized = artifactHandle(
				await artifacts.putText(" ".repeat(4 * 1024 + 1), { mimeType: "application/vnd.riemann.page-cursor+json" }),
			);
			await expect(pages.next(oversized, authorize)).rejects.toMatchObject({ code: "response_too_large" });

			await expect(new PageStore(artifacts, "other-owner").next(cursor, authorize)).rejects.toMatchObject({
				code: "invalid_arguments",
			});
			const otherRun = store.openRun("other-pages", root);
			await expect(
				new PageStore(new ArtifactStore(store, otherRun.id), "owner").next(cursor, authorize),
			).rejects.toMatchObject({ code: "not_found" });
			await expect(
				pages.next(cursor, () => {
					throw new Error("permission revoked");
				}),
			).rejects.toThrow("permission revoked");
			const next = await new PageStore(new ArtifactStore(store, run.id), "owner").next(cursor, authorize);
			expect(next).toMatchObject({ items: ["b"], next_cursor: expect.any(String) });
			expect(await pages.next(cursor, authorize)).toEqual(next);
			expect(authorize).toHaveBeenCalledWith("fs.glob");
			const actor = store.ensureRootAgent(run.id, root);
			const actorArtifacts = artifacts.forAgent(actor.id);
			const actorPage = await new PageStore(actorArtifacts, actor.id).create("fs.glob", ["private-a", "private-b"], {
				limit: 1,
				coverage: "complete",
			});
			if (
				typeof actorPage !== "object" ||
				actorPage === null ||
				Array.isArray(actorPage) ||
				typeof actorPage.next_cursor !== "string"
			)
				throw new Error("Missing private cursor");
			const actorCursor = actorPage.next_cursor;
			const sibling = childAgent(store, actor, "sibling");
			await expect(
				new PageStore(artifacts.forAgent(sibling.id), actor.id).next(actorCursor, authorize),
			).rejects.toMatchObject({ code: "permission_denied" });
			expect(
				await new PageStore(new ArtifactStore(store, run.id).forAgent(actor.id), actor.id).next(
					actorCursor,
					authorize,
				),
			).toMatchObject({ items: ["private-b"], next_cursor: null });
			const path = artifacts.getMetadata(manifest).path;
			const file = await open(path, "r+");
			try {
				await file.truncate(64 * 1024 * 1024 + 1);
			} finally {
				await file.close();
			}
			await expect(pages.next(cursor, authorize)).rejects.toMatchObject({ code: "response_too_large" });
			await writeFile(path, '{"operation":"fs.remove"}');
			await expect(pages.next(cursor, authorize)).rejects.toMatchObject({ code: "invalid_arguments" });
		} finally {
			persisted.mockRestore();
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
