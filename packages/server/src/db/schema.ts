import type { InjectionPreset, InjectionTarget, InjectionTriggerKind } from "@whaloc/shared";
import type { QualityRating, TemplateCategory, TemplateParameterFormat, ThroughputLevel } from "../config/index.ts";

/**
 * The Kysely `Database` interface: one entry per table, columns exactly as SQLite stores
 * them (snake_case, JSON as TEXT). Repositories are the only consumers — everything above
 * them works with the camelCase records those repositories return.
 *
 * **Timestamps are ISO 8601 strings in UTC** (`2026-08-31T12:00:00.000Z`), stored as TEXT.
 * They sort lexicographically, read well in a SQLite shell, and are what the control-plane
 * API serves; the unix-seconds strings Meta's webhooks use (SPEC §1.14) are derived at
 * emission time, never stored.
 */
export interface Database {
	wabas: WabaTable;
	phone_numbers: PhoneNumberTable;
	contacts: ContactTable;
	templates: TemplateTable;
	messages: MessageTable;
	media: MediaTable;
	webhook_deliveries: WebhookDeliveryTable;
	injection_rules: InjectionRuleTable;
	expired_tokens: ExpiredTokenTable;
	upload_sessions: UploadSessionTable;
}

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export const MESSAGE_STATUSES = ["accepted", "sent", "delivered", "read", "failed"] as const;

/** Types accepted by `POST /{phoneNumberId}/messages` (SPEC §2.5) plus the inbound-only ones. */
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
	/** Inbound-only: Meta's placeholder for a message this API version cannot represent (SPEC §5). */
	"unsupported",
	"unknown",
] as const;

/**
 * A phone number's lifecycle vocabulary, copied from the vendored specs: `status` from
 * account-number.yaml's `WhatsAppAccountNumberStatus`, the other two from
 * `WhatsAppCodeVerificationStatus` and `WhatsAppDisplayNameStatus`. Only the values whaloc's
 * ladder actually reaches are documented in SPEC §4; the rest exist so a consumer that switches
 * on the enum sees the same set Meta would send.
 */
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
/** `code_method` of `POST /{phoneNumberId}/request_code`. */
export const VERIFICATION_CODE_METHODS = ["SMS", "VOICE"] as const;

/** A template's own vocabulary; the two a seed can set live in `config/seed.ts`. */
export const TEMPLATE_STATUSES = ["PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED"] as const;

export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type MessageType = (typeof MESSAGE_TYPES)[number];
export type PhoneNumberStatus = (typeof PHONE_NUMBER_STATUSES)[number];
export type CodeVerificationStatus = (typeof CODE_VERIFICATION_STATUSES)[number];
export type NameStatus = (typeof NAME_STATUSES)[number];
export type VerificationCodeMethod = (typeof VERIFICATION_CODE_METHODS)[number];
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export interface WabaTable {
	/** Digit-only Meta-shaped id. */
	id: string;
	name: string;
	/** When an app subscribed to this WABA's webhooks; `null` when none has (SPEC §2.20). */
	subscribed_at: string | null;
	created_at: string;
}

export interface PhoneNumberTable {
	id: string;
	waba_id: string;
	/** Formatted, e.g. `+55 11 91234-5678` (SPEC §2.1 — never blank). */
	display_phone_number: string;
	verified_name: string;
	quality_rating: QualityRating;
	throughput_level: ThroughputLevel;
	/** Only `CONNECTED` may send (SPEC §4); seeded numbers start there. */
	status: PhoneNumberStatus;
	code_verification_status: CodeVerificationStatus;
	name_status: NameStatus;
	/** The 6-digit code `request_code` generated, `null` once verified or never asked for. */
	verification_code: string | null;
	verification_code_method: VerificationCodeMethod | null;
	/** The `language` the code was requested in, echoed back to the UI. */
	verification_code_language: string | null;
	/** JSON object of the business profile this number publishes, `{}` when unset (SPEC §2.19). */
	business_profile: string;
	created_at: string;
}

export interface ContactTable {
	/** MSISDN digits; contacts are global, the same person can talk to several numbers. */
	wa_id: string;
	profile_name: string;
	/**
	 * The contact's business-scoped user id (BSUID, SPEC §1.15), `null` when it has none. Unique
	 * when set: it is what a send addressed by `recipient` resolves a contact through.
	 */
	user_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface TemplateTable {
	id: string;
	waba_id: string;
	name: string;
	language: string;
	category: TemplateCategory;
	parameter_format: TemplateParameterFormat;
	/** JSON array of Meta template components. */
	components: string;
	status: TemplateStatus;
	rejected_reason: string | null;
	quality_score: QualityRating | null;
	created_at: string;
	updated_at: string;
}

export interface MessageTable {
	/** The wamid (SPEC §1.2). */
	id: string;
	direction: MessageDirection;
	phone_number_id: string;
	/** The other side of the conversation, always the contact's `wa_id`. */
	contact_wa_id: string;
	type: MessageType;
	/** JSON object holding the typed body Meta echoes back (`text`, `image`, …). */
	payload: string;
	status: MessageStatus;
	/** JSON object with Meta's error node once a message fails, `null` otherwise. */
	error: string | null;
	/** wamid this message replies to (`context.message_id`), `null` otherwise. */
	reply_to: string | null;
	/**
	 * The `biz_opaque_callback_data` an outbound send carried (SPEC §2.5), echoed on every status
	 * webhook this message produces. `null` for a send that named none and for anything inbound.
	 */
	biz_opaque_callback_data: string | null;
	/** When the message was sent or received — the value webhooks report as Unix seconds. */
	timestamp: string;
	created_at: string;
	updated_at: string;
}

export interface MediaTable {
	id: string;
	phone_number_id: string;
	mime_type: string;
	/** Hex digest captured while the bytes were streamed into storage. */
	sha256: string;
	file_size: number;
	/** Opaque handle owned by the `MediaStorage` implementation. */
	storage_key: string;
	/** Opaque token in the public `/whaloc-media/:token` URL (SPEC §2.12). */
	url_token: string;
	created_at: string;
}

export interface WebhookDeliveryTable {
	id: string;
	event_type: string;
	url: string;
	/** The exact bytes that were signed and POSTed (SPEC §1.12). */
	request_body: string;
	/** JSON object of request headers. */
	request_headers: string;
	response_status: number | null;
	response_body: string | null;
	error: string | null;
	/** 1-based attempt number; retries are separate rows (SPEC §3). */
	attempt: number;
	duration_ms: number | null;
	created_at: string;
}

/**
 * One error-injection rule (SPEC §4, "Error simulation"). The counters live in the row rather
 * than in memory, so a rule armed before a restart keeps its countdown with a file database —
 * unlike the status-ladder timers, an injection rule is state and not a pending task.
 */
export interface InjectionRuleTable {
	id: string;
	target: InjectionTarget;
	trigger_kind: InjectionTriggerKind;
	/** `count` of a `next` trigger, `nth` of an `every` one; `null` for `always`. */
	trigger_count: number | null;
	preset: InjectionPreset;
	/** `Retry-After` in delta-seconds; only the 429 presets use it. */
	retry_after_seconds: number | null;
	/** `estimated_time_to_regain_access`, in minutes (SPEC §1.11). */
	regain_access_minutes: number | null;
	/** JSON object of the `custom` preset's envelope, `null` for every other preset. */
	custom: string | null;
	/** Matching requests seen, whether or not the rule fired on them. */
	seen: number;
	/** Responses actually injected. */
	matches: number;
	/** Countdown of a `next` trigger; `null` for the other two. */
	remaining: number | null;
	created_at: string;
	updated_at: string;
}

/**
 * The registered bearer tokens that are currently "expired" (SPEC §1.9).
 *
 * Keyed by the token's derived id — a truncated SHA-256 — so a persisted database never holds a
 * credential: the registry itself lives in `WHALOC_TOKENS`, and this table only remembers which
 * of those tokens the control plane invalidated. A token missing from the table is valid.
 */
export interface ExpiredTokenTable {
	token_id: string;
	expired_at: string;
}

/**
 * One Resumable Upload API session (SPEC §2.21), and — once it has received every byte — the
 * **handle** it produced.
 *
 * The two live in one row because they are one thing seen at two moments: `POST /{appId}/uploads`
 * opens it, `POST /upload:<id>` fills it, and everything afterwards (a template's
 * `example.header_handle`, a `profile_picture_handle`) only ever looks it up by `handle`. A row
 * whose `handle` is still `null` is an upload in progress.
 */
export interface UploadSessionTable {
	/** The opaque part of the session id; the path segment is `upload:<id>`. */
	id: string;
	/** The `{appId}` the session was opened under, echoed nowhere — kept for the delivery log's sake. */
	app_id: string;
	file_name: string | null;
	/** `file_type`: the MIME type the session declared, and what the handle's bytes are served as. */
	file_type: string;
	/** `file_length`: how many bytes the session promised. A completed upload has received exactly this many. */
	file_length: number;
	/** How many bytes have arrived; what `GET /upload:<id>` reports as `file_offset`. */
	received_bytes: number;
	/** The opaque handle, `null` until the last byte lands. */
	handle: string | null;
	/** Where the bytes went through `MediaStorage`; `null` before the first chunk. */
	storage_key: string | null;
	sha256: string | null;
	/** Opaque token in the public `/whaloc-upload/:token` URL (SPEC §2.22); minted with the handle. */
	url_token: string | null;
	created_at: string;
	updated_at: string;
}
