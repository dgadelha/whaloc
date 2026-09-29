import type { JsonObject, TemplateRecord } from "../db/index.ts";
import {
	jsonSchemaRequiredError,
	mandatoryParameterError,
	missingParameterObjectError,
	requiredParameterMissingError,
	templateHeaderFormatMismatchError,
	templateNotFoundError,
	templateParameterIssueError,
	templateParameterMismatchError,
} from "./meta-errors.ts";
import { asJsonObject, objectAt } from "./json-object.ts";
import {
	extractPlaceholders,
	PLACEHOLDER_COMPONENTS,
	templatePlaceholders,
	type PlaceholderComponent,
} from "./template-placeholders.ts";

/**
 * Validating a `template` send against the stored template (SPEC §2).
 *
 * Only localizable parameters are counted — `text`, `currency` and `date_time`, the three a
 * placeholder can take, and what Meta's own `details` calls `localizable_params`. A media
 * header's `{type:"image", image:{…}}` counts toward nothing, as its stored counterpart declares
 * no placeholders; it is held to its own rules instead, by {@link assertHeaderFormat}.
 */

const LOCALIZABLE_TYPES: ReadonlySet<string> = new Set(["text", "currency", "date_time"]);

interface TextParameter {
	parameterName: string | undefined;
}

function stringField(value: JsonObject, key: string): string | undefined {
	const field = value[key];

	return typeof field === "string" ? field : undefined;
}

function parametersOf(component: JsonObject): JsonObject[] {
	const parameters = component["parameters"];

	if (!Array.isArray(parameters)) {
		return [];
	}

	return parameters.filter(parameter => typeof parameter === "object" && parameter !== null) as JsonObject[];
}

/**
 * The localizable parameters a send provides for one component. A parameter is one when its
 * `type` says so, or when it carries a `text` field and no `type` at all — Meta accepts the
 * shorthand.
 */
function textParametersOf(components: readonly JsonObject[], component: PlaceholderComponent): TextParameter[] {
	const provided: TextParameter[] = [];

	for (const sent of components) {
		if (stringField(sent, "type")?.toLowerCase() !== component) {
			continue;
		}

		for (const parameter of parametersOf(sent)) {
			const type = stringField(parameter, "type")?.toLowerCase();

			if (
				(type !== undefined && LOCALIZABLE_TYPES.has(type)) ||
				(type === undefined && stringField(parameter, "text") !== undefined)
			) {
				provided.push({ parameterName: stringField(parameter, "parameter_name") });
			}
		}
	}

	return provided;
}

function countMismatchDetails(component: PlaceholderComponent, provided: number, expected: number): string {
	return `${component}: number of localizable_params (${String(provided)}) does not match the expected number of params (${String(expected)})`;
}

/**
 * `parameter_format: "NAMED"` templates address their placeholders by name, so a send with the
 * right *count* can still be wrong. Meta answers both cases with a `(#100)` that names no
 * component (captured): a parameter without a `parameter_name` first, then the first declared
 * placeholder no parameter names. A name the template does not declare is never reported itself —
 * with the counts equal, it always leaves a declared one unnamed.
 */
function assertNamedParameters(expected: readonly string[], provided: readonly TextParameter[]): void {
	if (provided.some(parameter => parameter.parameterName === undefined || parameter.parameterName === "")) {
		throw mandatoryParameterError("Parameter name is missing or empty");
	}

	const providedNames = new Set(provided.map(parameter => parameter.parameterName));
	const missing = expected.find(name => !providedNames.has(name));

	if (missing !== undefined) {
		throw mandatoryParameterError(`Parameter name is missing for the parameter '{{${missing}}}'`);
	}
}

/**
 * Checks that a template can be sent at all: it must exist for the WABA behind the phone
 * number, in the requested language, and be `APPROVED` (SPEC §2). All three failures are the
 * same 132001 envelope, distinguished only by `details`.
 */
export function assertTemplateIsSendable(
	template: TemplateRecord | null,
	name: string,
	language: string,
): asserts template is TemplateRecord {
	if (template === null) {
		throw templateNotFoundError(`template name (${name}) does not exist in ${language}`);
	}

	if (template.status !== "APPROVED") {
		throw templateNotFoundError(`template name (${name}) is not approved in ${language}`);
	}
}

/**
 * The fields Meta's request schema requires of a parameter's object, in the order its error
 * lists them (captured); a location's `name` and `address` are optional.
 */
const REQUIRED_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
	["currency", ["fallback_value", "code", "amount_1000"]],
	["date_time", ["fallback_value"]],
	["location", ["longitude", "latitude"]],
]);

/**
 * A `currency`, `date_time` or `location` parameter has to carry its object, and the object its
 * required fields. Both answers are captured from Meta: the `(#100)` for a missing object, and for missing
 * fields a request-schema error that names the object by its position in the send.
 */
function assertParameterObject(parameter: JsonObject, path: string): void {
	const type = stringField(parameter, "type")?.toLowerCase();
	const required = type === undefined ? undefined : REQUIRED_FIELDS.get(type);

	if (type === undefined || required === undefined) {
		return;
	}

	const value = objectAt(parameter, type);

	if (value === undefined) {
		throw missingParameterObjectError(type);
	}

	const missing = required.filter(field => value[field] === undefined);

	if (missing.length > 0) {
		throw jsonSchemaRequiredError(`${path}.${type}`, missing);
	}
}

/**
 * A body `text` parameter has to carry its text: Meta's `(#100)` for one without it is captured,
 * and reads without the component prefix a button's own version of it carries.
 */
function assertBodyText(parameter: JsonObject): void {
	if (stringField(parameter, "type")?.toLowerCase() === "text" && stringField(parameter, "text") === undefined) {
		throw mandatoryParameterError("Parameter 'text' is mandatory for component parameter type 'text'");
	}
}

function assertParameterObjects(components: readonly JsonObject[]): void {
	for (const [componentIndex, component] of components.entries()) {
		const isBody = stringField(component, "type")?.toLowerCase() === "body";

		for (const [parameterIndex, parameter] of parametersOf(component).entries()) {
			if (isBody) {
				assertBodyText(parameter);
			}

			assertParameterObject(
				parameter,
				`template.components.${String(componentIndex)}.parameters.${String(parameterIndex)}`,
			);
		}
	}
}

const MEDIA_HEADER_FORMATS: ReadonlySet<string> = new Set(["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]);
/** The media types whose object must name an uploaded media ID or a link. */
const REFERENCED_MEDIA_TYPES: ReadonlySet<string> = new Set(["image", "video", "document"]);

/**
 * A media header has to be sent with the media it was created for. Meta's `details` reads
 * `header: Format mismatch, expected IMAGE, received UNKNOWN` for a send that attached nothing,
 * and names the type — `received VIDEO` — for one that attached the wrong kind (both captured).
 * A parameter that names a media type without carrying that object is refused before either,
 * as the `(#100)` Meta answers it with, and one whose object names neither `id` nor `link` next,
 * as its 132018 — all captured; only the relative order of the last two is inferred.
 */
function assertHeaderFormat(template: TemplateRecord, components: readonly JsonObject[]): void {
	const header = template.components.find(component => stringField(component, "type")?.toUpperCase() === "HEADER");
	const expected = header === undefined ? undefined : stringField(header, "format")?.toUpperCase();

	if (expected === undefined || !MEDIA_HEADER_FORMATS.has(expected)) {
		return;
	}

	const sent = components.find(component => stringField(component, "type")?.toLowerCase() === "header");
	const parameter = sent === undefined ? undefined : parametersOf(sent)[0];
	const type = parameter === undefined ? undefined : stringField(parameter, "type")?.toLowerCase();

	if (parameter !== undefined && type !== undefined && MEDIA_HEADER_FORMATS.has(type.toUpperCase())) {
		const reference = objectAt(parameter, type);

		if (reference === undefined) {
			throw missingParameterObjectError(type);
		}

		if (
			REFERENCED_MEDIA_TYPES.has(type) &&
			stringField(reference, "id") === undefined &&
			stringField(reference, "link") === undefined
		) {
			throw templateParameterIssueError("Either one of media ID or link must be present");
		}
	}

	const received = type?.toUpperCase() ?? "UNKNOWN";

	if (received !== expected) {
		throw templateHeaderFormatMismatchError(`header: Format mismatch, expected ${expected}, received ${received}`);
	}
}

/** Meta takes a button's `index` as a string or a number; both name the same slot. */
function indexOf(component: JsonObject): number | undefined {
	const index = component["index"];

	if (typeof index === "number") {
		return index;
	}

	return typeof index === "string" && /^\d+$/.test(index) ? Number(index) : undefined;
}

/**
 * A URL button whose `url` ends in a placeholder takes its suffix from the send, as a `button`
 * component with `sub_type: "url"` and that button's `index`. Meta's 131008 names the button
 * by its position and spells the type `Url`; a component at that index with another `sub_type`
 * is its 132018 instead (both captured).
 */
function assertButtonParameters(template: TemplateRecord, components: readonly JsonObject[]): void {
	const buttons = template.components.find(component => stringField(component, "type")?.toUpperCase() === "BUTTONS");
	const definitions = Array.isArray(buttons?.["buttons"]) ? buttons["buttons"] : [];

	for (const [index, definition] of definitions.entries()) {
		const button = asJsonObject(definition);
		const url = button === undefined ? undefined : stringField(button, "url");

		if (
			button === undefined ||
			url === undefined ||
			stringField(button, "type")?.toUpperCase() !== "URL" ||
			extractPlaceholders(url).length === 0
		) {
			continue;
		}

		const sent = components.find(
			component => stringField(component, "type")?.toLowerCase() === "button" && indexOf(component) === index,
		);

		const subtype = sent === undefined ? undefined : stringField(sent, "sub_type")?.toLowerCase();

		// An absent `sub_type` is left alone: only one that names another kind was captured.
		if (subtype !== undefined && subtype !== "url") {
			throw templateParameterIssueError(`buttons: Button at index ${String(index)} must be of type Url`);
		}

		const [suffix] = sent === undefined ? [] : parametersOf(sent);

		if (suffix === undefined) {
			throw requiredParameterMissingError(`buttons: Button at index ${String(index)} of type Url requires a parameter`);
		}

		const text = stringField(suffix, "text");

		if (stringField(suffix, "type")?.toLowerCase() === "text" && (text === undefined || text === "")) {
			throw mandatoryParameterError(
				"button: Parameter 'text' is mandatory for component parameter type 'text' and cannot be empty",
			);
		}
	}
}

/**
 * Checks a send's parameters against the template, in the order SPEC §2 lists — captured, save
 * where SPEC marks a step inferred: the objects of `currency`/`date_time`/`location` parameters
 * and body `text`, a media header, the header and body counts, NAMED names, then URL buttons.
 * Which error a send breaking several rules gets depends on this order, so the specs pin it.
 */
export function assertTemplateParameters(template: TemplateRecord, components: readonly JsonObject[] = []): void {
	assertParameterObjects(components);
	assertHeaderFormat(template, components);

	const expected = templatePlaceholders(template.components);

	for (const component of PLACEHOLDER_COMPONENTS) {
		const expectedNames = expected[component];
		const provided = textParametersOf(components, component);

		if (provided.length !== expectedNames.length) {
			throw templateParameterMismatchError(countMismatchDetails(component, provided.length, expectedNames.length));
		}

		if (template.parameterFormat === "NAMED") {
			assertNamedParameters(expectedNames, provided);
		}
	}

	assertButtonParameters(template, components);
}
