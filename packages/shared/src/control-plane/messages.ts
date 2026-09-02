import { z } from "zod";
import { jsonObjectSchema, messageDirectionSchema, messageStatusSchema, messageTypeSchema } from "./common.ts";

/** One stored message, in either direction (SPEC §5). */
export const messageSchema = z.object({
	id: z.string(),
	direction: messageDirectionSchema,
	phoneNumberId: z.string(),
	contactWaId: z.string(),
	type: messageTypeSchema,
	/** The type-named node Meta echoes into webhooks: `{text:{…}}`, `{image:{…}}`, … */
	payload: jsonObjectSchema,
	status: messageStatusSchema,
	/** Meta's error node once a message failed, `null` otherwise. */
	error: jsonObjectSchema.nullable(),
	/**
	 * The `biz_opaque_callback_data` an outbound send carried, echoed on every status webhook
	 * for it (SPEC §2.5). Absent for a send that named none, and for every inbound message.
	 */
	bizOpaqueCallbackData: z.string().nullable().optional(),
	replyTo: z.string().nullable(),
	timestamp: z.iso.datetime(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type Message = z.infer<typeof messageSchema>;

export const messageResponseSchema = z.object({ data: messageSchema });

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * The failure presets a manual `failed` transition can pick from (SPEC §4). Meta has hundreds
 * of codes; these four are the ones a whaloc user actually wants to rehearse.
 */
export const MESSAGE_ERROR_CODES = [131_049, 131_026, 131_047, 130_472] as const;

export const messageErrorCodeSchema = z.literal(MESSAGE_ERROR_CODES);

export type MessageErrorCode = z.infer<typeof messageErrorCodeSchema>;

/**
 * `POST /api/messages/:id/status` — the manual half of the status ladder. `sent` is not
 * offered: it is what an accepted send emits on its own.
 */
export const messageStatusRequestSchema = z.object({
	status: z.enum(["delivered", "read", "failed"]),
	/** Only read for `failed`; defaults to the engagement preset (131049). */
	errorCode: messageErrorCodeSchema.optional(),
});

export type MessageStatusRequest = z.infer<typeof messageStatusRequestSchema>;

/**
 * `GET /api/message-error-presets` — the same four presets, with the wording Meta uses, so
 * the UI's "fail…" menu shows what the app under test will actually receive instead of a
 * bare code. The list is a server constant; it is served rather than duplicated in the UI so
 * the two can never drift.
 */
export const messageErrorPresetSchema = z.object({
	code: messageErrorCodeSchema,
	title: z.string(),
	message: z.string(),
	details: z.string(),
});

export type MessageErrorPreset = z.infer<typeof messageErrorPresetSchema>;

export const messageErrorPresetListResponseSchema = z.object({ data: z.array(messageErrorPresetSchema) });

export type MessageErrorPresetListResponse = z.infer<typeof messageErrorPresetListResponseSchema>;
