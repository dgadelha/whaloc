import { z } from "zod";

/**
 * The vocabulary the control-plane API and the WebSocket events share (SPEC §5).
 *
 * These enums mirror the server's own constants (`db/schema.ts`, `config/seed.ts`); the web
 * UI cannot import from the server package, so they are declared once here and a server-side
 * test keeps the two lists in step.
 */

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export const MESSAGE_STATUSES = ["accepted", "sent", "delivered", "read", "failed"] as const;
export const MESSAGE_TYPES = [
	"text",
	"template",
	"image",
	"video",
	"audio",
	"document",
	"sticker",
	"interactive",
	"location",
	"reaction",
	"contacts",
	"button",
	/** Meta's placeholder for a message type this API version cannot represent (a poll, say). */
	"unsupported",
	"unknown",
] as const;
export const TEMPLATE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"] as const;
export const TEMPLATE_CATEGORIES = ["AUTHENTICATION", "MARKETING", "UTILITY"] as const;
export const TEMPLATE_PARAMETER_FORMATS = ["POSITIONAL", "NAMED"] as const;
export const QUALITY_RATINGS = ["GREEN", "YELLOW", "RED", "UNKNOWN"] as const;
export const THROUGHPUT_LEVELS = ["STANDARD", "HIGH"] as const;

/** Where a phone number sits in its onboarding (`status`, account-number.yaml). */
export const PHONE_NUMBER_STATUSES = [
	"BANNED",
	"CONNECTED",
	"DELETED",
	"DISCONNECTED",
	"FLAGGED",
	"MIGRATED",
	"PENDING",
	"RATE_LIMITED",
	"RESTRICTED",
	"UNKNOWN",
	"UNVERIFIED",
] as const;
export const CODE_VERIFICATION_STATUSES = ["EXPIRED", "NOT_VERIFIED", "VERIFIED"] as const;
export const NAME_STATUSES = [
	"APPROVED",
	"AVAILABLE_WITHOUT_REVIEW",
	"DECLINED",
	"EXPIRED",
	"NON_EXISTS",
	"NONE",
	"PENDING_REVIEW",
] as const;
/** How `POST /{phoneNumberId}/request_code` says it would have delivered the code. */
export const VERIFICATION_CODE_METHODS = ["SMS", "VOICE"] as const;

export const messageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export const messageTypeSchema = z.enum(MESSAGE_TYPES);
export const templateStatusSchema = z.enum(TEMPLATE_STATUSES);
export const templateCategorySchema = z.enum(TEMPLATE_CATEGORIES);
export const templateParameterFormatSchema = z.enum(TEMPLATE_PARAMETER_FORMATS);
export const qualityRatingSchema = z.enum(QUALITY_RATINGS);
export const throughputLevelSchema = z.enum(THROUGHPUT_LEVELS);
export const phoneNumberStatusSchema = z.enum(PHONE_NUMBER_STATUSES);
export const codeVerificationStatusSchema = z.enum(CODE_VERIFICATION_STATUSES);
export const nameStatusSchema = z.enum(NAME_STATUSES);
export const verificationCodeMethodSchema = z.enum(VERIFICATION_CODE_METHODS);

export type MessageDirection = z.infer<typeof messageDirectionSchema>;
export type MessageStatus = z.infer<typeof messageStatusSchema>;
export type MessageType = z.infer<typeof messageTypeSchema>;
export type TemplateStatus = z.infer<typeof templateStatusSchema>;
export type TemplateCategory = z.infer<typeof templateCategorySchema>;
export type TemplateParameterFormat = z.infer<typeof templateParameterFormatSchema>;
export type QualityRating = z.infer<typeof qualityRatingSchema>;
export type ThroughputLevel = z.infer<typeof throughputLevelSchema>;
export type PhoneNumberStatus = z.infer<typeof phoneNumberStatusSchema>;
export type CodeVerificationStatus = z.infer<typeof codeVerificationStatusSchema>;
export type NameStatus = z.infer<typeof nameStatusSchema>;
export type VerificationCodeMethod = z.infer<typeof verificationCodeMethodSchema>;

/**
 * What happened to a resource a WebSocket event announces. A `deleted` event still carries the
 * whole resource, so the UI can name what disappeared without having kept it around.
 */
export const CHANGE_EVENTS = ["created", "updated", "deleted"] as const;

export const changeEventSchema = z.enum(CHANGE_EVENTS);

export type ChangeEvent = z.infer<typeof changeEventSchema>;

/** A Meta object id (WABA, phone number, media, template): digits only (SPEC §1.3). */
export const metaIdSchema = z.string().regex(/^\d{1,32}$/, "must be a string of 1-32 digits");

/** A `wa_id`: MSISDN digits, or the business-scoped user id form (SPEC §1.15). */
export const waIdSchema = z.string().min(1).max(128);

/**
 * A **business-scoped user id** (BSUID) — `BR.ENT.4KgQ2wJ8`, `US.4KgQ2wJ8` — exactly as the
 * consumer validates it (SPEC §1.15). It is the identity `contacts[].user_id`,
 * `messages[].from_user_id` and `statuses[].recipient_user_id` carry, and the one a send
 * addressed by `recipient` resolves a contact through.
 */
export const BSUID_PATTERN = /^[A-Z]{2}\.(ENT\.)?[0-9A-Za-z]{1,128}$/;

export const userIdSchema = z
	.string()
	.regex(BSUID_PATTERN, "must be a business-scoped user id, e.g. BR.ENT.4KgQ2wJ8 or US.4KgQ2wJ8");

/** Any JSON object whaloc stores or echoes verbatim (message payloads, template components). */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = z.infer<typeof jsonObjectSchema>;

/**
 * The control plane's error body (SPEC §8) — plain, not Meta's envelope, because the UI is
 * whaloc's own client and not the app under test.
 */
export const controlErrorSchema = z.object({
	error: z.object({
		message: z.string(),
		code: z.string().optional(),
	}),
});

export type ControlError = z.infer<typeof controlErrorSchema>;

/** Cursor paging shared by the delivery log and the conversation history. */
export const pagingSchema = z.object({
	/** Cursor for the next (older) page; `null` when the listing reached the end. */
	before: z.string().nullable(),
});

export type Paging = z.infer<typeof pagingSchema>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** `?limit=&before=` on a listing route; both arrive as strings on the query string. */
export const pageQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
	before: z.string().min(1).optional(),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;
