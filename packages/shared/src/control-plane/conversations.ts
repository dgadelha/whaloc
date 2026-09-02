import { z } from "zod";
import { pageQuerySchema, pagingSchema } from "./common.ts";
import { contactSchema } from "./contacts.ts";
import { messageSchema } from "./messages.ts";

/**
 * A conversation is a (phone number, contact) pair — whaloc never stores one, it derives it
 * from the messages exchanged between the two (SPEC §5). Its id is
 * `<phoneNumberId>:<waId>`, which is what `GET /api/conversations/:id/messages` takes.
 */
export const conversationSchema = z.object({
	id: z.string(),
	phoneNumberId: z.string(),
	contactWaId: z.string(),
	/** `null` only if the contact row was removed while messages remained. */
	contact: contactSchema.nullable(),
	messageCount: z.number().int().nonnegative(),
	lastMessageAt: z.iso.datetime(),
	lastMessage: messageSchema.nullable(),
});

export type Conversation = z.infer<typeof conversationSchema>;

export const conversationListResponseSchema = z.object({ data: z.array(conversationSchema) });

export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;

export const listConversationsQuerySchema = z.object({
	phoneNumberId: z.string().min(1).optional(),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = pageQuerySchema;

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

/** One page of a conversation, **newest last** (SPEC §5); `paging.before` pages backwards. */
export const conversationMessagesResponseSchema = z.object({
	data: z.array(messageSchema),
	paging: pagingSchema,
});

export type ConversationMessagesResponse = z.infer<typeof conversationMessagesResponseSchema>;

/** The separator in a conversation id; `wa_id`s may contain dots, never a colon. */
export const CONVERSATION_ID_SEPARATOR = ":";

export function conversationId(phoneNumberId: string, contactWaId: string): string {
	return `${phoneNumberId}${CONVERSATION_ID_SEPARATOR}${contactWaId}`;
}

export function parseConversationId(id: string): { phoneNumberId: string; contactWaId: string } | null {
	const separator = id.indexOf(CONVERSATION_ID_SEPARATOR);

	if (separator <= 0 || separator === id.length - 1) {
		return null;
	}

	return { phoneNumberId: id.slice(0, separator), contactWaId: id.slice(separator + 1) };
}
