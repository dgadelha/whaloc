import type { JsonObject } from "../db/index.ts";

/** A value that is a JSON object, or `undefined` for anything else — arrays and `null` included. */
export function asJsonObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

/** A key holding a JSON object, or `undefined` when it is absent or not one. */
export function objectAt(payload: JsonObject, key: string): JsonObject | undefined {
	return asJsonObject(payload[key]);
}
