import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RiemannHostError } from "../errors.ts";
import type { JsonValue } from "../kernel/types.ts";
import { resourceKind } from "./references.ts";
import type { RiemannStore, StoredArtifact } from "./store.ts";

const MAX_ARTIFACT_SLICE_BYTES = 1024 * 1024;

function wireArtifact(artifact: StoredArtifact, handle: string): JsonValue {
	return {
		$riemann: "artifact",
		handle,
		mime_type: artifact.mimeType,
		size: artifact.size,
		name: artifact.name,
	};
}

export class ArtifactStore {
	private readonly store: RiemannStore;
	private readonly runId: string;
	private readonly agentId: string | undefined;

	constructor(store: RiemannStore, runId: string, agentId?: string) {
		this.store = store;
		this.runId = runId;
		this.agentId = agentId;
		if (agentId !== undefined) store.references.assertAgent(runId, agentId);
	}

	forAgent(agentId: string): ArtifactStore {
		if (this.agentId !== undefined && this.agentId !== agentId) {
			throw new RiemannHostError("permission_denied", "Cannot change the Agent of a scoped artifact store");
		}
		return new ArtifactStore(this.store, this.runId, agentId);
	}

	grant(handle: string, agentId: string): void {
		this.store.references.grant(this.runId, this.reference(handle), agentId, this.agentId);
	}

	grantFromAgent(sourceId: string, targetId: string): void {
		if (this.agentId !== undefined) {
			throw new RiemannHostError("permission_denied", "Only the system artifact store may transfer Agent resources");
		}
		this.store.references.grantFromAgent(this.runId, sourceId, targetId);
	}

	reference(handle: string): string {
		const artifact = this.getMetadata(handle);
		// Reading an existing scoped reference must never recreate a revoked grant.
		if (this.agentId !== undefined) return handle;
		return this.store.references.issue(this.runId, artifact.handle, resourceKind(artifact.mimeType)).shortRef;
	}

	assertPublic(handle: string): StoredArtifact {
		const artifact = this.getMetadata(handle);
		if (resourceKind(artifact.mimeType) !== "artifact") {
			throw new RiemannHostError("permission_denied", "Internal resources cannot be opened as public artifacts");
		}
		return artifact;
	}

	open(handle: string): JsonValue {
		return wireArtifact(this.assertPublic(handle), this.reference(handle));
	}

	async putText(text: string, options: { name?: string; mimeType?: string } = {}): Promise<JsonValue> {
		return this.putBuffer(Buffer.from(text), {
			name: options.name,
			mimeType: options.mimeType ?? "text/plain; charset=utf-8",
		});
	}

	async putJson(value: JsonValue, name?: string): Promise<JsonValue> {
		return this.putText(`${JSON.stringify(value, null, 2)}\n`, { name, mimeType: "application/json" });
	}

	async putBuffer(data: Buffer, options: { name?: string; mimeType: string }): Promise<JsonValue> {
		const hash = createHash("sha256").update(data).digest("hex");
		return this.putKnownData([data], hash, data.length, options);
	}

	private async putKnownData(
		chunks: Iterable<string | Uint8Array>,
		hash: string,
		size: number,
		options: { name?: string; mimeType: string },
	): Promise<JsonValue> {
		const directory = join(this.store.artifactsDir, "sha256", hash.slice(0, 2));
		const path = join(directory, hash);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		let created = false;
		try {
			await access(path, constants.F_OK);
		} catch {
			const temporary = join(directory, `.${hash}.${process.pid}.${randomUUID()}.tmp`);
			try {
				const file = await open(temporary, "wx", 0o600);
				try {
					await writeFile(file, chunks);
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temporary, path).catch(async (error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				});
				created = true;
			} finally {
				await rm(temporary, { force: true });
			}
		}
		if (created) {
			try {
				const directoryHandle = await open(directory, constants.O_RDONLY);
				try {
					await directoryHandle.sync();
				} finally {
					await directoryHandle.close();
				}
			} catch {
				// Directory fsync is unavailable on some supported platforms.
			}
		}
		return this.registerArtifact(hash, size, path, options);
	}

	/** Persist complete text without joining the parts into another full-sized string. */
	async putTextParts(
		parts: readonly string[],
		options: { name?: string; mimeType?: string } = {},
	): Promise<JsonValue> {
		const sourceParts = parts.slice();
		function* textChunks(): Generator<string> {
			let pending = "";
			for (const part of sourceParts) {
				if (part.length === 0) continue;
				const text = pending + part;
				let end = text.length;
				const last = text.charCodeAt(end - 1);
				pending = last >= 0xd800 && last <= 0xdbff ? text.slice(--end) : "";
				for (let offset = 0; offset < end; ) {
					let next = Math.min(end, offset + 65_536);
					const boundary = text.charCodeAt(next - 1);
					if (next < end && boundary >= 0xd800 && boundary <= 0xdbff) next--;
					yield text.slice(offset, next);
					offset = next;
				}
			}
			if (pending) yield pending;
		}
		// Text parts are replayable. Hash before writing so repeated output keeps
		// the existing content-addressed fast path, without a full encoded copy.
		const digest = createHash("sha256");
		let size = 0;
		for (const chunk of textChunks()) {
			digest.update(chunk);
			size += Buffer.byteLength(chunk);
		}
		return this.putKnownData(textChunks(), digest.digest("hex"), size, {
			name: options.name,
			mimeType: options.mimeType ?? "text/plain; charset=utf-8",
		});
	}

	/** Hash and persist every chunk; chunking does not limit artifact size. */
	async putStream(
		chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
		options: { name?: string; mimeType: string },
	): Promise<JsonValue> {
		await mkdir(this.store.artifactsDir, { recursive: true, mode: 0o700 });
		const temporary = join(this.store.artifactsDir, `.stream.${process.pid}.${randomUUID()}.tmp`);
		const digest = createHash("sha256");
		let size = 0;
		async function* recordedChunks(): AsyncGenerator<Uint8Array> {
			for await (const chunk of chunks) {
				digest.update(chunk);
				size += chunk.byteLength;
				yield chunk;
			}
		}
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await writeFile(file, recordedChunks());
				await file.sync();
			} finally {
				await file.close();
			}
			const hash = digest.digest("hex");
			const directory = join(this.store.artifactsDir, "sha256", hash.slice(0, 2));
			const path = join(directory, hash);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			try {
				await access(path, constants.F_OK);
			} catch {
				await rename(temporary, path).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "EEXIST") throw error;
				});
				try {
					const directoryHandle = await open(directory, constants.O_RDONLY);
					try {
						await directoryHandle.sync();
					} finally {
						await directoryHandle.close();
					}
				} catch {
					// Directory fsync is unavailable on some supported platforms.
				}
			}
			return this.registerArtifact(hash, size, path, options);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private registerArtifact(
		hash: string,
		size: number,
		path: string,
		options: { name?: string; mimeType: string },
	): JsonValue {
		const metadataHash = createHash("sha256")
			.update(options.mimeType)
			.update("\0")
			.update(options.name ?? "")
			.digest("hex")
			.slice(0, 16);
		const artifact: StoredArtifact = {
			handle: `artifact://${this.runId}/${hash}-${metadataHash}`,
			runId: this.runId,
			hash,
			mimeType: options.mimeType,
			size,
			name: options.name ?? null,
			path,
			createdAt: new Date().toISOString(),
		};
		this.store.putArtifact(artifact);
		const reference = this.store.references.issue(
			this.runId,
			artifact.handle,
			resourceKind(artifact.mimeType),
			this.agentId,
		);
		return wireArtifact(artifact, reference.shortRef);
	}

	getMetadata(handle: string): StoredArtifact {
		const resourceId =
			this.agentId === undefined && handle.startsWith("artifact://")
				? handle
				: this.store.references.resolve(this.runId, handle, this.agentId).resourceId;
		const artifact = this.store.getArtifact(resourceId);
		if (!artifact || artifact.runId !== this.runId)
			throw new RiemannHostError("not_found", "Artifact is not present in this run");
		return artifact;
	}

	async readBuffer(handle: string, maximumBytes?: number): Promise<Buffer> {
		const artifact = this.getMetadata(handle);
		if (maximumBytes === undefined) return readFile(artifact.path);
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
			throw new RiemannHostError("invalid_arguments", "Artifact byte bound must be a non-negative safe integer");
		}
		const file = await open(artifact.path, "r");
		try {
			const size = (await file.stat()).size;
			if (artifact.size > maximumBytes || size > maximumBytes) {
				throw new RiemannHostError("response_too_large", "Artifact exceeds the bounded read limit");
			}
			const data = Buffer.allocUnsafe(size + 1);
			let length = 0;
			while (length < data.length) {
				const { bytesRead } = await file.read(data, length, data.length - length, length);
				if (bytesRead === 0) break;
				length += bytesRead;
			}
			if (length !== size) throw new RiemannHostError("artifact_error", "Artifact changed during bounded read");
			return data.subarray(0, length);
		} finally {
			await file.close();
		}
	}

	async get(handle: string, options: { offset?: number; limit?: number } = {}): Promise<JsonValue> {
		const artifact = this.assertPublic(handle);
		const shortRef = this.reference(handle);
		const isText =
			artifact.mimeType.startsWith("text/") ||
			artifact.mimeType.includes("json") ||
			artifact.mimeType.includes("xml");
		const offset = options.offset ?? 0;
		const limit = options.limit ?? 65_536;
		const minimum = isText ? 4 : 1;
		if (!Number.isSafeInteger(offset) || offset < 0) {
			throw new RiemannHostError("invalid_arguments", "Artifact offset must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(limit) || limit < minimum || limit > MAX_ARTIFACT_SLICE_BYTES) {
			throw new RiemannHostError(
				"invalid_arguments",
				`Artifact slice limit must be an integer from ${minimum} to ${MAX_ARTIFACT_SLICE_BYTES}`,
			);
		}
		const file = await open(artifact.path, "r");
		try {
			const fileSize = (await file.stat()).size;
			const readStart = Math.min(fileSize, offset);
			const data = Buffer.allocUnsafe(Math.min(fileSize - readStart, limit));
			let bytesRead = 0;
			while (bytesRead < data.length) {
				const result = await file.read(data, bytesRead, data.length - bytesRead, readStart + bytesRead);
				if (result.bytesRead === 0) break;
				bytesRead += result.bytesRead;
			}
			const slice = data.subarray(0, bytesRead);
			let nextOffset = readStart + bytesRead;
			let text: string | undefined;
			if (isText) {
				if (slice.length > 0 && (slice[0] & 0xc0) === 0x80) {
					throw new RiemannHostError(
						"invalid_arguments",
						"Artifact text offset must be a UTF-8 code-point boundary",
					);
				}
				try {
					text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(slice, {
						stream: nextOffset < fileSize,
					});
					nextOffset = readStart + Buffer.byteLength(text);
				} catch {
					throw new RiemannHostError("unsupported_media_type", "Artifact text is not valid UTF-8");
				}
			}
			if (nextOffset < fileSize && nextOffset <= readStart) {
				throw new RiemannHostError("artifact_error", "Artifact slice could not make progress");
			}
			return {
				$riemann: "artifact_slice",
				kind: isText ? "text" : "binary",
				handle: shortRef,
				mime_type: artifact.mimeType,
				size: artifact.size,
				offset: readStart,
				next_offset: nextOffset,
				eof: nextOffset >= fileSize,
				...(isText ? { text: text ?? "" } : { base64: slice.toString("base64") }),
			};
		} finally {
			await file.close();
		}
	}

	async materialize(handle: string, destination: string): Promise<JsonValue> {
		const artifact = this.assertPublic(handle);
		const shortRef = this.reference(handle);
		await mkdir(dirname(destination), { recursive: true });
		const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			await copyFile(artifact.path, temporary);
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
		const info = await stat(destination);
		return { $riemann: "materialized_artifact", path: destination, size: info.size, handle: shortRef };
	}
}
