import { describe, expect, it } from "vitest";
import type { JsonObject, TemplateRecord } from "../db/index.ts";
import { GraphApiError } from "./graph-api-error.ts";
import { assertTemplateIsSendable, assertTemplateParameters } from "./template-send-validation.ts";

function makeTemplate(overrides: Partial<TemplateRecord> = {}): TemplateRecord {
	return {
		id: "123456789012345",
		wabaId: "102290129340398",
		name: "order_update",
		language: "en_US",
		category: "UTILITY",
		parameterFormat: "POSITIONAL",
		components: [{ type: "BODY", text: "Order {{1}} ships on {{2}}" }],
		status: "APPROVED",
		rejectedReason: null,
		qualityScore: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function bodyComponent(...parameters: JsonObject[]): JsonObject[] {
	return [{ type: "body", parameters }];
}

/** Runs an assertion and hands back the {@link GraphApiError} it raised. */
function captureError(assertion: () => void): GraphApiError {
	try {
		assertion();
	} catch (error) {
		if (error instanceof GraphApiError) {
			return error;
		}

		throw error;
	}

	throw new Error("expected the assertion to reject the send");
}

describe("assertTemplateIsSendable", () => {
	it("accepts an approved template", () => {
		expect(() => {
			assertTemplateIsSendable(makeTemplate(), "order_update", "en_US");
		}).not.toThrow();
	});

	it("reports an unknown template as 132001", () => {
		const error = captureError(() => {
			assertTemplateIsSendable(null, "nope", "en_US");
		});

		expect(error).toMatchObject({
			code: 132_001,
			httpStatus: 400,
			message: "(#132001) Template name does not exist in the translation",
			details: "template name (nope) does not exist in en_US",
		});
	});

	it.each(["PENDING", "REJECTED", "PAUSED", "DISABLED"] as const)("reports a %s template as 132001", status => {
		const error = captureError(() => {
			assertTemplateIsSendable(makeTemplate({ status }), "order_update", "en_US");
		});

		expect(error).toMatchObject({
			code: 132_001,
			details: "template name (order_update) is not approved in en_US",
		});
	});
});

describe("assertTemplateParameters", () => {
	describe("positional templates", () => {
		it("accepts a send with one parameter per placeholder", () => {
			expect(() => {
				assertTemplateParameters(
					makeTemplate(),
					bodyComponent({ type: "text", text: "A-1" }, { type: "text", text: "Friday" }),
				);
			}).not.toThrow();
		});

		it("reproduces the captured 132000 details when parameters are missing", () => {
			const template = makeTemplate({ components: [{ type: "BODY", text: "{{1}} {{2}} {{3}}" }] });
			const error = captureError(() => {
				assertTemplateParameters(template, bodyComponent({ type: "text", text: "only one" }));
			});

			expect(error).toMatchObject({
				code: 132_000,
				message: "(#132000) Number of parameters does not match the expected number of params",
				details: "body: number of localizable_params (1) does not match the expected number of params (3)",
			});
		});

		it("rejects parameters for a body that takes none", () => {
			const template = makeTemplate({ components: [{ type: "BODY", text: "Your order shipped" }] });
			const error = captureError(() => {
				assertTemplateParameters(template, bodyComponent({ type: "text", text: "extra" }));
			});

			expect(error.details).toBe(
				"body: number of localizable_params (1) does not match the expected number of params (0)",
			);
		});

		it("rejects a send with no components at all when the template needs them", () => {
			const error = captureError(() => {
				assertTemplateParameters(makeTemplate());
			});

			expect(error.details).toBe(
				"body: number of localizable_params (0) does not match the expected number of params (2)",
			);
		});

		it("validates the header separately from the body", () => {
			const template = makeTemplate({
				components: [
					{ type: "HEADER", format: "TEXT", text: "Sale on {{1}}" },
					{ type: "BODY", text: "Order {{1}} ships on {{2}}" },
				],
			});
			const error = captureError(() => {
				assertTemplateParameters(template, [
					...bodyComponent({ type: "text", text: "A-1" }, { type: "text", text: "Friday" }),
				]);
			});

			expect(error.details).toBe(
				"header: number of localizable_params (0) does not match the expected number of params (1)",
			);
		});

		it("ignores a media header parameter, which is not localizable", () => {
			const template = makeTemplate({
				components: [
					{ type: "HEADER", format: "IMAGE" },
					{ type: "BODY", text: "Order {{1}} ships on {{2}}" },
				],
			});

			expect(() => {
				assertTemplateParameters(template, [
					{ type: "header", parameters: [{ type: "image", image: { id: "1" } }] },
					...bodyComponent({ type: "text", text: "A-1" }, { type: "text", text: "Friday" }),
				]);
			}).not.toThrow();
		});

		it("counts a parameter that only carries text as a text parameter", () => {
			expect(() => {
				assertTemplateParameters(makeTemplate(), bodyComponent({ text: "A-1" }, { text: "Friday" }));
			}).not.toThrow();
		});

		it("counts currency and date_time parameters, which fill placeholders too", () => {
			const template = makeTemplate({ components: [{ type: "BODY", text: "{{1}} owes {{2}} by {{3}}" }] });

			expect(() => {
				assertTemplateParameters(
					template,
					bodyComponent(
						{ type: "text", text: "Ana" },
						{ type: "currency", currency: { fallback_value: "R$ 129,90", code: "BRL", amount_1000: 129_900 } },
						{ type: "date_time", date_time: { fallback_value: "October 3, 2026" } },
					),
				);
			}).not.toThrow();
		});
	});

	describe("parameter objects: currency, date_time, location (SPEC §2)", () => {
		const template = makeTemplate({ components: [{ type: "BODY", text: "You owe {{1}}" }] });

		it("refuses a currency parameter with no currency object, as Meta's (#100)", () => {
			const error = captureError(() => {
				assertTemplateParameters(template, bodyComponent({ type: "currency" }));
			});

			expect(error.code).toBe(100);
			expect(error.subcode).toBeUndefined();
			expect(error.details).toBe("Parameter 'currency' is mandatory for component parameter type 'currency'");
		});

		it("names every field a currency object is missing, as Meta's schema error, with no error_data", () => {
			const error = captureError(() => {
				assertTemplateParameters(template, bodyComponent({ type: "currency", currency: {} }));
			});
			const path = "template.components.0.parameters.0.currency";
			const sentence = (field: string) =>
				`Your request has violated JSON schema constraint 'required' for the JSON field '${path}', please check the JSON schema for the JSON field '${path}' and make sure your request is valid for missing : '${field}'`;

			expect(error.code).toBe(100);
			expect(error.details).toBeUndefined();
			expect(error.message).toBe([sentence("fallback_value"), sentence("code"), sentence("amount_1000")].join(", "));
		});

		it("holds a location header's object to its coordinates, longitude first as Meta lists them", () => {
			const locationTemplate = makeTemplate({
				components: [
					{ type: "HEADER", format: "LOCATION" },
					{ type: "BODY", text: "Meet {{1}}" },
				],
			});
			const error = captureError(() => {
				assertTemplateParameters(locationTemplate, [
					{ type: "header", parameters: [{ type: "location", location: {} }] },
					...bodyComponent({ type: "text", text: "A-1042" }),
				]);
			});

			expect(error.details).toBeUndefined();
			expect(error.message.indexOf("missing : 'longitude'")).toBeLessThan(
				error.message.indexOf("missing : 'latitude'"),
			);
			expect(error.message).toContain("'template.components.0.parameters.0.location'");
		});

		it("refuses a body text parameter with no text, as Meta's (#100) without a component prefix", () => {
			const error = captureError(() => {
				assertTemplateParameters(template, bodyComponent({ type: "text" }));
			});

			expect(error.code).toBe(100);
			expect(error.details).toBe("Parameter 'text' is mandatory for component parameter type 'text'");
		});

		it.each([
			["a positional", makeTemplate({ components: [{ type: "BODY", text: "{{1}} owes {{2}}" }] }), { type: "text" }],
			[
				"a NAMED",
				makeTemplate({
					parameterFormat: "NAMED",
					components: [{ type: "BODY", text: "Olá {{customer_name}}, pedido {{order_id}}" }],
				}),
				{ type: "text", parameter_name: "customer_name" },
			],
		] as const)(
			"checks a body text parameter's text before the counts, on %s template, as Meta does",
			(_label, template, parameter) => {
				const error = captureError(() => {
					assertTemplateParameters(template, bodyComponent(parameter));
				});

				expect(error.code).toBe(100);
				expect(error.details).toBe("Parameter 'text' is mandatory for component parameter type 'text'");
			},
		);

		it.each(["constructor", "__proto__", "toString"])(
			"answers a parameter typed %o like any unknown type, never with a 500",
			type => {
				const parameter = JSON.parse(`{"type":"${type}","${type}":{}}`) as JsonObject;

				expect(
					captureError(() => {
						assertTemplateParameters(template, bodyComponent(parameter));
					}),
				).toBeInstanceOf(GraphApiError);
			},
		);

		it("locates the object by its position in the send and lists only what is missing", () => {
			const error = captureError(() => {
				assertTemplateParameters(template, [
					{ type: "header", parameters: [] },
					...bodyComponent({ type: "date_time", date_time: {} }),
				]);
			});

			expect(error.message).toContain("'template.components.1.parameters.0.date_time'");
			expect(error.message).toContain("missing : 'fallback_value'");
			expect(error.message).not.toContain("amount_1000");
		});
	});

	describe("media headers (SPEC §2)", () => {
		const imageTemplate = makeTemplate({
			components: [
				{ type: "HEADER", format: "IMAGE", example: { header_handle: ["4::aW1hZ2UvanBlZw==:ARZsample"] } },
				{ type: "BODY", text: "Your booking {{1}} is confirmed" },
			],
		});

		it("reproduces the captured 132012 when the send attaches no header media", () => {
			const error = captureError(() => {
				assertTemplateParameters(imageTemplate, bodyComponent({ type: "text", text: "A-1042" }));
			});

			expect(error.code).toBe(132_012);
			expect(error.message).toBe("(#132012) Parameter format does not match format in the created template");
			expect(error.details).toBe("header: Format mismatch, expected IMAGE, received UNKNOWN");
		});

		it.each([{ type: "image" }, { type: "image", video: { id: "1" } }])(
			"refuses %o, which names its type but carries no such object, as Meta's (#100)",
			parameter => {
				const error = captureError(() => {
					assertTemplateParameters(imageTemplate, [
						{ type: "header", parameters: [parameter] },
						...bodyComponent({ type: "text", text: "A-1042" }),
					]);
				});

				expect(error.code).toBe(100);
				expect(error.subcode).toBeUndefined();
				expect(error.message).toBe("(#100) Invalid parameter");
				expect(error.details).toBe("Parameter 'image' is mandatory for component parameter type 'image'");
			},
		);

		it("accepts an image header sent by link", () => {
			expect(() => {
				assertTemplateParameters(imageTemplate, [
					{ type: "header", parameters: [{ type: "image", image: { link: "https://cdn.test/room.jpg" } }] },
					...bodyComponent({ type: "text", text: "A-1042" }),
				]);
			}).not.toThrow();
		});

		it("checks the header before the counts, so a send breaking both gets the 132012", () => {
			const error = captureError(() => {
				assertTemplateParameters(imageTemplate, []);
			});

			expect(error.code).toBe(132_012);
		});

		it("refuses a media object that names neither an ID nor a link, as Meta's 132018", () => {
			const error = captureError(() => {
				assertTemplateParameters(imageTemplate, [
					{ type: "header", parameters: [{ type: "image", image: {} }] },
					...bodyComponent({ type: "text", text: "A-1042" }),
				]);
			});

			expect(error.code).toBe(132_018);
			expect(error.message).toBe("(#132018) There\u{2019}s an issue with the parameters in your template");
			expect(error.details).toBe("Either one of media ID or link must be present");
		});

		it("checks the missing object before the format, as Meta does", () => {
			const error = captureError(() => {
				assertTemplateParameters(imageTemplate, [
					{ type: "header", parameters: [{ type: "video" }] },
					...bodyComponent({ type: "text", text: "A-1042" }),
				]);
			});

			expect(error.code).toBe(100);
			expect(error.details).toBe("Parameter 'video' is mandatory for component parameter type 'video'");
		});

		it("names a text parameter on a media header as received TEXT (captured)", () => {
			const error = captureError(() => {
				assertTemplateParameters(imageTemplate, [
					{ type: "header", parameters: [{ type: "text", text: "x" }] },
					...bodyComponent({ type: "text", text: "A-1042" }),
				]);
			});

			expect(error.details).toBe("header: Format mismatch, expected IMAGE, received TEXT");
		});

		it("names the type a send attached when it is the wrong one", () => {
			const error = captureError(() => {
				assertTemplateParameters(imageTemplate, [
					{ type: "header", parameters: [{ type: "video", video: { id: "1" } }] },
					...bodyComponent({ type: "text", text: "A-1042" }),
				]);
			});

			expect(error.details).toBe("header: Format mismatch, expected IMAGE, received VIDEO");
		});

		it("holds a location header to the same rule", () => {
			const template = makeTemplate({
				components: [
					{ type: "HEADER", format: "LOCATION" },
					{ type: "BODY", text: "Hi" },
				],
			});

			const error = captureError(() => {
				assertTemplateParameters(template, []);
			});

			expect(error.details).toBe("header: Format mismatch, expected LOCATION, received UNKNOWN");
			expect(() => {
				assertTemplateParameters(template, [
					{ type: "header", parameters: [{ type: "location", location: { latitude: 1, longitude: 2 } }] },
				]);
			}).not.toThrow();
		});
	});

	describe("URL buttons (SPEC §2)", () => {
		const bookingTemplate = makeTemplate({
			components: [
				{ type: "BODY", text: "Your booking {{1}} is confirmed" },
				{
					type: "BUTTONS",
					buttons: [
						{ type: "QUICK_REPLY", text: "Thanks" },
						{ type: "URL", text: "View booking", url: "https://shop.test/booking/{{1}}" },
						{ type: "URL", text: "Help", url: "https://shop.test/help" },
					],
				},
			],
		});
		const body = bodyComponent({ type: "text", text: "A-1042" });

		it("reproduces the captured 131008 when a dynamic URL button gets no parameter", () => {
			const error = captureError(() => {
				assertTemplateParameters(bookingTemplate, body);
			});

			expect(error.code).toBe(131_008);
			expect(error.message).toBe("(#131008) Required parameter is missing");
			expect(error.details).toBe("buttons: Button at index 1 of type Url requires a parameter");
		});

		it("refuses a button component of another sub_type at the URL button's index, as Meta's 132018", () => {
			const error = captureError(() => {
				assertTemplateParameters(bookingTemplate, [
					...body,
					{ type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "X" }] },
				]);
			});

			expect(error.code).toBe(132_018);
			expect(error.details).toBe("buttons: Button at index 1 must be of type Url");
		});

		it.each([{ type: "text" }, { type: "text", text: "" }])(
			"refuses the URL suffix %o, which carries no text, as Meta's (#100)",
			suffix => {
				const error = captureError(() => {
					assertTemplateParameters(bookingTemplate, [
						...body,
						{ type: "button", sub_type: "url", index: "1", parameters: [suffix] },
					]);
				});

				expect(error.code).toBe(100);
				expect(error.details).toBe(
					"button: Parameter 'text' is mandatory for component parameter type 'text' and cannot be empty",
				);
			},
		);

		it("treats a button component with no parameters as missing", () => {
			const error = captureError(() => {
				assertTemplateParameters(bookingTemplate, [
					...body,
					{ type: "button", sub_type: "url", index: "1", parameters: [] },
				]);
			});

			expect(error.code).toBe(131_008);
		});

		it.each(["1", 1])("accepts the suffix at the button's index %o, as a string or a number", index => {
			expect(() => {
				assertTemplateParameters(bookingTemplate, [
					...body,
					{ type: "button", sub_type: "url", index, parameters: [{ type: "text", text: "A-1042" }] },
				]);
			}).not.toThrow();
		});

		it("accepts a button component that names no sub_type, since only a mismatch was captured", () => {
			expect(() => {
				assertTemplateParameters(bookingTemplate, [
					...body,
					{ type: "button", index: "1", parameters: [{ type: "text", text: "A-1042" }] },
				]);
			}).not.toThrow();
		});

		it("checks the counts before the buttons, so a send breaking both gets the 132000", () => {
			const error = captureError(() => {
				assertTemplateParameters(bookingTemplate, []);
			});

			expect(error.code).toBe(132_000);
		});
	});

	describe("named templates (SPEC §2)", () => {
		const namedTemplate = makeTemplate({
			parameterFormat: "NAMED",
			components: [{ type: "BODY", text: "Hi {{customer_name}}, order {{order_id}} shipped" }],
		});

		it("accepts parameters whose names match the placeholders", () => {
			expect(() => {
				assertTemplateParameters(
					namedTemplate,
					bodyComponent(
						{ type: "text", parameter_name: "customer_name", text: "Ana" },
						{ type: "text", parameter_name: "order_id", text: "A-1" },
					),
				);
			}).not.toThrow();
		});

		it("rejects a parameter without a parameter_name", () => {
			const error = captureError(() => {
				assertTemplateParameters(
					namedTemplate,
					bodyComponent({ type: "text", text: "Ana" }, { type: "text", parameter_name: "order_id", text: "A-1" }),
				);
			});

			expect(error).toMatchObject({ code: 100, subcode: undefined, details: "Parameter name is missing or empty" });
		});

		it("reports the declared placeholder an undeclared parameter_name leaves unnamed, as Meta does", () => {
			const error = captureError(() => {
				assertTemplateParameters(
					namedTemplate,
					bodyComponent(
						{ type: "text", parameter_name: "customer_name", text: "Ana" },
						{ type: "text", parameter_name: "order_number", text: "A-1" },
					),
				);
			});

			expect(error).toMatchObject({ code: 100, details: "Parameter name is missing for the parameter '{{order_id}}'" });
		});

		it("rejects a placeholder left unfilled by a duplicate parameter_name", () => {
			const error = captureError(() => {
				assertTemplateParameters(
					namedTemplate,
					bodyComponent(
						{ type: "text", parameter_name: "customer_name", text: "Ana" },
						{ type: "text", parameter_name: "customer_name", text: "Ana again" },
					),
				);
			});

			expect(error).toMatchObject({ code: 100, details: "Parameter name is missing for the parameter '{{order_id}}'" });
		});

		it("treats an empty parameter_name as missing", () => {
			const error = captureError(() => {
				assertTemplateParameters(
					namedTemplate,
					bodyComponent(
						{ type: "text", parameter_name: "", text: "Ana" },
						{ type: "text", parameter_name: "order_id", text: "A-1" },
					),
				);
			});

			expect(error.details).toBe("Parameter name is missing or empty");
		});

		it("names a header placeholder the same way, with no component prefix", () => {
			const promo = makeTemplate({
				parameterFormat: "NAMED",
				components: [
					{ type: "HEADER", format: "TEXT", text: "Our {{sale_name}} is on!" },
					{ type: "BODY", text: "Use {{coupon_code}}" },
				],
			});
			const error = captureError(() => {
				assertTemplateParameters(promo, [
					{ type: "header", parameters: [{ type: "text", parameter_name: "sale", text: "Summer Sale" }] },
					...bodyComponent({ type: "text", parameter_name: "coupon_code", text: "25OFF" }),
				]);
			});

			expect(error.details).toBe("Parameter name is missing for the parameter '{{sale_name}}'");
		});

		it("still checks the count first, as the captured sample does", () => {
			const error = captureError(() => {
				assertTemplateParameters(
					namedTemplate,
					bodyComponent({ type: "text", parameter_name: "customer_name", text: "Ana" }),
				);
			});

			expect(error.details).toBe(
				"body: number of localizable_params (1) does not match the expected number of params (2)",
			);
		});
	});
});
