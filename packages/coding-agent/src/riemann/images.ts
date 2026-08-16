import { basename } from "node:path";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeType } from "../utils/mime.ts";
import { RiemannHostError } from "./errors.ts";
import type { JsonValue, KernelImageReference } from "./kernel/types.ts";
import type { ArtifactStore } from "./state/artifacts.ts";

export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

export interface StoredModelImage {
	artifact: JsonValue;
	reference: KernelImageReference;
	hints: string[];
}

function artifactHandle(value: JsonValue): string {
	if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.handle !== "string") {
		throw new RiemannHostError("artifact_error", "Image artifact creation returned an invalid handle");
	}
	return value.handle;
}

export async function storeModelImage(options: {
	artifacts: ArtifactStore;
	bytes: Uint8Array;
	claimedMimeType?: string;
	name?: string;
	detail?: KernelImageReference["detail"];
}): Promise<StoredModelImage> {
	if (options.bytes.byteLength === 0) throw new RiemannHostError("invalid_image", "Image data is empty");
	const detectedMimeType = detectSupportedImageMimeType(options.bytes);
	if (!detectedMimeType) {
		throw new RiemannHostError(
			"unsupported_media_type",
			`Unsupported or invalid image${options.claimedMimeType ? ` (${options.claimedMimeType})` : ""}`,
		);
	}
	if (options.bytes.byteLength > MAX_SOURCE_IMAGE_BYTES) {
		throw new RiemannHostError(
			"image_too_large",
			`Image is ${options.bytes.byteLength} bytes; maximum source size is ${MAX_SOURCE_IMAGE_BYTES} bytes`,
		);
	}
	const processed = await processImage(options.bytes, detectedMimeType, { autoResizeImages: true });
	if (!processed.ok) throw new RiemannHostError("image_decode_failed", processed.message);
	const normalizedBytes = Buffer.from(processed.data, "base64");
	const artifact = await options.artifacts.putBuffer(normalizedBytes, {
		name: options.name ? basename(options.name) : undefined,
		mimeType: processed.mimeType,
	});
	const handle = artifactHandle(artifact);
	const metadata = options.artifacts.getMetadata(handle);
	return {
		artifact,
		reference: {
			type: "image_ref",
			artifactHandle: handle,
			mimeType: processed.mimeType,
			byteLength: metadata.size,
			sha256: metadata.hash,
			...(options.detail ? { detail: options.detail } : {}),
		},
		hints: processed.hints,
	};
}

export function imageReadNote(mimeType: string, hints: readonly string[] = []): string {
	return [`Read image file [${mimeType}]`, ...hints].join("\n");
}
