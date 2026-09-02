import { z, type ZodType } from "zod";

/** A JSON object column, kept opaque until a domain schema narrows it. */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

/** A JSON array-of-objects column (template components, contact cards, …). */
export const jsonObjectArraySchema = z.array(jsonObjectSchema);

export type JsonObject = z.infer<typeof jsonObjectSchema>;

/** Raised when a TEXT column does not hold the JSON its schema promises. */
export class JsonColumnError extends Error {
	readonly column: string;

	constructor(column: string, options?: { cause?: unknown }) {
		super(`column "${column}" does not hold the expected JSON`, options);
		this.name = "JsonColumnError";
		this.column = column;
	}
}

/** JSON columns are written through here so encoding lives next to decoding. */
export function encodeJsonColumn(value: unknown): string {
	return JSON.stringify(value);
}

/**
 * Reads a JSON column back through its zod schema (SPEC §6): a database written by an older
 * whaloc — or by hand — fails loudly at the repository instead of leaking a wrong shape into
 * a Meta envelope.
 */
export function decodeJsonColumn<T>(schema: ZodType<T>, raw: string, column: string): T {
	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new JsonColumnError(column, { cause: error });
	}

	const result = schema.safeParse(parsed);

	if (!result.success) {
		throw new JsonColumnError(column, { cause: result.error });
	}

	return result.data;
}

/** Same as {@link decodeJsonColumn}, for columns that are nullable. */
export function decodeNullableJsonColumn<T>(schema: ZodType<T>, raw: string | null, column: string): T | null {
	return raw === null ? null : decodeJsonColumn(schema, raw, column);
}
