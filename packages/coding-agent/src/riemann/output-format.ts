export function outputReferenceFooter(
	ref: string,
	omitted = 0,
	side: "before" | "after" = "before",
	partial = false,
): string {
	return `[ref=${ref}${omitted ? `; ${omitted} UTF-8 bytes omitted ${side}` : ""}${partial ? "; partial line" : ""}]`;
}

/** Presentation only: model messages and saved history retain the original footer. */
export function compactOutputPreview(text: string): string {
	return text.replace(
		/\[ref=(r[0-9a-z]+)(?:; \d+ UTF-8 bytes omitted (?:before|after))?(?:; partial line|; structured preview)?\](?=\n|$)/g,
		(_match, ref: string) => `[ref ${ref}]`,
	);
}
