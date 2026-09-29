import type { JsonObject, TemplateParameterFormat } from "@whaloc/shared";
import { asArray, asNumber, asRecord, asString, readString } from "../../lib/json.ts";

/**
 * What a `template` send supplies to the definition it names (SPEC §2): the parameters that
 * fill its placeholders, a media header's object, a button's dynamic part.
 *
 * The reading mirrors the server's validation (`template-send-validation.ts`): send components
 * spell their `type` in lower case where stored ones use upper case, a text parameter is
 * `{type:"text", text, parameter_name?}` (or just `{text}`), and `parameter_format` decides
 * whether `{{1}}` means "the first parameter" or `{{order_id}}` means "the one named so".
 */

/** The two components whose text carries placeholders. */
export type FillableComponent = "header" | "body";

export type HeaderMediaParameter =
	| { format: "image" | "video" | "document"; id: string | null; link: string | null; filename: string | null }
	| {
			format: "location";
			latitude: number | null;
			longitude: number | null;
			name: string | null;
			address: string | null;
	  };

export interface TemplateFill {
	/** The text a placeholder of one component takes; `null` when the send supplied none. */
	valueOf: (component: FillableComponent, placeholder: string) => string | null;
	/** The object a media header was sent with — a location too — `null` when the send carried none. */
	headerMedia: HeaderMediaParameter | null;
	/**
	 * The parameters the send gave the button at `index` of the template's `BUTTONS`, from a
	 * component of that button's `sub_type` (`url`, `copy_code`, …) or of none at all.
	 */
	buttonParameters: (index: number, subtype: string) => JsonObject[];
}

const HEADER_MEDIA_FORMATS = ["image", "video", "document"] as const;

function recordsOf(value: unknown): JsonObject[] {
	return asArray(value).flatMap(item => {
		const record = asRecord(item);

		return record === null ? [] : [record];
	});
}

function typeOf(component: JsonObject): string | undefined {
	return asString(component["type"])?.toLowerCase();
}

/**
 * The text a parameter stands for. `currency` and `date_time` are Meta's localizable types;
 * their `fallback_value` is what a device without the locale data shows, which is the closest
 * thing to "what was delivered" whaloc can render.
 */
export function parameterText(parameter: JsonObject): string | null {
	const type = asString(parameter["type"])?.toLowerCase();

	switch (type) {
		case undefined:
		case "text": {
			return asString(parameter["text"]);
		}

		case "currency":
		case "date_time": {
			return readString(parameter, type, "fallback_value");
		}

		default: {
			return null;
		}
	}
}

/** Resolves `{{1}}` by position, `{{name}}` by `parameter_name`, against one component's parameters. */
export function resolvePlaceholder(
	parameterFormat: TemplateParameterFormat,
	parameters: readonly JsonObject[],
	placeholder: string,
): string | null {
	if (parameterFormat === "NAMED") {
		const named = parameters.find(parameter => asString(parameter["parameter_name"]) === placeholder);

		return named === undefined ? null : parameterText(named);
	}

	if (!/^\d+$/.test(placeholder)) {
		return null;
	}

	const positional = parameters[Number(placeholder) - 1];

	return positional === undefined ? null : parameterText(positional);
}

function headerMediaOf(parameters: readonly JsonObject[]): HeaderMediaParameter | null {
	for (const parameter of parameters) {
		if (typeOf(parameter) === "location") {
			const location = asRecord(parameter["location"]);

			if (location !== null) {
				return {
					format: "location",
					latitude: asNumber(location["latitude"]),
					longitude: asNumber(location["longitude"]),
					name: asString(location["name"]),
					address: asString(location["address"]),
				};
			}
		}

		const format = HEADER_MEDIA_FORMATS.find(candidate => candidate === typeOf(parameter));
		const node = format === undefined ? null : asRecord(parameter[format]);

		if (format !== undefined && node !== null) {
			return {
				format,
				id: asString(node["id"]),
				link: asString(node["link"]),
				filename: asString(node["filename"]),
			};
		}
	}

	return null;
}

/** Meta takes a button's `index` as a string or a number; both name the same slot. */
function indexOf(component: JsonObject): number | null {
	const index = component["index"];

	return typeof index === "string" && /^\d+$/.test(index) ? Number(index) : asNumber(index);
}

export function createTemplateFill(parameterFormat: TemplateParameterFormat, sendComponents: unknown): TemplateFill {
	const components = recordsOf(sendComponents);
	const parametersOf = (type: string): JsonObject[] => {
		return components
			.filter(component => typeOf(component) === type)
			.flatMap(component => recordsOf(component["parameters"]));
	};

	return {
		valueOf: (component, placeholder) => resolvePlaceholder(parameterFormat, parametersOf(component), placeholder),
		headerMedia: headerMediaOf(parametersOf("header")),
		buttonParameters: (index, subtype) => {
			const button = components.find(component => {
				const sent = asString(component["sub_type"])?.toLowerCase();

				return (
					typeOf(component) === "button" && indexOf(component) === index && (sent === undefined || sent === subtype)
				);
			});

			return button === undefined ? [] : recordsOf(button["parameters"]);
		},
	};
}
