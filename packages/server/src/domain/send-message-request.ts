import { z } from "zod";

/**
 * The `POST /{phoneNumberId}/messages` envelope (SPEC §2.5), covering all eleven send types.
 *
 * It lives in the domain rather than next to the Hono routes because the message service is
 * typed by it; the routes only run `sendMessageRequestSchema.safeParse` on the parsed body and
 * translate a failure into Meta's `(#100) Invalid parameter` envelope.
 *
 * Two deliberate looseness choices, both because whaloc is an emulator and not a validator:
 *
 * - `interactive` and `contacts` are passed through unchecked. Their real schemas are large,
 *   version-dependent, and Meta rejects far less than the OpenAPI spec implies; a mock that
 *   rejects a valid interactive payload is worse than one that stores an odd one.
 * - Unknown top-level keys (`recipient_type`, …) are ignored rather than rejected, matching
 *   Meta, which accepts and drops what it does not know.
 */

const jsonObject = z.record(z.string(), z.unknown());

/**
 * The eleven `type` values a send may carry (SPEC §2.5), in the order the spec lists them.
 * Kept in step with the schema below by a test.
 */
export const SEND_MESSAGE_TYPES = [
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
] as const;

/** Meta accepts numbers and numeric strings for coordinates; both round-trip as given. */
const coordinateSchema = z.union([z.number(), z.string().min(1)]);

export const textPayloadSchema = z.object({
	body: z.string().min(1),
	preview_url: z.boolean().optional(),
});

export const templateLanguageSchema = z.object({
	code: z.string().min(1),
	policy: z.string().optional(),
});

export const templatePayloadSchema = z.object({
	name: z.string().min(1),
	language: templateLanguageSchema,
	components: z.array(jsonObject).optional(),
});

export const locationPayloadSchema = z.object({
	latitude: coordinateSchema,
	longitude: coordinateSchema,
	name: z.string().optional(),
	address: z.string().optional(),
});

export const reactionPayloadSchema = z.object({
	message_id: z.string().min(1),
	/** An empty emoji removes a reaction, which is why this is not `.min(1)`. */
	emoji: z.string(),
});

/** Every media node is `{id}` or `{link}`, plus whatever extras that type allows. */
function mediaNodeSchema(extra: z.ZodRawShape = {}) {
	return z
		.object({ id: z.string().min(1).optional(), link: z.string().min(1).optional(), ...extra })
		.refine(node => node.id !== undefined || node.link !== undefined, "must carry either id or link");
}

const captionShape = { caption: z.string().optional() };
const documentShape = { ...captionShape, filename: z.string().optional() };

/** Meta's cap on `biz_opaque_callback_data`, enforced with the `(#100)` envelope (SPEC §2.5). */
export const MAX_BIZ_OPAQUE_CALLBACK_DATA_LENGTH = 512;

const baseSchema = z.object({
	messaging_product: z.literal("whatsapp", "Param messaging_product must be whatsapp"),
	/** MSISDN (SPEC §1.15); `recipient` is the business-scoped alternative. */
	to: z.string().min(1).optional(),
	recipient: z.string().min(1).optional(),
	context: z.object({ message_id: z.string().min(1) }).optional(),
	/**
	 * An arbitrary string the app under test attaches to a send and gets back on **every** status
	 * webhook for it (SPEC §2.5). whaloc stores it verbatim and never interprets it; Meta caps it
	 * at 512 characters, and so does this.
	 */
	biz_opaque_callback_data: z
		.string()
		.max(
			MAX_BIZ_OPAQUE_CALLBACK_DATA_LENGTH,
			`Param biz_opaque_callback_data must be at most ${String(MAX_BIZ_OPAQUE_CALLBACK_DATA_LENGTH)} characters`,
		)
		.optional(),
});

const typedRequestSchema = z.discriminatedUnion("type", [
	baseSchema.extend({ type: z.literal("text"), text: textPayloadSchema }),
	baseSchema.extend({ type: z.literal("template"), template: templatePayloadSchema }),
	baseSchema.extend({ type: z.literal("image"), image: mediaNodeSchema(captionShape) }),
	baseSchema.extend({ type: z.literal("video"), video: mediaNodeSchema(captionShape) }),
	baseSchema.extend({ type: z.literal("audio"), audio: mediaNodeSchema() }),
	baseSchema.extend({ type: z.literal("document"), document: mediaNodeSchema(documentShape) }),
	baseSchema.extend({ type: z.literal("sticker"), sticker: mediaNodeSchema() }),
	baseSchema.extend({ type: z.literal("interactive"), interactive: jsonObject }),
	baseSchema.extend({ type: z.literal("location"), location: locationPayloadSchema }),
	baseSchema.extend({ type: z.literal("reaction"), reaction: reactionPayloadSchema }),
	baseSchema.extend({ type: z.literal("contacts"), contacts: z.array(jsonObject).min(1) }),
]);

/** Meta treats a send without an explicit `type` as a text message. */
function withDefaultType(value: unknown): unknown {
	if (typeof value === "object" && value !== null && !("type" in value)) {
		return { ...value, type: "text" };
	}

	return value;
}

export const sendMessageRequestSchema = z
	.preprocess(withDefaultType, typedRequestSchema)
	.refine(
		request => request.to !== undefined || request.recipient !== undefined,
		"Param to is required, or recipient for a business-scoped user id",
	);

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export type SendMessageType = SendMessageRequest["type"];
export type TemplatePayload = z.infer<typeof templatePayloadSchema>;

/**
 * The node Meta echoes into webhooks, keyed by the message type — `{text: {…}}`,
 * `{image: {…}}`, `{contacts: [...]}`. Stored as the message payload so the webhook builders
 * (SPEC §3) can emit it unchanged.
 */
export function messagePayloadOf(request: SendMessageRequest): Record<string, unknown> {
	const { type } = request;
	const node: unknown = (request as Record<string, unknown>)[type];

	return { [type]: node };
}
