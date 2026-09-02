import { z } from "zod";
import {
	codeVerificationStatusSchema,
	metaIdSchema,
	nameStatusSchema,
	phoneNumberStatusSchema,
	qualityRatingSchema,
	throughputLevelSchema,
	verificationCodeMethodSchema,
} from "./common.ts";

/**
 * The verification code `POST /{phoneNumberId}/request_code` generated, still waiting to be
 * confirmed.
 *
 * whaloc *is* the phone: there is no SMS to read, so the code it would have texted is served
 * here and shown in the UI (SPEC §5). It is the one field the control plane exposes that the
 * Graph surface deliberately does not.
 */
export const pendingVerificationSchema = z.object({
	code: z.string(),
	method: verificationCodeMethodSchema,
	/** The `language` the caller asked for, echoed back verbatim (e.g. `en_US`). */
	language: z.string(),
});

export type PendingVerification = z.infer<typeof pendingVerificationSchema>;

/**
 * The verticals Meta lets a business profile pick from, verbatim (SPEC §2.19). The list is
 * Meta's, not whaloc's: a consumer that switches on it sees the same set production would send.
 */
export const BUSINESS_VERTICALS = [
	"UNDEFINED",
	"OTHER",
	"AUTO",
	"BEAUTY",
	"APPAREL",
	"EDU",
	"ENTERTAIN",
	"EVENT_PLAN",
	"FINANCE",
	"GROCERY",
	"GOVT",
	"HOTEL",
	"HEALTH",
	"NONPROFIT",
	"PROF_SERVICES",
	"RETAIL",
	"TRAVEL",
	"RESTAURANT",
	"NOT_A_BIZ",
] as const;

export const businessVerticalSchema = z.enum(BUSINESS_VERTICALS);

export type BusinessVertical = z.infer<typeof businessVerticalSchema>;

/** Meta's own length limits, which `POST /{phoneNumberId}/whatsapp_business_profile` enforces. */
export const BUSINESS_PROFILE_LIMITS = {
	about: 139,
	address: 256,
	description: 512,
	email: 128,
	website: 256,
	websites: 2,
} as const;

/**
 * The business profile a phone number publishes (SPEC §2.19).
 *
 * Every field is optional, and an unset one is **absent** rather than empty: that is what Meta
 * answers for a profile nobody has filled in, and it makes `fields` projection honest. The
 * control plane speaks camelCase like the rest of `/api`; the Graph surface maps to and from
 * Meta's snake_case at the edge.
 */
export const businessProfileSchema = z.object({
	about: z.string().max(BUSINESS_PROFILE_LIMITS.about).optional(),
	address: z.string().max(BUSINESS_PROFILE_LIMITS.address).optional(),
	description: z.string().max(BUSINESS_PROFILE_LIMITS.description).optional(),
	email: z.string().max(BUSINESS_PROFILE_LIMITS.email).optional(),
	/** Set by whaloc from an uploaded media id, never written directly (SPEC §2.19). */
	profilePictureUrl: z.string().optional(),
	websites: z.array(z.string().max(BUSINESS_PROFILE_LIMITS.website)).max(BUSINESS_PROFILE_LIMITS.websites).optional(),
	vertical: businessVerticalSchema.optional(),
});

export type BusinessProfile = z.infer<typeof businessProfileSchema>;

/**
 * `POST /api/phone-numbers/:id/business-profile` — the same fields, as the UI's form sends them.
 *
 * A field left out is left alone; an **empty string (or empty array) clears it**, so a form that
 * posts every input ends up with exactly what is on screen.
 */
export const businessProfileUpdateRequestSchema = z.object({
	about: z.string().max(BUSINESS_PROFILE_LIMITS.about).optional(),
	address: z.string().max(BUSINESS_PROFILE_LIMITS.address).optional(),
	description: z.string().max(BUSINESS_PROFILE_LIMITS.description).optional(),
	email: z.string().max(BUSINESS_PROFILE_LIMITS.email).optional(),
	websites: z.array(z.string().max(BUSINESS_PROFILE_LIMITS.website)).max(BUSINESS_PROFILE_LIMITS.websites).optional(),
	vertical: z.union([businessVerticalSchema, z.literal("")]).optional(),
	/**
	 * An upload handle or a media id whose public URL becomes `profile_picture_url`; an empty
	 * string clears it (SPEC §2.19, §2.21).
	 */
	profilePictureHandle: z.string().optional(),
});

export type BusinessProfileUpdateRequest = z.infer<typeof businessProfileUpdateRequestSchema>;

export const phoneNumberSchema = z.object({
	id: z.string(),
	wabaId: z.string(),
	/** Formatted, e.g. `+55 11 91234-5678`; webhooks carry the digits only (SPEC §1). */
	displayPhoneNumber: z.string(),
	verifiedName: z.string(),
	qualityRating: qualityRatingSchema,
	throughputLevel: throughputLevelSchema,
	/** Only a `CONNECTED` number can send; the ladder that gets it there is SPEC §4. */
	status: phoneNumberStatusSchema,
	codeVerificationStatus: codeVerificationStatusSchema,
	nameStatus: nameStatusSchema,
	/** `null` unless a `request_code` flow is underway. */
	pendingVerification: pendingVerificationSchema.nullable(),
	/** What `GET /{phoneNumberId}/whatsapp_business_profile` publishes; `{}` when unset. */
	businessProfile: businessProfileSchema,
	createdAt: z.iso.datetime(),
});

export type PhoneNumber = z.infer<typeof phoneNumberSchema>;

export const phoneNumberResponseSchema = z.object({ data: phoneNumberSchema });

export type PhoneNumberResponse = z.infer<typeof phoneNumberResponseSchema>;

export const phoneNumberListResponseSchema = z.object({ data: z.array(phoneNumberSchema) });

export type PhoneNumberListResponse = z.infer<typeof phoneNumberListResponseSchema>;

/**
 * `POST /api/phone-numbers` — adds a number to a WABA at runtime (SPEC §5).
 *
 * A number created here is `CONNECTED` and `VERIFIED` straight away: the control plane is the
 * "someone already onboarded this number" path, and every flow that follows (sending, webhooks)
 * has to work immediately. Walking the verification ladder is what the Graph endpoints are for.
 */
export const phoneNumberCreateRequestSchema = z.object({
	wabaId: metaIdSchema,
	/**
	 * An explicit id, so a number can be given the one an app is already configured with —
	 * `WHATSAPP_PHONE_NUMBER_ID` in a production `.env` pointed at whaloc. Left out, whaloc mints
	 * one the way Meta does. It has to be free in **every** id store, not just this one (SPEC §2).
	 */
	id: metaIdSchema.optional(),
	/** Formatted or bare digits; whaloc stores it as given and compares by digits. */
	displayPhoneNumber: z.string().min(1).max(40),
	verifiedName: z.string().min(1).max(75),
	qualityRating: qualityRatingSchema.optional(),
	throughputLevel: throughputLevelSchema.optional(),
});

export type PhoneNumberCreateRequest = z.infer<typeof phoneNumberCreateRequestSchema>;

/** `PATCH /api/phone-numbers/:id` — the two fields a dev actually wants to fix (SPEC §5). */
export const phoneNumberUpdateRequestSchema = z
	.object({
		displayPhoneNumber: z.string().min(1).max(40).optional(),
		verifiedName: z.string().min(1).max(75).optional(),
	})
	.refine(
		body => body.displayPhoneNumber !== undefined || body.verifiedName !== undefined,
		"nothing to do: set displayPhoneNumber or verifiedName",
	);

export type PhoneNumberUpdateRequest = z.infer<typeof phoneNumberUpdateRequestSchema>;

/** `event` values of a `phone_number_quality_update` webhook. */
export const PHONE_NUMBER_QUALITY_EVENTS = [
	"ONBOARDING",
	"UPGRADE",
	"DOWNGRADE",
	"FLAGGED",
	"UNFLAGGED",
	"THROUGHPUT_UPGRADE",
	"THROUGHPUT_DOWNGRADE",
] as const;

export const phoneNumberQualityEventSchema = z.enum(PHONE_NUMBER_QUALITY_EVENTS);

export type PhoneNumberQualityEvent = z.infer<typeof phoneNumberQualityEventSchema>;

/** `current_limit` values Meta reports alongside a throughput change. */
export const MESSAGING_LIMITS = ["TIER_50", "TIER_250", "TIER_1K", "TIER_10K", "TIER_100K", "TIER_UNLIMITED"] as const;

export const messagingLimitSchema = z.enum(MESSAGING_LIMITS);

export type MessagingLimit = z.infer<typeof messagingLimitSchema>;

/**
 * `POST /api/phone-numbers/:id/quality` — updates the stored rating and throughput, and
 * optionally announces it as Meta would (SPEC §5).
 */
export const phoneNumberQualityRequestSchema = z
	.object({
		qualityRating: qualityRatingSchema.optional(),
		throughputLevel: throughputLevelSchema.optional(),
		/** Emits `phone_number_quality_update`; the two fields below shape that payload. */
		emitWebhook: z.boolean().default(false),
		event: phoneNumberQualityEventSchema.optional(),
		currentLimit: messagingLimitSchema.optional(),
	})
	.refine(
		body => body.qualityRating !== undefined || body.throughputLevel !== undefined || body.emitWebhook,
		"nothing to do: set qualityRating, throughputLevel, or emitWebhook",
	);

export type PhoneNumberQualityRequest = z.infer<typeof phoneNumberQualityRequestSchema>;
