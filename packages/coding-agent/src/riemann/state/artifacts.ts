import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RiemannHostError } from "../errors.ts";
import type { JsonValue } from "../kernel/types.ts";
import type { RiemannStore, StoredArtifact } from "./store.ts";

const MAX_ARTIFACT_SLICE_BYTES = 1024 * 1024;

function wireArtifact(artifact: StoredArtifact): JsonValue {
	return {
		$riemann: "artifact.v1",
		handle: artifact.handle,
		mime_type: artifact.mimeType,
		size: artifact.size,
		name: artifact.name,
	};
}

export class ArtifactStore {
	private readonly store: RiemannStore;
	private readonly runId: string;

	constructor(store: RiemannStore, runId: string) {
		this.store = store;
		this.runId = runId;
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
					await file.writeFile(data);
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
			size: data.length,
			name: options.name ?? null,
			path,
			createdAt: new Date().toISOString(),
		};
		this.store.putArtifact(artifact);
		return wireArtifact(artifact);
	}

	getMetadata(handle: string): StoredArtifact {
		const artifact = this.store.getArtifact(handle);
		if (!artifact || artifact.runId !== this.runId)
			throw new RiemannHostError("not_found", `Artifact not found: ${handle}`);
		return artifact;
	}

	async readBuffer(handle: string): Promise<Buffer> {
		const artifact = this.getMetadata(handle);
		return readFile(artifact.path);
	}

	async get(handle: string, options: { offset?: number; limit?: number } = {}): Promise<JsonValue> {
		const artifact = this.getMetadata(handle);
		const file = await open(artifact.path, "r");
		try {
			const fileSize = (await file.stat()).size;
			const offset = Math.max(0, options.offset ?? 0);
			const limit = options.limit ?? 65_536;
			if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_SLICE_BYTES) {
				throw new RiemannHostError(
					"invalid_arguments",
					`Artifact slice limit must be an integer from 1 to ${MAX_ARTIFACT_SLICE_BYTES}`,
				);
			}
			const end = Math.min(fileSize, offset + Math.max(0, limit));
			const readStart = Math.min(fileSize, Number.isNaN(offset) ? 0 : Math.trunc(offset));
			const readEnd = Math.min(fileSize, Number.isNaN(end) ? 0 : Math.trunc(end));
			const data = Buffer.allocUnsafe(Math.max(0, readEnd - readStart));
			let bytesRead = 0;
			while (bytesRead < data.length) {
				const result = await file.read(data, bytesRead, data.length - bytesRead, readStart + bytesRead);
				if (result.bytesRead === 0) break;
				bytesRead += result.bytesRead;
			}
			let slice = bytesRead === data.length ? data : data.subarray(0, bytesRead);
			let actualStart = readStart;
			let actualEnd = readStart + slice.byteLength;
			if (
				artifact.mimeType.startsWith("text/") ||
				artifact.mimeType.includes("json") ||
				artifact.mimeType.includes("xml")
			) {
				while (slice.length > 0 && (slice[0] ?? 0) >= 0x80 && (slice[0] ?? 0) < 0xc0) {
					slice = slice.subarray(1);
					actualStart += 1;
				}
				let content: string | undefined;
				for (let trim = 0; trim <= Math.min(3, slice.length); trim += 1) {
					try {
						content = new TextDecoder("utf-8", { fatal: true }).decode(slice.subarray(0, slice.length - trim));
						actualEnd -= trim;
						break;
					} catch {}
				}
				if (content === undefined)
					throw new RiemannHostError("unsupported_media_type", "Artifact text is not valid UTF-8");
				return {
					handle,
					mime_type: artifact.mimeType,
					size: artifact.size,
					offset: actualStart,
					next_offset: actualEnd,
					content,
					truncated: actualEnd < fileSize,
				};
			}
			return {
				handle,
				mime_type: artifact.mimeType,
				size: artifact.size,
				offset: actualStart,
				next_offset: actualEnd,
				base64: slice.toString("base64"),
				truncated: actualEnd < fileSize,
			};
		} finally {
			await file.close();
		}
	}

	async materialize(handle: string, destination: string): Promise<JsonValue> {
		const artifact = this.getMetadata(handle);
		await mkdir(dirname(destination), { recursive: true });
		const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			await copyFile(artifact.path, temporary);
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
		const info = await stat(destination);
		return { path: destination, size: info.size, handle };
	}
}
