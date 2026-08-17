/** Complete image markers inserted into the interactive editor. */
const IMAGE_MARKER_REGEX = /\[Image #(\d+)\]/g;

export function formatImageMarker(id: number): string {
	return `[Image #${id}]`;
}

/** Marker IDs present in text, in appearance order. */
export function imageMarkerIds(text: string): number[] {
	return [...text.matchAll(IMAGE_MARKER_REGEX)]
		.map((match) => Number(match[1]))
		.filter((id) => Number.isSafeInteger(id));
}

/** Resolve each marked image at most once while preserving paste order. */
export function collectMarkedImages<T>(images: ReadonlyMap<number, T>, text: string): T[] {
	if (images.size === 0) return [];

	const present = new Set(imageMarkerIds(text));
	const result: T[] = [];
	for (const [id, image] of images) {
		if (present.has(id)) result.push(image);
	}
	return result;
}

/** Evict oldest unreferenced images until the retained size is within budget. */
export function evictImagesToBudget<T>(
	images: Map<number, T>,
	sizeOf: (image: T) => number,
	maxBytes: number,
	keep: ReadonlySet<number>,
): void {
	let total = 0;
	for (const image of images.values()) total += sizeOf(image);

	for (const id of [...images.keys()]) {
		if (total <= maxBytes) break;
		if (keep.has(id)) continue;
		const image = images.get(id)!;
		total -= sizeOf(image);
		images.delete(id);
	}
}
