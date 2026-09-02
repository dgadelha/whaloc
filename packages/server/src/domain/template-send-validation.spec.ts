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

			expect(error).toMatchObject({
				code: 132_000,
				details: "body: parameter_name is required for a template with parameter_format NAMED",
			});
		});

		it("rejects a parameter_name the template does not declare", () => {
			const error = captureError(() => {
				assertTemplateParameters(
					namedTemplate,
					bodyComponent(
						{ type: "text", parameter_name: "customer_name", text: "Ana" },
						{ type: "text", parameter_name: "order_number", text: "A-1" },
					),
				);
			});

			expect(error.details).toBe("body: parameter_name (order_number) does not exist in the template");
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

			expect(error.details).toBe("body: parameter_name (order_id) is missing");
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
