import { z } from "zod";
import { jsonObjectSchema, metaIdSchema, waIdSchema } from "./common.ts";
import { messageSchema } from "./messages.ts";

/**
 * `POST /api/inbound` — the "user side" of a conversation (SPEC §5). One branch per inbound
 * type; the server persists the message and emits the webhook Meta would have sent.
 */

/** `source_type` of a click-to-WhatsApp `referral`: the ad, or the organic post, that was tapped. */
export const REFERRAL_SOURCE_TYPES = ["ad", "post"] as const;

export type ReferralSourceType = (typeof REFERRAL_SOURCE_TYPES)[number];

/** `media_type` of a referral's creative; a text-only ad carries none. */
export const REFERRAL_MEDIA_TYPES = ["image", "video"] as const;

export type ReferralMediaType = (typeof REFERRAL_MEDIA_TYPES)[number];

/**
 * The click-to-WhatsApp `referral` node (SPEC §5).
 *
 * Written in Meta's own snake_case, like `location`, `interactive` and `contacts`: it rides
 * **top-level on the message**, verbatim, so the shape a test writes here is the shape the
 * webhook carries. Only `source_url`, `source_type` and `source_id` are required — the rest
 * describe the creative and Meta omits whichever the ad did not have.
 */
export const inboundReferralSchema = z.object({
	source_url: z.string().min(1),
	source_type: z.enum(REFERRAL_SOURCE_TYPES),
	source_id: z.string().min(1),
	headline: z.string().min(1).optional(),
	body: z.string().min(1).optional(),
	media_type: z.enum(REFERRAL_MEDIA_TYPES).optional(),
	image_url: z.string().min(1).optional(),
	video_url: z.string().min(1).optional(),
	thumbnail_url: z.string().min(1).optional(),
	/** The click id Meta mints for a click-to-WhatsApp ad, which consumers attribute on. */
	ctwa_clid: z.string().min(1).optional(),
	/**
	 * The greeting the ad pre-filled into the chat. Meta sends it as a nested object rather than
	 * a bare string, and attribution handlers read it to tell an ad-generated opener apart from
	 * something the person actually typed.
	 */
	welcome_message: z.object({ text: z.string().min(1) }).optional(),
});

export type InboundReferral = z.infer<typeof inboundReferralSchema>;

/**
 * The product a message was sent *about*, from a catalog. Unlike `referral` this one rides
 * **inside `context`**, which is why it is a rider rather than a message type of its own.
 */
export const inboundReferredProductSchema = z.object({
	catalog_id: z.string().min(1),
	product_retailer_id: z.string().min(1),
});

export type InboundReferredProduct = z.infer<typeof inboundReferredProductSchema>;

const inboundBaseSchema = z.object({
	phoneNumberId: metaIdSchema,
	/** Who the message is from — an existing contact, or one created on the spot. */
	from: waIdSchema,
	/** Sets (or updates) the contact's WhatsApp profile name; defaults to the `wa_id`. */
	profileName: z.string().min(1).optional(),
	/** wamid this message replies to; becomes the message's `context` node. */
	replyTo: z.string().min(1).optional(),
	/** When it was received; defaults to now. */
	timestamp: z.iso.datetime().optional(),
	/**
	 * Context riders, accepted on **every** inbound type (SPEC §5). They are whaloc's camelCase
	 * because they are flags rather than Meta nodes; where they land in the payload is Meta's:
	 * `forwarded`/`frequentlyForwarded` and `referredProduct` go inside `context` — merged with
	 * the reply `context` that `replyTo` produces — and `referral` rides top-level.
	 */
	forwarded: z.boolean().optional(),
	frequentlyForwarded: z.boolean().optional(),
	referredProduct: inboundReferredProductSchema.optional(),
	referral: inboundReferralSchema.optional(),
});

/** Every media type carries the same node: an id from a previous upload, plus extras. */
const inboundMediaSchema = z.object({
	/** Media id from `POST /api/inbound-media` or `POST /{phoneNumberId}/media`. */
	id: metaIdSchema,
	caption: z.string().optional(),
	filename: z.string().optional(),
	/**
	 * `audio.voice` — whether the recording was made with the WhatsApp client's voice-note
	 * button rather than attached as a file. Meta reports it on **every** audio node, so whaloc
	 * always sends it too; `false` is the default because an attached file is the general case.
	 * Ignored for every other media type, which is what Meta does with it.
	 */
	voice: z.boolean().optional(),
	/**
	 * `sticker.animated` — Meta reports it on **every** sticker node, so whaloc always sends it.
	 * Ignored for every other media type.
	 */
	animated: z.boolean().optional(),
});

export const INBOUND_MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"] as const;

export type InboundMediaType = (typeof INBOUND_MEDIA_TYPES)[number];

function mediaBranch<TType extends InboundMediaType>(type: TType) {
	return inboundBaseSchema.extend({ type: z.literal(type), media: inboundMediaSchema });
}

const interactiveReplySchema = z.object({ id: z.string().min(1), title: z.string().min(1) });
const listReplySchema = interactiveReplySchema.extend({ description: z.string().optional() });

export const inboundInteractiveSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("button_reply"), button_reply: interactiveReplySchema }),
	z.object({ type: z.literal("list_reply"), list_reply: listReplySchema }),
]);

/**
 * `unsupported.type` — the message types Meta says it cannot represent, exactly as its
 * `unsupported` webhook reference lists them.
 */
export const UNSUPPORTED_MESSAGE_TYPES = [
	"button",
	"edit",
	"errors",
	"gif",
	"group_invite",
	"hsm",
	"image",
	"interactive",
	"keep_in_chat",
	"link_preview",
	"list",
	"location",
	"media_placeholder",
	"order",
	"pin",
	"poll_creation",
	"poll_update",
	"product",
	"reaction",
] as const;

export const unsupportedMessageTypeSchema = z.enum(UNSUPPORTED_MESSAGE_TYPES);

export type UnsupportedMessageType = (typeof UNSUPPORTED_MESSAGE_TYPES)[number];

/** What an `unsupported` inbound reports when the caller names no type: a poll, as SPEC §5 puts it. */
export const DEFAULT_UNSUPPORTED_MESSAGE_TYPE: UnsupportedMessageType = "poll_update";

const textSchema = z.object({ body: z.string().min(1) });
/** A quick-reply button on a template message: `payload` is what the template defined. */
const buttonSchema = z.object({ payload: z.string().min(1), text: z.string().min(1) });
const locationSchema = z.object({
	latitude: z.number(),
	longitude: z.number(),
	name: z.string().optional(),
	address: z.string().optional(),
	/** Meta sends it for a business location; a pin someone drops carries none. */
	url: z.string().min(1).optional(),
});
/** Contact cards pass through unchecked, exactly like the Graph send route does. */
const contactCardsSchema = z.array(jsonObjectSchema).min(1);
const reactionSchema = z.object({ message_id: z.string().min(1), emoji: z.string() });

export const inboundRequestSchema = z.discriminatedUnion("type", [
	inboundBaseSchema.extend({ type: z.literal("text"), text: textSchema }),
	mediaBranch("image"),
	mediaBranch("video"),
	mediaBranch("audio"),
	mediaBranch("document"),
	mediaBranch("sticker"),
	inboundBaseSchema.extend({ type: z.literal("interactive"), interactive: inboundInteractiveSchema }),
	inboundBaseSchema.extend({ type: z.literal("button"), button: buttonSchema }),
	inboundBaseSchema.extend({ type: z.literal("location"), location: locationSchema }),
	inboundBaseSchema.extend({ type: z.literal("contacts"), contacts: contactCardsSchema }),
	inboundBaseSchema.extend({ type: z.literal("reaction"), reaction: reactionSchema }),
	/**
	 * A message this API version cannot represent — a poll, or whatever WhatsApp ships next.
	 * Meta describes it with an `errors[]` entry (131051) plus an `unsupported` node naming the
	 * type that could not be represented; the server builds both, so the request carries at most
	 * the name of that type (SPEC §5).
	 */
	inboundBaseSchema.extend({
		type: z.literal("unsupported"),
		unsupportedType: unsupportedMessageTypeSchema.optional(),
	}),
]);

export type InboundRequest = z.infer<typeof inboundRequestSchema>;
export type InboundType = InboundRequest["type"];

export const inboundResponseSchema = z.object({ data: messageSchema });

export type InboundResponse = z.infer<typeof inboundResponseSchema>;

/**
 * `POST /api/inbound-media` — a multipart upload the UI makes before referencing the media id
 * in `POST /api/inbound`. The parts are `phoneNumberId`, `file` and an optional `type`.
 */
const inboundMediaDataSchema = z.object({
	id: z.string(),
	phoneNumberId: z.string(),
	mimeType: z.string(),
	sha256: z.string(),
	fileSize: z.number().int().nonnegative(),
	createdAt: z.iso.datetime(),
});

export const inboundMediaResponseSchema = z.object({ data: inboundMediaDataSchema });

export type InboundMediaResponse = z.infer<typeof inboundMediaResponseSchema>;
