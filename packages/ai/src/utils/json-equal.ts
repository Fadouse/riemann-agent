function omittedByJson(value: unknown): boolean {
	return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** Compare plain JSON request values without serializing opaque payloads.
 * Non-JSON values may conservatively compare unequal, causing a full request.
 */
export function jsonValuesEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left === "number" && !Number.isFinite(left)) left = null;
	if (typeof right === "number" && !Number.isFinite(right)) right = null;
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index++) {
			if (
				!jsonValuesEqual(
					omittedByJson(left[index]) ? null : left[index],
					omittedByJson(right[index]) ? null : right[index],
				)
			)
				return false;
		}
		return true;
	}
	// Provider requests are plain JSON. Fall back for custom objects supplied by onPayload.
	const leftPrototype: unknown = Object.getPrototypeOf(left);
	const rightPrototype: unknown = Object.getPrototypeOf(right);
	if (
		typeof (left as { toJSON?: unknown }).toJSON === "function" ||
		typeof (right as { toJSON?: unknown }).toJSON === "function" ||
		(leftPrototype !== Object.prototype && leftPrototype !== null) ||
		(rightPrototype !== Object.prototype && rightPrototype !== null)
	)
		return JSON.stringify(left) === JSON.stringify(right);
	const a = left as Record<string, unknown>;
	const b = right as Record<string, unknown>;
	const aKeys = Object.keys(a).filter((key) => !omittedByJson(a[key]));
	const bKeys = Object.keys(b).filter((key) => !omittedByJson(b[key]));
	if (aKeys.length !== bKeys.length) return false;
	for (let index = 0; index < aKeys.length; index++) {
		// Keep the existing JSON.stringify comparison's property-order behavior.
		const key = aKeys[index];
		if (key !== bKeys[index] || !jsonValuesEqual(a[key], b[key])) return false;
	}
	return true;
}
