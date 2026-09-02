import type { JsonObject } from "../db/index.ts";

/**
 * Reading the variable slots out of a stored template's components (SPEC §2).
 *
 * A template declares its placeholders inside the `text` of its `HEADER` and `BODY`
 * components: `{{1}}`, `{{2}}` for `parameter_format: "POSITIONAL"` templates and
 * `{{customer_name}}` for `NAMED` ones. Sends are validated against exactly these lists.
 */

/** `{{1}}` / `{{ customer_name }}` — Meta allows surrounding whitespace inside the braces. */
const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/** The two components whose text can carry placeholders; keys match Meta's `details` wording. */
export const PLACEHOLDER_COMPONENTS = ["header", "body"] as const;

export type PlaceholderComponent = (typeof PLACEHOLDER_COMPONENTS)[number];

export type TemplatePlaceholders = Record<PlaceholderComponent, string[]>;

/**
 * Every placeholder in a string, in the order it first appears and without repeats: a body
 * reading `Hi {{name}}, see you {{day}} — yes, {{name}}` takes two parameters, not three.
 */
export function extractPlaceholders(text: string): string[] {
	const names: string[] = [];

	for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
		const name = match[1];

		if (name !== undefined && !names.includes(name)) {
			names.push(name);
		}
	}

	return names;
}

function stringField(component: JsonObject, key: string): string | undefined {
	const value = component[key];

	return typeof value === "string" ? value : undefined;
}

/**
 * A header only takes text parameters when it is a text header. `format` is `TEXT` on those
 * and `IMAGE`/`VIDEO`/`DOCUMENT`/`LOCATION` on media ones, where the send instead carries a
 * media parameter that has nothing to count.
 */
function isTextComponent(component: JsonObject, type: PlaceholderComponent): boolean {
	const format = stringField(component, "format")?.toUpperCase();

	return type === "body" || format === undefined || format === "TEXT";
}

/** Stored templates spell component types in upper case, sends in lower case. */
function placeholderComponentOf(component: JsonObject): PlaceholderComponent | undefined {
	const type = stringField(component, "type")?.toLowerCase();

	return PLACEHOLDER_COMPONENTS.find(candidate => candidate === type);
}

/**
 * The placeholders a stored template expects, per component. A component that exists but
 * declares no placeholder maps to an empty list, which is what makes "you sent 2 parameters
 * for a body that takes none" an error rather than a silent pass.
 */
export function templatePlaceholders(components: readonly JsonObject[]): TemplatePlaceholders {
	const placeholders: TemplatePlaceholders = { header: [], body: [] };

	for (const component of components) {
		const type = placeholderComponentOf(component);
		const text = stringField(component, "text");

		if (type !== undefined && text !== undefined && isTextComponent(component, type)) {
			placeholders[type] = extractPlaceholders(text);
		}
	}

	return placeholders;
}
