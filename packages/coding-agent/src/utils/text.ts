const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Return the longest grapheme-aligned prefix bounded by a UTF-16 code unit limit. */
export function graphemeSafePrefix(text: string, maxUnits: number): string {
	if (text.length <= maxUnits) return text;
	if (!(maxUnits > 0)) return "";
	let end = 0;
	for (const { index, segment } of graphemeSegmenter.segment(text)) {
		const nextEnd = index + segment.length;
		if (nextEnd > maxUnits) break;
		end = nextEnd;
	}
	return text.slice(0, end);
}

/** Return the longest grapheme-aligned suffix bounded by a UTF-16 code unit limit. */
export function graphemeSafeSuffix(text: string, maxUnits: number): string {
	if (text.length <= maxUnits) return text;
	if (!(maxUnits > 0)) return "";
	const minimumStart = text.length - maxUnits;
	for (const { index } of graphemeSegmenter.segment(text)) {
		if (index >= minimumStart) return text.slice(index);
	}
	return "";
}

/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
export function stripBom(content: string): string {
	return splitBom(content).text;
}
