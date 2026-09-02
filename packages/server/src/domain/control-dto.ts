import type {
	Contact,
	Conversation,
	InjectionRule,
	Message,
	PhoneNumber,
	Template,
	Waba,
	WebhookDelivery,
} from "@whaloc/shared";
import { conversationId } from "@whaloc/shared";
import type {
	ContactRecord,
	InjectionRuleRecord,
	MessageRecord,
	PhoneNumberRecord,
	TemplateRecord,
	WabaRecord,
	WebhookDeliveryRecord,
} from "../db/index.ts";

/**
 * Repository records → the control-plane contract in `@whaloc/shared` (SPEC §5).
 *
 * The mapping lives in the domain rather than in `control-api/` because the WebSocket events
 * carry the same shapes and are published from the services themselves. Everything the UI
 * sees goes through here, which is also where a column that must stay private would be
 * dropped.
 */

export function toContactDto(record: ContactRecord): Contact {
	return {
		waId: record.waId,
		profileName: record.profileName,
		userId: record.userId,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

/**
 * A phone number, lifecycle included. `pendingVerification` carries the code
 * `POST /{phoneNumberId}/request_code` generated: whaloc is the phone, so the control plane is
 * where the "SMS" is read (SPEC §4). The Graph surface never exposes it.
 */
export function toPhoneNumberDto(record: PhoneNumberRecord): PhoneNumber {
	return {
		id: record.id,
		wabaId: record.wabaId,
		displayPhoneNumber: record.displayPhoneNumber,
		verifiedName: record.verifiedName,
		qualityRating: record.qualityRating,
		throughputLevel: record.throughputLevel,
		status: record.status,
		codeVerificationStatus: record.codeVerificationStatus,
		nameStatus: record.nameStatus,
		pendingVerification: record.pendingVerification,
		businessProfile: record.businessProfile,
		createdAt: record.createdAt,
	};
}

export function toWabaDto(record: WabaRecord): Waba {
	return { id: record.id, name: record.name, subscribedAt: record.subscribedAt, createdAt: record.createdAt };
}

export function toMessageDto(record: MessageRecord): Message {
	return {
		id: record.id,
		direction: record.direction,
		phoneNumberId: record.phoneNumberId,
		contactWaId: record.contactWaId,
		type: record.type,
		payload: record.payload,
		status: record.status,
		error: record.error,
		...(record.bizOpaqueCallbackData !== null && { bizOpaqueCallbackData: record.bizOpaqueCallbackData }),
		replyTo: record.replyTo,
		timestamp: record.timestamp,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export function toTemplateDto(record: TemplateRecord): Template {
	return {
		id: record.id,
		wabaId: record.wabaId,
		name: record.name,
		language: record.language,
		category: record.category,
		parameterFormat: record.parameterFormat,
		components: record.components,
		status: record.status,
		rejectedReason: record.rejectedReason,
		qualityScore: record.qualityScore,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

/**
 * A delivery attempt. `skipped` is derived from the empty URL such a row is stored with:
 * with `WHALOC_WEBHOOK_URL` unset whaloc still logs what it *would* have sent (SPEC §3), and
 * the UI needs to tell that apart from a real attempt.
 */
export function toWebhookDeliveryDto(record: WebhookDeliveryRecord): WebhookDelivery {
	return {
		id: record.id,
		eventType: record.eventType,
		url: record.url,
		requestBody: record.requestBody,
		requestHeaders: record.requestHeaders,
		responseStatus: record.responseStatus,
		responseBody: record.responseBody,
		error: record.error,
		attempt: record.attempt,
		durationMs: record.durationMs,
		skipped: record.url === "",
		createdAt: record.createdAt,
	};
}

/**
 * An error-injection rule (SPEC §4). `exhausted` is derived rather than stored: a `next` rule
 * whose countdown reached zero is inert, and that is the one thing the UI has to render
 * differently from a rule that is still armed.
 */
export function toInjectionRuleDto(record: InjectionRuleRecord): InjectionRule {
	return {
		id: record.id,
		target: record.target,
		trigger: record.trigger,
		preset: record.preset,
		...(record.retryAfterSeconds !== null && { retryAfterSeconds: record.retryAfterSeconds }),
		...(record.regainAccessMinutes !== null && { regainAccessMinutes: record.regainAccessMinutes }),
		...(record.custom !== null && { custom: record.custom }),
		seen: record.seen,
		matches: record.matches,
		remaining: record.remaining,
		exhausted: record.trigger.kind === "next" && (record.remaining ?? 0) === 0,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export interface ConversationInput {
	phoneNumberId: string;
	contactWaId: string;
	contact: ContactRecord | null;
	messageCount: number;
	lastMessageAt: string;
	lastMessage: MessageRecord | null;
}

export function toConversationDto(input: ConversationInput): Conversation {
	return {
		id: conversationId(input.phoneNumberId, input.contactWaId),
		phoneNumberId: input.phoneNumberId,
		contactWaId: input.contactWaId,
		contact: input.contact === null ? null : toContactDto(input.contact),
		messageCount: input.messageCount,
		lastMessageAt: input.lastMessageAt,
		lastMessage: input.lastMessage === null ? null : toMessageDto(input.lastMessage),
	};
}
