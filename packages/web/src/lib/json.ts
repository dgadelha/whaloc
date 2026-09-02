import type { JsonObject } from "@whaloc/shared";

/**
 * Message payloads and template components are `Record<string, unknown>` by contract — they
 * are whatever Meta's node was — so reading them needs narrowing rather than casting. These
 * are the four questions the renderers ask.
 */

export function asRecord(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads `payload.image.caption` and friends without a cast at every level. */
export function readString(source: unknown, ...path: string[]): string | null {
	let current: unknown = source;

	for (const key of path) {
		current = asRecord(current)?.[key];
	}

	return asString(current);
}

/** `undefined` has no JSON form; showing `null` beats showing an empty block. */
export function pretty(value: unknown): string {
	return JSON.stringify(value ?? null, null, 2);
}

/** Pretty-prints a JSON string, leaving it alone when it is not JSON (or is empty). */
export function prettyJsonText(text: string): string {
	if (text.trim() === "") {
		return "";
	}

	try {
		return pretty(JSON.parse(text));
	} catch {
		return text;
	}
}
