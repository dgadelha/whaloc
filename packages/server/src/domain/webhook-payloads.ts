import { createHash } from "node:crypto";
import type { QualityRating } from "../config/index.ts";
import type { ContactRecord, JsonObject, MessageRecord, PhoneNumberRecord, TemplateRecord } from "../db/index.ts";
import { phoneNumberDigits } from "./phone-number-format.ts";

/**
 * Every webhook body whaloc can send, built to match the captured Meta samples in
 * `docs/fixtures/webhooks/` (SPEC §1, §3). The specs compare what these produce against those
 * files structurally, so a drift from Meta's shape fails a test rather than an integration.
 *
 * Nothing here does I/O or knows about delivery: builders in, JSON out. The emitter signs and
 * POSTs whatever they return.
 */

/** The `field` of a `changes` entry — also the delivery log's event type (SPEC §3). */
export const WEBHOOK_FIELDS = {
	messages: "messages",
	templateStatus: "message_template_status_update",
	templateQuality: "message_template_quality_update",
	phoneNumberQuality: "phone_number_quality_update",
	/** Account-level notices (SPEC §3): both are emissions only, and change no whaloc state. */
	accountUpdate: "account_update",
	businessCapabilityUpdate: "business_capability_update",
} as const;

export type WebhookField = (typeof WEBHOOK_FIELDS)[keyof typeof WEBHOOK_FIELDS];

const MESSAGING_PRODUCT = "whatsapp";
const OBJECT = "whatsapp_business_account";

/** How long a Meta conversation window stays open, and what `expiration_timestamp` reports. */
export const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Conversation ids are 32 hex characters in the samples; a truncated SHA-256 matches. */
const CONVERSATION_ID_LENGTH = 32;

/** Statuses a message webhook can report (SPEC §4). */
export const WEBHOOK_STATUSES = ["sent", "delivered", "read", "failed"] as const;

export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

/** `origin.type` and `pricing.category`: the template's category, lowercased, else `service`. */
export const CONVERSATION_CATEGORIES = ["marketing", "utility", "authentication", "service"] as const;

export type ConversationCategory = (typeof CONVERSATION_CATEGORIES)[number];

/** Meta reports timestamps as strings of Unix **seconds** (SPEC §1.14). */
export function unixSeconds(value: Date | string): number {
	const date = typeof value === "string" ? new Date(value) : value;

	return Math.floor(date.getTime() / 1000);
}

export function unixSecondsString(value: Date | string): string {
	return String(unixSeconds(value));
}

/** Webhooks carry the display number as bare digits, never the formatted `+55 71 …` form. */
export function displayPhoneNumberDigits(phoneNumber: PhoneNumberRecord): string {
	return phoneNumberDigits(phoneNumber.displayPhoneNumber);
}

function metadataNode(phoneNumber: PhoneNumberRecord): JsonObject {
	return {
		display_phone_number: displayPhoneNumberDigits(phoneNumber),
		phone_number_id: phoneNumber.id,
	};
}

/**
 * A `contacts[]` entry. `user_id` rides along only for a contact that has a business-scoped user
 * id (SPEC §1.15) — the consumer indexes contacts by `wa_id` *and* `user_id`, and an absent key
 * is how Meta reports a contact that has none.
 */
function contactNode(contact: ContactRecord): JsonObject {
	return {
		profile: { name: contact.profileName },
		wa_id: contact.waId,
		...(contact.userId !== null && { user_id: contact.userId }),
	};
}

export interface WebhookEnvelopeOptions {
	wabaId: string;
	field: string;
	value: JsonObject;
	/**
	 * `entry.time`, as a JSON **number**. The message samples have no `time`; the template and
	 * phone-number ones do, so it is passed only where Meta sends it.
	 */
	time?: Date;
}

/** `{object, entry:[{id, time?, changes:[{value, field}]}]}` — the shape of every webhook. */
export function webhookEnvelope(options: WebhookEnvelopeOptions): JsonObject {
	return {
		object: OBJECT,
		entry: [
			{
				id: options.wabaId,
				...(options.time !== undefined && { time: unixSeconds(options.time) }),
				changes: [{ value: options.value, field: options.field }],
			},
		],
	};
}

export interface InboundMessageValueOptions {
	phoneNumber: PhoneNumberRecord;
	contact: ContactRecord;
	message: MessageRecord;
}

/** A stored payload key holding a JSON object, or `undefined` when it is absent or not one. */
function objectAt(payload: JsonObject, key: string): JsonObject | undefined {
	const value = payload[key];

	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

/**
 * The `messages` value of an inbound event. The type-named node (`text`, `image`, …) is the
 * message's stored payload, written at insert time exactly as Meta echoes it — which is why
 * media nodes already carry `mime_type` and `sha256`.
 *
 * A contact with a BSUID adds `contacts[].user_id` and `messages[].from_user_id` (SPEC §1.15),
 * alongside `wa_id`/`from` rather than instead of them.
 *
 * `context` is the one key assembled here rather than copied: the quote a `replyTo` produces
 * (`{from, id}`) and the riders the payload carries (`forwarded`, `frequently_forwarded`,
 * `referred_product`, SPEC §5) are **merged**, because Meta sends a forwarded reply as one
 * `context` object holding both halves. Everything else — the type node, `referral`, an
 * `unsupported` message's `errors` — is spread through untouched.
 */
export function inboundMessageValue(options: InboundMessageValueOptions): JsonObject {
	const { phoneNumber, contact, message } = options;
	// `context` is rebuilt below, so it must not also arrive through the spread.
	const { context: _storedContext, ...payload } = message.payload;
	const quote =
		message.replyTo === null ? undefined : { from: displayPhoneNumberDigits(phoneNumber), id: message.replyTo };
	const riders = objectAt(message.payload, "context");
	const context = quote === undefined && riders === undefined ? undefined : { ...quote, ...riders };

	return {
		messaging_product: MESSAGING_PRODUCT,
		metadata: metadataNode(phoneNumber),
		contacts: [contactNode(contact)],
		messages: [
			{
				from: contact.waId,
				...(contact.userId !== null && { from_user_id: contact.userId }),
				id: message.id,
				timestamp: unixSecondsString(message.timestamp),
				...(context !== undefined && { context }),
				type: message.type,
				...payload,
			},
		],
	};
}

export interface ConversationNodeOptions {
	phoneNumberId: string;
	contactWaId: string;
	category: ConversationCategory;
	/** When the status is emitted; the window expires 24 h later. */
	at: Date;
}

/**
 * `conversation.id` is stable for a phone number, a contact and a day (SPEC §4): the statuses
 * of one exchange share it, and a new day opens a new conversation, which is how Meta's
 * 24-hour windows read in practice without whaloc having to track sessions.
 */
export function conversationIdFor(phoneNumberId: string, contactWaId: string, at: Date): string {
	const day = at.toISOString().slice(0, 10);

	return createHash("sha256")
		.update(`${phoneNumberId}:${contactWaId}:${day}`)
		.digest("hex")
		.slice(0, CONVERSATION_ID_LENGTH);
}

export function conversationNode(options: ConversationNodeOptions): JsonObject {
	return {
		id: conversationIdFor(options.phoneNumberId, options.contactWaId, options.at),
		expiration_timestamp: unixSecondsString(new Date(options.at.getTime() + CONVERSATION_WINDOW_MS)),
		origin: { type: options.category },
	};
}

/**
 * Meta's `pricing` block. whaloc always reports a billable, regular PMP message — the
 * emulator has no price list, and the consumer only reads the category.
 */
export function pricingNode(category: ConversationCategory): JsonObject {
	return { billable: true, pricing_model: "PMP", type: "regular", category };
}

export interface StatusValueOptions {
	phoneNumber: PhoneNumberRecord;
	message: MessageRecord;
	status: WebhookStatus;
	at: Date;
	/**
	 * The recipient's business-scoped user id (SPEC §1.15), `null`/absent when the contact has
	 * none. Meta reports it as `recipient_user_id`, next to the `recipient_id` MSISDN.
	 */
	recipientUserId?: string | null;
	/**
	 * The `biz_opaque_callback_data` the send carried (SPEC §2.5). Meta echoes it on **every**
	 * status of that message — `sent`, `delivered`, `read` and `failed` alike — which is what
	 * makes it useful as a correlation key; absent when the send named none.
	 */
	bizOpaqueCallbackData?: string | null;
	/** Present on `sent` and `delivered`, like the captured samples (SPEC §4). */
	conversation?: JsonObject;
	pricing?: JsonObject;
	/** Meta's `errors[]`, present only on `failed`. */
	errors?: JsonObject[];
}

export function statusValue(options: StatusValueOptions): JsonObject {
	const { phoneNumber, message } = options;

	return {
		messaging_product: MESSAGING_PRODUCT,
		metadata: metadataNode(phoneNumber),
		statuses: [
			{
				id: message.id,
				status: options.status,
				timestamp: unixSecondsString(options.at),
				recipient_id: message.contactWaId,
				...(options.recipientUserId !== undefined &&
					options.recipientUserId !== null && { recipient_user_id: options.recipientUserId }),
				...(options.conversation !== undefined && { conversation: options.conversation }),
				...(options.pricing !== undefined && { pricing: options.pricing }),
				...(options.bizOpaqueCallbackData !== undefined &&
					options.bizOpaqueCallbackData !== null && { biz_opaque_callback_data: options.bizOpaqueCallbackData }),
				...(options.errors !== undefined && { errors: options.errors }),
			},
		],
	};
}

/**
 * Meta's error node for a message type this API version cannot represent — a poll, a scheduled
 * call, whatever WhatsApp ships next (SPEC §5).
 *
 * The notice is the `errors[]` entry plus an `unsupported` node naming the type that could not
 * be represented — Meta sends both — in the v16+ shape where the explanation sits in
 * `error_data.details` rather than in a bare `details` key. Consumers that switch on `type` land
 * in their default branch and should show a "message not supported" placeholder, which is
 * exactly what this rehearses.
 *
 * The wording is Meta's own, verbatim from the `unsupported` webhook reference.
 */
export const UNSUPPORTED_MESSAGE_ERROR_CODE = 131_051;

export function unsupportedMessageErrorNode(): JsonObject {
	return {
		code: UNSUPPORTED_MESSAGE_ERROR_CODE,
		title: "Message type unknown",
		message: "Message type unknown",
		error_data: { details: "Message type is currently not supported." },
	};
}

/**
 * The `unsupported` node that rides beside the `errors[]` entry: the type of message that could
 * not be represented, from Meta's own list (`poll_update`, `edit`, `order`, …).
 */
export function unsupportedMessageNode(type: string): JsonObject {
	return { type };
}

/** `system.type` of the notice Meta sends when a person moves to a new number (SPEC §5). */
export const SYSTEM_USER_CHANGED_NUMBER = "user_changed_number";

export interface SystemNumberChangeValueOptions {
	phoneNumber: PhoneNumberRecord;
	/** The contact **after** the move: Meta reports it under its new `wa_id`. */
	contact: ContactRecord;
	/** The number the person left, which the message is `from`. */
	previousWaId: string;
	/** The wamid of the system message; a fresh one, so nothing existing is renamed. */
	messageId: string;
	at: Date;
}

/**
 * Meta's `user_changed_number` system message (SPEC §5): a `messages` change whose message is
 * `type:"system"`, sent **from the number the person left**, naming the new one inside `system`.
 *
 * **There is no `contacts[]` array.** Meta's system-messages reference is explicit about it —
 * "unlike other incoming messages webhooks, system messages webhooks don't include a `contacts`
 * array" — and sending one anyway would let an app that wrongly keys off `contacts[]` during a
 * number change pass here and fail against Meta, which is the exact class of bug whaloc exists
 * to surface. The new `wa_id` is in `system`, which is where a consumer has to read it.
 *
 * The new number is reported twice on purpose. Meta's webhook version decides the spelling —
 * `new_wa_id` on the older payloads, `wa_id` on the current ones — and a consumer reads
 * `system.wa_id ?? system.new_wa_id`, so sending both makes whaloc's notice parse for either.
 * `from_user_id` rides along for a contact with a BSUID: the identity survives the number
 * change, so it is what still pairs this notice with a contact the consumer already knows.
 */
export function systemNumberChangeValue(options: SystemNumberChangeValueOptions): JsonObject {
	const { contact, previousWaId } = options;

	return {
		messaging_product: MESSAGING_PRODUCT,
		metadata: metadataNode(options.phoneNumber),
		messages: [
			{
				from: previousWaId,
				...(contact.userId !== null && { from_user_id: contact.userId }),
				id: options.messageId,
				timestamp: unixSecondsString(options.at),
				type: "system",
				system: {
					// Meta's own wording, `User ` prefix included: `User <name> changed from <old> to <new>`.
					body: `User ${contact.profileName} changed from ${previousWaId} to ${contact.waId}`,
					wa_id: contact.waId,
					new_wa_id: contact.waId,
					type: SYSTEM_USER_CHANGED_NUMBER,
				},
			},
		],
	};
}

export interface TemplateRejectionInfo {
	reason: string;
	recommendation: string;
}

/**
 * Meta's `other_info`, which rides on a template that was locked or unlocked — a pause, or the
 * unpause that lifts it. `title` is one of `FIRST_PAUSE`, `SECOND_PAUSE`, `RATE_LIMITING_PAUSE`,
 * `UNPAUSE` or `DISABLED`; `description` is the sentence Meta shows the business.
 */
export interface TemplateOtherInfo {
	title: string;
	description: string;
}

/** `disable_info.disable_date` — Meta reports it as a string of Unix seconds. */
export interface TemplateDisableInfo {
	disabledAt: Date;
}

export interface TemplateStatusValueOptions {
	template: TemplateRecord;
	/** `APPROVED`, `REJECTED`, `PENDING`, `PAUSED`, `DISABLED`, `DELETED`. */
	event: string;
	/**
	 * Meta's `reason`. A template scheduled for deletion reports a JSON `null` rather than a
	 * string, so this is `string | null`: `undefined` means "nothing to say" and becomes `NONE`,
	 * while an explicit `null` is sent as `null`.
	 */
	reason?: string | null;
	rejectionInfo?: TemplateRejectionInfo;
	/** Only a pause or unpause carries it. */
	otherInfo?: TemplateOtherInfo;
	/** Only `DISABLED` carries it. */
	disableInfo?: TemplateDisableInfo;
}

/**
 * `message_template_status_update`. The id goes out as a JSON **number**, which is what Meta
 * does and why template ids stay below 2^53 (SPEC §1.3).
 */
export function templateStatusValue(options: TemplateStatusValueOptions): JsonObject {
	const { template } = options;

	return {
		event: options.event,
		message_template_id: Number(template.id),
		message_template_name: template.name,
		message_template_language: template.language,
		reason: options.reason === undefined ? "NONE" : options.reason,
		message_template_category: template.category,
		...(options.disableInfo !== undefined && {
			disable_info: { disable_date: unixSecondsString(options.disableInfo.disabledAt) },
		}),
		...(options.otherInfo !== undefined && {
			other_info: { title: options.otherInfo.title, description: options.otherInfo.description },
		}),
		...(options.rejectionInfo !== undefined && {
			rejection_info: {
				reason: options.rejectionInfo.reason,
				recommendation: options.rejectionInfo.recommendation,
			},
		}),
	};
}

export interface TemplateQualityValueOptions {
	template: TemplateRecord;
	/** The score the template held before; `null` reads as `UNKNOWN`, like Meta reports it. */
	previousQualityScore: QualityRating | null;
	qualityScore: QualityRating;
}

export function templateQualityValue(options: TemplateQualityValueOptions): JsonObject {
	return {
		previous_quality_score: options.previousQualityScore ?? "UNKNOWN",
		new_quality_score: options.qualityScore,
		message_template_id: Number(options.template.id),
		message_template_name: options.template.name,
		message_template_language: options.template.language,
	};
}

export interface PhoneNumberQualityValueOptions {
	phoneNumber: PhoneNumberRecord;
	/** `THROUGHPUT_UPGRADE`, `DOWNGRADE`, `FLAGGED`, … */
	event: string;
	/** Messaging limit tier, e.g. `TIER_UNLIMITED`. */
	currentLimit: string;
	/**
	 * The tier the number held before. Meta sends it "only for messaging limit changes", so it is
	 * omitted when the caller names none.
	 */
	oldLimit?: string;
	/**
	 * The owning portfolio's limit. Meta's own note: `current_limit` is removed in February 2026
	 * and this replaces it, so whaloc sends both — a consumer written against either spelling
	 * reads the same number, and one written against the new one keeps working past the cutover.
	 */
	maxDailyConversationsPerBusiness?: string;
}

export function phoneNumberQualityValue(options: PhoneNumberQualityValueOptions): JsonObject {
	return {
		display_phone_number: displayPhoneNumberDigits(options.phoneNumber),
		event: options.event,
		...(options.oldLimit !== undefined && { old_limit: options.oldLimit }),
		current_limit: options.currentLimit,
		...(options.maxDailyConversationsPerBusiness !== undefined && {
			max_daily_conversations_per_business: options.maxDailyConversationsPerBusiness,
		}),
	};
}

export interface AccountRestrictionInfo {
	restrictionType: string;
	/** Meta's own free-form date string; omitted for a restriction that does not lift. */
	expiration?: string;
}

export interface AccountUpdateValueOptions {
	/** The number the notice is about, when it is about one; reported as bare digits. */
	phoneNumber?: PhoneNumberRecord;
	/** `VERIFIED_ACCOUNT`, `DISABLED_UPDATE`, `ACCOUNT_RESTRICTION`, `ACCOUNT_DELETED`, `ACCOUNT_VIOLATION`. */
	event: string;
	/** Only `ACCOUNT_RESTRICTION` carries it, which is the only event Meta documents it on. */
	restrictionInfo?: AccountRestrictionInfo[];
}

/**
 * `account_update` (SPEC §3) — what Meta says about the **account itself** rather than about a
 * message, a template or a number's quality.
 *
 * The `value` is sparse on purpose: Meta sends `phone_number` only when the notice is about one,
 * and `restriction_info` only on `ACCOUNT_RESTRICTION`, so whaloc leaves both off rather than
 * sending an empty array a consumer would have to distinguish from "no restrictions".
 */
export function accountUpdateValue(options: AccountUpdateValueOptions): JsonObject {
	return {
		...(options.phoneNumber !== undefined && { phone_number: displayPhoneNumberDigits(options.phoneNumber) }),
		event: options.event,
		...(options.restrictionInfo !== undefined && {
			restriction_info: options.restrictionInfo.map(entry => {
				return {
					restriction_type: entry.restrictionType,
					...(entry.expiration !== undefined && { expiration: entry.expiration }),
				};
			}),
		}),
	};
}

export interface BusinessCapabilityValueOptions {
	maxDailyConversationPerPhone: number;
	maxPhoneNumbersPerBusiness: number;
}

/** `business_capability_update` (SPEC §3): the two quota numbers, as JSON numbers. */
export function businessCapabilityValue(options: BusinessCapabilityValueOptions): JsonObject {
	return {
		max_daily_conversation_per_phone: options.maxDailyConversationPerPhone,
		max_phone_numbers_per_business: options.maxPhoneNumbersPerBusiness,
	};
}
