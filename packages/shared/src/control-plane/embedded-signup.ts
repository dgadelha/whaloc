import { z } from "zod";
import { phoneNumberSchema } from "./phone-numbers.ts";
import { wabaSchema } from "./wabas.ts";

/**
 * The Embedded Signup dialog's API (SPEC §2.24). The dialog is a page of the web UI that the SDK
 * stand-in opens as a popup; these routes are what it asks whaloc, and what it posts back to the
 * page that opened it is shaped here too, so the popup and `sdk.js` agree by construction.
 */

/** whaloc's own message carrying the `code`, which `sdk.js` turns into `authResponse.code`. */
export const LOGIN_RESPONSE_TYPE = "WHALOC_LOGIN_RESPONSE";

/** Meta's `current_step` values for a `CANCEL` (Embedded Signup errors reference). */
export const SIGNUP_CANCEL_STEPS = [
	"ASSET_SELECTION",
	"ASSET_CREATION",
	"PHONE_NUMBER_SETUP",
	"PHONE_NUMBER_VERIFICATION",
	"WHATSAPP_BUSINESS_APP_ONBOARDING_PHONE_CREATION",
	"WHATSAPP_BUSINESS_APP_ONBOARDING_QR_CODE",
] as const;

export type SignupCancelStep = (typeof SIGNUP_CANCEL_STEPS)[number];

/** `?app_id=`: every dialog route refuses an app that is not whaloc's, as Meta's dialog does. */
export const signupAppQuerySchema = z.object({ app_id: z.string().min(1) });

/** A WABA with its numbers, for the dialog's pickers. */
export const signupChoiceSchema = z.object({
	waba: wabaSchema,
	phoneNumbers: z.array(phoneNumberSchema),
});

export type SignupChoice = z.infer<typeof signupChoiceSchema>;

/** `GET /api/embedded-signup/choices`. */
export const signupChoicesResponseSchema = z.object({ data: z.array(signupChoiceSchema) });

const existingSchema = z.object({ kind: z.literal("existing"), id: z.string().min(1) });

const signupWabaSchema = z.discriminatedUnion("kind", [
	existingSchema,
	z.object({ kind: z.literal("new"), name: z.string().trim().min(1) }),
]);

const createdPhoneNumberSchema = z.object({
	kind: z.literal("new"),
	phoneNumber: z.string().trim().min(1),
	verifiedName: z.string().trim().min(1),
	/** Already on the WhatsApp Business app: created registered, with `is_on_biz_app: true`. */
	coexistence: z.boolean(),
});

const signupPhoneNumberSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }),
	existingSchema,
	createdPhoneNumberSchema,
]);

/**
 * The session info shape the page asked for in `extras.version`. v5 changed the finish events'
 * `data`; anything else gets v4's.
 */
export const SESSION_INFO_VERSIONS = ["v4", "v5"] as const;

export type SessionInfoVersion = (typeof SESSION_INFO_VERSIONS)[number];

/** `POST /api/embedded-signup/complete`. */
export const signupCompleteRequestSchema = z.object({
	appId: z.string().min(1),
	sessionInfoVersion: z.enum(SESSION_INFO_VERSIONS),
	waba: signupWabaSchema,
	phoneNumber: signupPhoneNumberSchema,
});

export type SignupCompleteRequest = z.infer<typeof signupCompleteRequestSchema>;

/** v4's `data` values are all strings; v5 adds `is_on_biz_app` and the ID lists. */
const sessionEventValueSchema = z.union([z.string(), z.boolean(), z.array(z.string())]);

/** The session logging message the dialog posts to the page, before it is stringified. */
export const signupSessionEventSchema = z.object({
	type: z.literal("WA_EMBEDDED_SIGNUP"),
	event: z.enum(["FINISH", "FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"]),
	data: z.record(z.string(), sessionEventValueSchema),
});

export type SignupSessionEvent = z.infer<typeof signupSessionEventSchema>;

export const signupCompleteResponseSchema = z.object({
	data: z.object({ code: z.string(), sessionEvent: signupSessionEventSchema }),
});

export type SignupResult = z.infer<typeof signupCompleteResponseSchema>["data"];

/** `GET /api/embedded-signup/error-session`: what an `ERROR` event carries besides the error. */
export const signupErrorSessionResponseSchema = z.object({
	data: z.object({ sessionId: z.string(), timestamp: z.string() }),
});

export type SignupErrorSession = z.infer<typeof signupErrorSessionResponseSchema>["data"];
