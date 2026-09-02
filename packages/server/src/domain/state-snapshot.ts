import {
	injectionPresetSchema,
	injectionTargetSchema,
	injectionTriggerKindSchema,
	qualityRatingSchema,
	templateCategorySchema,
	templateParameterFormatSchema,
	throughputLevelSchema,
} from "@whaloc/shared";
import { z } from "zod";
import {
	CODE_VERIFICATION_STATUSES,
	MESSAGE_DIRECTIONS,
	MESSAGE_STATUSES,
	MESSAGE_TYPES,
	NAME_STATUSES,
	PHONE_NUMBER_STATUSES,
	TEMPLATE_STATUSES,
	VERIFICATION_CODE_METHODS,
	type SnapshotTables,
} from "../db/index.ts";
import { STORAGE_KEY_PATTERN } from "../storage/index.ts";

/**
 * The state snapshot `GET /api/export` writes and `POST /api/import` reads (SPEC §5).
 *
 * **A snapshot is a database dump with the media bytes inlined**, not an API resource: the
 * envelope is whaloc's (camelCase), while `tables` holds the rows exactly as SQLite stores
 * them — snake_case columns, JSON columns still encoded as TEXT. That is deliberate. A dump
 * that went through the control-plane DTOs would quietly drop every column those DTOs do not
 * serve, and a snapshot that cannot restore a phone number's pending verification code or a
 * webhook subscription is not a snapshot.
 *
 * Everything below is validated before a single row is written, because an import **replaces
 * all state**: a snapshot that would fail halfway must fail before anything is deleted.
 */

/** Bumped when a snapshot's shape changes in a way an older whaloc could not read. */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** Timestamps are ISO 8601 in UTC everywhere in the database (see the `Database` interface). */
const timestamp = z.iso.datetime();
/** A column holding JSON as TEXT: still a string here, exactly as it is stored. */
const jsonText = z.string();
const nullable = <TSchema extends z.ZodType>(schema: TSchema) => schema.nullable();

const wabaRowSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	subscribed_at: nullable(timestamp),
	created_at: timestamp,
});

const phoneNumberRowSchema = z.object({
	id: z.string().min(1),
	waba_id: z.string().min(1),
	display_phone_number: z.string(),
	verified_name: z.string(),
	quality_rating: qualityRatingSchema,
	throughput_level: throughputLevelSchema,
	status: z.enum(PHONE_NUMBER_STATUSES),
	code_verification_status: z.enum(CODE_VERIFICATION_STATUSES),
	name_status: z.enum(NAME_STATUSES),
	verification_code: nullable(z.string()),
	verification_code_method: nullable(z.enum(VERIFICATION_CODE_METHODS)),
	verification_code_language: nullable(z.string()),
	business_profile: jsonText,
	created_at: timestamp,
});

const contactRowSchema = z.object({
	wa_id: z.string().min(1),
	profile_name: z.string(),
	user_id: nullable(z.string()),
	created_at: timestamp,
	updated_at: timestamp,
});

const templateRowSchema = z.object({
	id: z.string().min(1),
	waba_id: z.string().min(1),
	name: z.string(),
	language: z.string(),
	category: templateCategorySchema,
	parameter_format: templateParameterFormatSchema,
	components: jsonText,
	status: z.enum(TEMPLATE_STATUSES),
	rejected_reason: nullable(z.string()),
	quality_score: nullable(qualityRatingSchema),
	created_at: timestamp,
	updated_at: timestamp,
});

const messageRowSchema = z.object({
	id: z.string().min(1),
	direction: z.enum(MESSAGE_DIRECTIONS),
	phone_number_id: z.string().min(1),
	contact_wa_id: z.string().min(1),
	type: z.enum(MESSAGE_TYPES),
	payload: jsonText,
	status: z.enum(MESSAGE_STATUSES),
	error: nullable(jsonText),
	reply_to: nullable(z.string()),
	// Added after the first snapshots were written (SPEC §2.5), so a file that predates it loads
	// as the `null` those messages carried rather than being refused for a column it never had.
	biz_opaque_callback_data: nullable(z.string()).default(null),
	timestamp,
	created_at: timestamp,
	updated_at: timestamp,
});

const mediaRowSchema = z.object({
	id: z.string().min(1),
	phone_number_id: z.string().min(1),
	mime_type: z.string(),
	sha256: z.string(),
	file_size: z.int().nonnegative(),
	// The same alphabet both backends accept, so a key travels between them (SPEC §6).
	storage_key: z.string().regex(STORAGE_KEY_PATTERN, "is not a valid media storage key"),
	url_token: z.string().min(1),
	created_at: timestamp,
});

/**
 * A Resumable Upload API session (SPEC §2.21). A completed one carries the handle a template's
 * `example.header_handle` names, so it travels with the snapshot — and its bytes travel in
 * `mediaObjects` next to the media rows', which is what makes an imported template preview.
 */
const uploadSessionRowSchema = z.object({
	id: z.string().min(1),
	app_id: z.string().min(1),
	file_name: nullable(z.string()),
	file_type: z.string(),
	file_length: z.int().nonnegative(),
	received_bytes: z.int().nonnegative(),
	handle: nullable(z.string()),
	storage_key: nullable(z.string().regex(STORAGE_KEY_PATTERN, "is not a valid media storage key")),
	sha256: nullable(z.string()),
	url_token: nullable(z.string()),
	created_at: timestamp,
	updated_at: timestamp,
});

const webhookDeliveryRowSchema = z.object({
	id: z.string().min(1),
	event_type: z.string(),
	url: z.string(),
	request_body: z.string(),
	request_headers: jsonText,
	response_status: nullable(z.int()),
	response_body: nullable(z.string()),
	error: nullable(z.string()),
	attempt: z.int().nonnegative(),
	duration_ms: nullable(z.int()),
	created_at: timestamp,
});

const injectionRuleRowSchema = z.object({
	id: z.string().min(1),
	target: injectionTargetSchema,
	trigger_kind: injectionTriggerKindSchema,
	trigger_count: nullable(z.int()),
	preset: injectionPresetSchema,
	retry_after_seconds: nullable(z.int()),
	regain_access_minutes: nullable(z.int()),
	custom: nullable(jsonText),
	seen: z.int().nonnegative(),
	matches: z.int().nonnegative(),
	remaining: nullable(z.int()),
	created_at: timestamp,
	updated_at: timestamp,
});

const expiredTokenRowSchema = z.object({ token_id: z.string().min(1), expired_at: timestamp });

/**
 * One media object's bytes, base64-inlined next to its row.
 *
 * **A snapshot is one self-contained file** — that is the whole point of it as a "shareable
 * test scenario" — so the bytes travel with the metadata rather than as a sidecar the receiver
 * has to be given separately. It costs about a third in size over the raw bytes, which is the
 * trade a dev tool should make: media in a whaloc is a handful of test images, and a snapshot
 * that only half-restores is worse than a large one.
 *
 * `bytes: null` means the object was already missing from storage when the export ran — the
 * row is kept (so the message pointing at it still resolves) and the import says how many.
 */
const snapshotMediaObjectSchema = z.object({
	storageKey: z.string().regex(STORAGE_KEY_PATTERN, "is not a valid media storage key"),
	bytes: nullable(z.base64()),
});

export type SnapshotMediaObject = z.infer<typeof snapshotMediaObjectSchema>;

export const snapshotTablesSchema = z.object({
	wabas: z.array(wabaRowSchema),
	phone_numbers: z.array(phoneNumberRowSchema),
	contacts: z.array(contactRowSchema),
	templates: z.array(templateRowSchema),
	messages: z.array(messageRowSchema),
	media: z.array(mediaRowSchema),
	// Added with the Upload API; a snapshot written before it simply has none.
	upload_sessions: z.array(uploadSessionRowSchema).default([]),
	// Absent from an export unless `?include=deliveries` asked for it; an import takes either.
	webhook_deliveries: z.array(webhookDeliveryRowSchema).default([]),
	injection_rules: z.array(injectionRuleRowSchema).default([]),
	expired_tokens: z.array(expiredTokenRowSchema).default([]),
});

export const stateSnapshotSchema = z.object({
	/** What a reader has to understand to load this file; gated on import. */
	schemaVersion: z.int().positive(),
	/** Informational: which whaloc wrote it. Nothing keys behavior on it. */
	whalocVersion: z.string(),
	exportedAt: timestamp,
	tables: snapshotTablesSchema,
	/** One entry per media row, then one per completed upload session — in the rows' own order. */
	mediaObjects: z.array(snapshotMediaObjectSchema),
});

export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;

/**
 * `stateSnapshotSchema` and the repository's `SnapshotTables` describe the same rows from two
 * directions, and this is where the compiler is told so: a column added to the database
 * without being added to the schema above stops building here, rather than at the first
 * import that silently dropped it.
 */
export type SnapshotTablesCheck = StateSnapshot["tables"] extends SnapshotTables ? true : never;
