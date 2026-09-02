import { z } from "zod";
import { changeEventSchema } from "./control-plane/common.ts";
import { contactSchema } from "./control-plane/contacts.ts";
import { injectionRuleSchema } from "./control-plane/injection.ts";
import { messageSchema } from "./control-plane/messages.ts";
import { phoneNumberSchema } from "./control-plane/phone-numbers.ts";
import { stateResponseSchema } from "./control-plane/state.ts";
import { templateSchema } from "./control-plane/templates.ts";
import { tokenStateSchema } from "./control-plane/tokens.ts";
import { typingIndicatorSchema } from "./control-plane/typing.ts";
import { wabaSchema } from "./control-plane/wabas.ts";
import { webhookDeliverySchema } from "./control-plane/webhooks.ts";

/**
 * Server → client events pushed over the control-plane WebSocket (`/api/ws`, SPEC §5).
 *
 * The UI is a pure client of REST + WS: every event carries the whole resource that changed,
 * so a client can update its view without a follow-up request.
 */
export const WS_EVENT_TYPES = [
	"message.created",
	"message.status_changed",
	"typing.changed",
	"template.changed",
	"webhook.delivery",
	"contact.changed",
	"waba.changed",
	"phone_number.changed",
	"injection.changed",
	"token.changed",
	"state.reset",
	"state.imported",
] as const;

export const wsEventTypeSchema = z.enum(WS_EVENT_TYPES);

export type WsEventType = z.infer<typeof wsEventTypeSchema>;

const messagePayloadSchema = z.object({ message: messageSchema });
const statusPayloadSchema = z.object({ message: messageSchema, previousStatus: messageSchema.shape.status });
const typingPayloadSchema = z.object({ typing: typingIndicatorSchema });
const templatePayloadSchema = z.object({ template: templateSchema, event: z.string() });
const deliveryPayloadSchema = z.object({ delivery: webhookDeliverySchema });
/**
 * `previousWaId` is present only when the contact **moved to a new number** (SPEC §5): the
 * conversation id is derived from `(phoneNumberId, contactWaId)`, so a client that keys anything
 * by it needs the old value to re-key rather than to end up with two half-conversations.
 */
const contactPayloadSchema = z.object({ contact: contactSchema, previousWaId: z.string().optional() });
const wabaPayloadSchema = z.object({ waba: wabaSchema, event: changeEventSchema });
const phoneNumberPayloadSchema = z.object({ phoneNumber: phoneNumberSchema, event: changeEventSchema });
const injectionPayloadSchema = z.object({ rule: injectionRuleSchema, event: changeEventSchema });
const tokenPayloadSchema = z.object({ token: tokenStateSchema });
const resetPayloadSchema = z.object({ state: stateResponseSchema });

export const wsEventSchema = z.discriminatedUnion("type", [
	/** A message was persisted, in either direction. */
	z.object({ type: z.literal("message.created"), payload: messagePayloadSchema }),
	/** A message moved along the status ladder (SPEC §4); the payload is the updated message. */
	z.object({ type: z.literal("message.status_changed"), payload: statusPayloadSchema }),
	/**
	 * A typing indicator went up or came down (SPEC §2.18). `payload.typing.expiresAt` is `null`
	 * when it is gone — dismissed after Meta's 25-second window, or cleared by the next outbound
	 * message in that conversation.
	 *
	 * A *read* receipt has no event of its own: marking an inbound message read moves its status
	 * to `read`, so it arrives as `message.status_changed` like every other status move.
	 */
	z.object({ type: z.literal("typing.changed"), payload: typingPayloadSchema }),
	/** A template transition — the `event` is the one the webhook carries (`APPROVED`, …). */
	z.object({ type: z.literal("template.changed"), payload: templatePayloadSchema }),
	/** One webhook delivery attempt was logged, successful or not. */
	z.object({ type: z.literal("webhook.delivery"), payload: deliveryPayloadSchema }),
	z.object({ type: z.literal("contact.changed"), payload: contactPayloadSchema }),
	/** A WABA was created, renamed or deleted through the control plane (SPEC §5). */
	z.object({ type: z.literal("waba.changed"), payload: wabaPayloadSchema }),
	/**
	 * A phone number changed: created or edited through the control plane, or moved along the
	 * registration ladder by the Graph endpoints (SPEC §4) — a `request_code` lands here too, so
	 * the UI can show the code without being asked.
	 */
	z.object({ type: z.literal("phone_number.changed"), payload: phoneNumberPayloadSchema }),
	/**
	 * An error-injection rule was added, deleted, or **advanced by a request it matched** (SPEC
	 * §4): the `updated` event is what makes the UI's countdown live, and it is announced for
	 * every rule the request touched, not only the one that fired. Rules are few and deliberate,
	 * so this stays quiet unless someone armed an `always` rule — which is exactly when a visible
	 * reminder is wanted.
	 */
	z.object({ type: z.literal("injection.changed"), payload: injectionPayloadSchema }),
	/** A registered bearer token was marked expired, or restored (SPEC §1.9). */
	z.object({ type: z.literal("token.changed"), payload: tokenPayloadSchema }),
	/** `POST /api/reset` wiped everything; the payload is the state the server came back with. */
	z.object({ type: z.literal("state.reset"), payload: resetPayloadSchema }),
	/**
	 * `POST /api/import` replaced everything with a snapshot (SPEC §5). A client reacts exactly
	 * as it does to `state.reset` — drop what it holds and reload — but the two are told apart
	 * because one comes back to `WHALOC_SEED` and the other to somebody else's world.
	 */
	z.object({ type: z.literal("state.imported"), payload: resetPayloadSchema }),
]);

export type WsEvent = z.infer<typeof wsEventSchema>;

export type WsEventOf<TType extends WsEventType> = Extract<WsEvent, { type: TType }>;
