import { z } from "zod";

/**
 * Typing indicators (SPEC §2.18, §5).
 *
 * A typing indicator is the one piece of whaloc state that is deliberately **not** persisted:
 * the app under test raises it by sending `typing_indicator` on
 * `POST /{phoneNumberId}/messages`, and Meta dismisses it after 25 seconds or as soon as the
 * next outbound message goes out. A restart drops it, exactly like the status-ladder timers it
 * is scheduled next to (SPEC §4).
 *
 * It belongs to a conversation — a (phone number, contact) pair — because that is what a
 * WhatsApp user sees it in.
 */
export const typingIndicatorSchema = z.object({
	phoneNumberId: z.string(),
	contactWaId: z.string(),
	/**
	 * When the indicator dismisses itself. `null` means it is *gone*, which only the
	 * `typing.changed` WebSocket event carries — `GET /api/typing` lists the live ones.
	 */
	expiresAt: z.iso.datetime().nullable(),
});

export type TypingIndicator = z.infer<typeof typingIndicatorSchema>;

export const typingIndicatorListResponseSchema = z.object({ data: z.array(typingIndicatorSchema) });

export type TypingIndicatorListResponse = z.infer<typeof typingIndicatorListResponseSchema>;

/** `GET /api/typing?phoneNumberId=` — the indicators that are currently up. */
export const listTypingIndicatorsQuerySchema = z.object({
	phoneNumberId: z.string().min(1).optional(),
});

export type ListTypingIndicatorsQuery = z.infer<typeof listTypingIndicatorsQuerySchema>;
