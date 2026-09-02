import { z } from "zod";
import { jsonObjectSchema, metaIdSchema, pageQuerySchema, pagingSchema } from "./common.ts";

/**
 * The delivery log (SPEC §3): one row per attempt, retries included, browsable in the UI.
 */
export const webhookDeliverySchema = z.object({
	id: z.string(),
	/** `messages`, `message_template_status_update`, `raw`, `handshake`, … */
	eventType: z.string(),
	/** Empty when the attempt was skipped because no webhook URL is configured. */
	url: z.string(),
	/** The exact bytes that were signed and POSTed (SPEC §1.12). */
	requestBody: z.string(),
	requestHeaders: z.record(z.string(), z.string()),
	responseStatus: z.number().int().nullable(),
	responseBody: z.string().nullable(),
	error: z.string().nullable(),
	attempt: z.number().int().positive(),
	durationMs: z.number().int().nullable(),
	/** `true` when `WHALOC_WEBHOOK_URL` is unset: nothing was sent, the payload is logged anyway. */
	skipped: z.boolean(),
	createdAt: z.iso.datetime(),
});

export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const webhookDeliveryListResponseSchema = z.object({
	data: z.array(webhookDeliverySchema),
	paging: pagingSchema,
});

/** Redelivering or sending a raw payload answers with every attempt it produced. */
export const webhookDeliveryAttemptsResponseSchema = z.object({ data: z.array(webhookDeliverySchema) });

export type WebhookDeliveryListResponse = z.infer<typeof webhookDeliveryListResponseSchema>;
export type WebhookDeliveryAttemptsResponse = z.infer<typeof webhookDeliveryAttemptsResponseSchema>;

export const listWebhookDeliveriesQuerySchema = pageQuerySchema;

export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;

/** `POST /api/webhook/raw` — any JSON object, serialized and signed like a real event. */
export const rawWebhookRequestSchema = jsonObjectSchema;

export type RawWebhookRequest = z.infer<typeof rawWebhookRequestSchema>;

/** Outcome of the `hub.challenge` handshake whaloc initiates (SPEC §1.13). */
export const handshakeResultSchema = z.object({
	ok: z.boolean(),
	url: z.string(),
	status: z.number().int().nullable(),
	challenge: z.string(),
	/** What the receiver echoed back, truncated; `null` when the request never completed. */
	echo: z.string().nullable(),
	error: z.string().nullable(),
	at: z.iso.datetime(),
});

export type HandshakeResult = z.infer<typeof handshakeResultSchema>;

export const handshakeResponseSchema = z.object({ data: handshakeResultSchema });

export type HandshakeResponse = z.infer<typeof handshakeResponseSchema>;

/**
 * Account-level webhooks (SPEC §3, §5).
 *
 * Both are **pure event emissions**: whaloc signs and delivers Meta's payload and changes
 * nothing of its own. There is no "restricted account" state behind `ACCOUNT_RESTRICTION` and no
 * quota behind `business_capability_update` — the point of these two is to let a consumer's
 * webhook handler be exercised, and inventing state Meta would then contradict would be worse
 * than emitting the notice alone.
 */
export const ACCOUNT_UPDATE_EVENTS = [
	"VERIFIED_ACCOUNT",
	"DISABLED_UPDATE",
	"ACCOUNT_RESTRICTION",
	"ACCOUNT_DELETED",
	"ACCOUNT_VIOLATION",
] as const;

export const accountUpdateEventSchema = z.enum(ACCOUNT_UPDATE_EVENTS);

export type AccountUpdateEvent = z.infer<typeof accountUpdateEventSchema>;

/** What an `ACCOUNT_RESTRICTION` says the account may no longer do. */
export const ACCOUNT_RESTRICTION_TYPES = [
	"RESTRICTED_ADD_PHONE_NUMBER_ACTION",
	"RESTRICTED_BIZ_INITIATED_MESSAGING",
	"RESTRICTED_CUSTOMER_INITIATED_MESSAGING",
] as const;

export const accountRestrictionTypeSchema = z.enum(ACCOUNT_RESTRICTION_TYPES);

export type AccountRestrictionType = z.infer<typeof accountRestrictionTypeSchema>;

/** One entry of `restriction_info`; `expiration` is Meta's own free-form date string. */
export const accountRestrictionSchema = z.object({
	restrictionType: accountRestrictionTypeSchema,
	expiration: z.string().min(1).optional(),
});

export type AccountRestriction = z.infer<typeof accountRestrictionSchema>;

/** `POST /api/webhook/account-update` — emits `account_update` for one WABA. */
export const accountUpdateRequestSchema = z.object({
	wabaId: metaIdSchema,
	event: accountUpdateEventSchema,
	/** The number the notice is about; its digits become `value.phone_number`. Optional, like Meta's. */
	phoneNumberId: metaIdSchema.optional(),
	/** Only meaningful for `ACCOUNT_RESTRICTION`, which is the one event Meta attaches it to. */
	restrictionInfo: z.array(accountRestrictionSchema).min(1).optional(),
});

export type AccountUpdateRequest = z.infer<typeof accountUpdateRequestSchema>;

/** `POST /api/webhook/business-capability-update` — the two numbers Meta reports. */
export const businessCapabilityUpdateRequestSchema = z.object({
	wabaId: metaIdSchema,
	maxDailyConversationPerPhone: z.number().int().nonnegative(),
	maxPhoneNumbersPerBusiness: z.number().int().nonnegative(),
});

export type BusinessCapabilityUpdateRequest = z.infer<typeof businessCapabilityUpdateRequestSchema>;
