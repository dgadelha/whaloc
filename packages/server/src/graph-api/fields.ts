/**
 * The Graph API's `fields` query parameter (SPEC §2, rows 1–4, 8).
 *
 * Two documented simplifications:
 *
 * - **Unknown fields are ignored**, where Meta answers `(#100) Tried accessing nonexisting
 *   field`. Ignoring keeps a consumer that asks for a field whaloc does not model (say
 *   `account_mode`) working instead of failing the whole call, which is what a local emulator
 *   should do.
 * - **Nested selectors are flattened**: `throughput{level}` selects `throughput` whole. whaloc
 *   models no field deep enough for the distinction to matter.
 */

/** Meta always returns `id` on a node read, even when `fields` leaves it out. */
const ALWAYS_INCLUDED_FIELD = "id";

/** `null` when no projection was asked for, which means "every field this object has". */
export function parseFields(raw: string | undefined): string[] | null {
	if (raw === undefined) {
		return null;
	}

	const fields = raw
		.split(",")
		.map(field => field.trim().split("{", 1)[0]?.trim() ?? "")
		.filter(field => field.length > 0);

	return fields.length === 0 ? null : fields;
}

/** Narrows a fully-populated node to the requested fields, `id` always included. */
export function projectFields(
	node: Readonly<Record<string, unknown>>,
	fields: readonly string[] | null,
): Record<string, unknown> {
	if (fields === null) {
		return { ...node };
	}

	const projected: Record<string, unknown> = {};

	for (const field of fields) {
		if (field !== ALWAYS_INCLUDED_FIELD && Object.hasOwn(node, field)) {
			projected[field] = node[field];
		}
	}

	if (Object.hasOwn(node, ALWAYS_INCLUDED_FIELD)) {
		projected[ALWAYS_INCLUDED_FIELD] = node[ALWAYS_INCLUDED_FIELD];
	}

	return projected;
}
