import type { JsonObject, TemplateRecord } from "../db/index.ts";
import { templateNotFoundError, templateParameterMismatchError } from "./meta-errors.ts";
import { PLACEHOLDER_COMPONENTS, templatePlaceholders, type PlaceholderComponent } from "./template-placeholders.ts";

/**
 * Validating a `template` send against the stored template (SPEC §2).
 *
 * Only text parameters are counted. A media header carries `{type:"image", image:{…}}`
 * instead of text, and its stored counterpart declares no placeholders, so both sides come
 * out at zero and the header passes without whaloc having to understand media parameters.
 */

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
 * The text parameters a send provides for one component. A parameter is text when it says so,
 * or when it carries a `text` field and nothing claims otherwise — Meta accepts the shorthand.
 */
function textParametersOf(components: readonly JsonObject[], component: PlaceholderComponent): TextParameter[] {
	const provided: TextParameter[] = [];

	for (const sent of components) {
		if (stringField(sent, "type")?.toLowerCase() !== component) {
			continue;
		}

		for (const parameter of parametersOf(sent)) {
			const type = stringField(parameter, "type")?.toLowerCase();

			if (type === "text" || (type === undefined && stringField(parameter, "text") !== undefined)) {
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
 * `parameter_format: "NAMED"` templates address their placeholders by name, so a send that
 * happens to have the right *count* can still be wrong. Meta reports these as 132000 too;
 * only the `details` string differs from the captured count mismatch, and it is modeled on
 * Meta's phrasing rather than captured.
 */
function assertNamedParameters(
	component: PlaceholderComponent,
	expected: readonly string[],
	provided: readonly TextParameter[],
): void {
	for (const parameter of provided) {
		if (parameter.parameterName === undefined) {
			throw templateParameterMismatchError(
				`${component}: parameter_name is required for a template with parameter_format NAMED`,
			);
		}

		if (!expected.includes(parameter.parameterName)) {
			throw templateParameterMismatchError(
				`${component}: parameter_name (${parameter.parameterName}) does not exist in the template`,
			);
		}
	}

	const providedNames = new Set(provided.map(parameter => parameter.parameterName));
	const missing = expected.find(name => !providedNames.has(name));

	if (missing !== undefined) {
		throw templateParameterMismatchError(`${component}: parameter_name (${missing}) is missing`);
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
 * Checks a send's parameters against the template's placeholders. Counts are compared first,
 * because that is the failure the captured sample in SPEC §1 documents.
 */
export function assertTemplateParameters(template: TemplateRecord, components: readonly JsonObject[] = []): void {
	const expected = templatePlaceholders(template.components);

	for (const component of PLACEHOLDER_COMPONENTS) {
		const expectedNames = expected[component];
		const provided = textParametersOf(components, component);

		if (provided.length !== expectedNames.length) {
			throw templateParameterMismatchError(countMismatchDetails(component, provided.length, expectedNames.length));
		}

		if (template.parameterFormat === "NAMED") {
			assertNamedParameters(component, expectedNames, provided);
		}
	}
}
