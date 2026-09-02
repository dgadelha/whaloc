import { describe, expect, it } from "vitest";
import {
	GraphApiError,
	invalidParameterError,
	missingAccessTokenError,
	templateParameterMismatchError,
	unknownObjectError,
} from "../domain/index.ts";
import { toMetaErrorEnvelope } from "./meta-error-envelope.ts";

const FBTRACE_ID = "AOnodi98JaYHcSTvVvrOtJs";

describe("toMetaErrorEnvelope", () => {
	it("reproduces the captured 132000 sample (SPEC §1)", () => {
		const error = templateParameterMismatchError(
			"body: number of localizable_params (1) does not match the expected number of params (3)",
		);

		expect(toMetaErrorEnvelope(error, FBTRACE_ID)).toEqual({
			error: {
				message: "(#132000) Number of parameters does not match the expected number of params",
				code: 132_000,
				type: "OAuthException",
				error_data: {
					messaging_product: "whatsapp",
					details: "body: number of localizable_params (1) does not match the expected number of params (3)",
				},
				fbtrace_id: FBTRACE_ID,
			},
		});
	});

	it("omits error_subcode and error_data when the error carries neither", () => {
		expect(toMetaErrorEnvelope(missingAccessTokenError(), FBTRACE_ID).error).toEqual({
			message: "Invalid OAuth access token - Cannot parse access token",
			type: "OAuthException",
			code: 190,
			fbtrace_id: FBTRACE_ID,
		});
	});

	it("carries error_subcode without error_data", () => {
		const envelope = toMetaErrorEnvelope(unknownObjectError("42"), FBTRACE_ID);

		expect(envelope.error.error_subcode).toBe(33);
		expect(envelope.error.error_data).toBeUndefined();
	});

	it("wraps details in Meta's messaging_product envelope", () => {
		const envelope = toMetaErrorEnvelope(invalidParameterError("Param to is required"), FBTRACE_ID);

		expect(envelope.error).toMatchObject({
			message: "(#100) Invalid parameter",
			code: 100,
			error_subcode: 2_494_010,
			error_data: { messaging_product: "whatsapp", details: "Param to is required" },
		});
	});

	it("keeps a non-default error type", () => {
		const error = new GraphApiError("An unexpected error occurred", { code: 2, type: "GraphMethodException" });

		expect(toMetaErrorEnvelope(error, FBTRACE_ID).error.type).toBe("GraphMethodException");
	});
});

describe("GraphApiError", () => {
	it("defaults to a 400 OAuthException", () => {
		const error = new GraphApiError("boom", { code: 1 });

		expect(error).toMatchObject({ httpStatus: 400, type: "OAuthException", name: "GraphApiError" });
	});

	it("keeps the cause it was given", () => {
		const cause = new Error("underlying");
		const error = new GraphApiError("boom", { code: 1, cause });

		expect(error.cause).toBe(cause);
	});
});
