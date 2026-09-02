import { z } from "zod";

/**
 * The *other* body `POST /{phoneNumberId}/messages` accepts (SPEC §2.18): a read receipt, with
 * an optional typing indicator riding along.
 *
 * Meta overloads the send endpoint for this — the vendored spec calls the shape
 * `MarkMessageRequestPayload` (`docs/meta-openapi/messages.yaml`) and documents the combined
 * form as the "Send typing indicator and read receipt" example — so `status: "read"` is what
 * tells the two bodies apart. The response is `{"success": true}` either way.
 */

/** The only `typing_indicator.type` Meta defines today. */
export const TYPING_INDICATOR_TYPES = ["text"] as const;

export type TypingIndicatorType = (typeof TYPING_INDICATOR_TYPES)[number];

export const typingIndicatorRequestSchema = z.object({
	type: z.enum(TYPING_INDICATOR_TYPES, "Param typing_indicator.type must be text"),
});

export const markReadRequestSchema = z.object({
	messaging_product: z.literal("whatsapp", "Param messaging_product must be whatsapp"),
	status: z.literal("read", "Param status must be read"),
	/** The wamid of the **inbound** message the business has now read. */
	message_id: z.string().min(1),
	typing_indicator: typingIndicatorRequestSchema.optional(),
});

export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

/**
 * Whether a body on the send route is a read receipt rather than a message.
 *
 * `status` is the discriminator, and it is read before validation: a send has no `status`, and
 * a body that says `status: "read"` can only have meant the receipt — so reporting *its*
 * validation errors beats reporting "this is not a valid text message".
 */
export function isMarkReadBody(body: unknown): boolean {
	return typeof body === "object" && body !== null && (body as Record<string, unknown>)["status"] === "read";
}
