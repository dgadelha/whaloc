import { z } from "zod";
import { VERIFICATION_CODE_METHODS } from "../db/index.ts";

/**
 * The bodies the phone-number management routes accept, shaped by
 * `docs/meta-openapi/phone-number-management.yaml` (SPEC §2.13–§2.17).
 *
 * `phone_number` is deliberately *not* pattern-checked here: Meta answers a malformed number
 * with its own sentence (`Invalid parameter: phone_number must be in E.164 format`), which the
 * generic zod-to-`error_data.details` mapping would replace with a paraphrase. The service
 * checks {@link E164_PATTERN} and raises that envelope itself.
 */

/** `^[1-9][0-9]{6,14}$` — E.164 digits without the `+`, per the vendored spec. */
export const E164_PATTERN = /^[1-9]\d{6,14}$/;

const VERIFIED_NAME_MIN = 2;
const VERIFIED_NAME_MAX = 75;

/** `POST /{wabaId}/phone_numbers`. */
export const graphPhoneNumberCreateRequestSchema = z.object({
	phone_number: z.string().min(1),
	verified_name: z.string().min(VERIFIED_NAME_MIN).max(VERIFIED_NAME_MAX),
	/** Country dial code; only prepended when `phone_number` does not already carry it. */
	cc: z
		.string()
		.regex(/^\d{1,3}$/, "must be 1-3 digits")
		.optional(),
	/** Accepted for fidelity: whaloc has no on-premises side to migrate from. */
	migrate_phone_number: z.boolean().optional(),
	/** A pre-verified number skips the code: that is what pre-verification means (SPEC §4). */
	preverified_id: z.string().min(1).optional(),
});

export type GraphPhoneNumberCreateRequest = z.infer<typeof graphPhoneNumberCreateRequestSchema>;

/** `POST /{phoneNumberId}/request_code`. */
export const requestCodeRequestSchema = z.object({
	code_method: z.enum(VERIFICATION_CODE_METHODS),
	/** A language tag like `en_US`; echoed back rather than validated against a list. */
	language: z.string().min(2).max(20),
});

export type RequestCodeRequest = z.infer<typeof requestCodeRequestSchema>;

/** `POST /{phoneNumberId}/verify_code`. */
export const verifyCodeRequestSchema = z.object({
	code: z.string().min(1),
});

export type VerifyCodeRequest = z.infer<typeof verifyCodeRequestSchema>;

/**
 * `POST /{phoneNumberId}/register`. The `pin` is the two-step verification PIN Meta stores; a
 * local emulator has nothing to compare it against, so it is accepted and not remembered.
 */
export const registerPhoneNumberRequestSchema = z.object({
	messaging_product: z.literal("whatsapp", "Param messaging_product must be whatsapp"),
	pin: z
		.string()
		.regex(/^\d{6}$/, "must be 6 digits")
		.optional(),
});

export type RegisterPhoneNumberRequest = z.infer<typeof registerPhoneNumberRequestSchema>;
