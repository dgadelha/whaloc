import {
	conversationListResponseSchema,
	conversationMessagesResponseSchema,
	listConversationsQuerySchema,
	listMessagesQuerySchema,
	parseConversationId,
} from "@whaloc/shared";
import { Hono } from "hono";
import { toMessageDto, type ConversationService } from "../domain/index.ts";
import { controlError, parseOrThrow, type ControlEnv } from "./control-env.ts";

export interface ConversationRoutesOptions {
	conversations: ConversationService;
}

/**
 * `GET /api/conversations` and `GET /api/conversations/:id/messages` (SPEC §5).
 *
 * The id is `<phoneNumberId>:<waId>` — a conversation has no row of its own, it is the pair of
 * endpoints, so the id is built from them rather than stored.
 */
export function createConversationRoutes(options: ConversationRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/conversations", async c => {
		const query = parseOrThrow(listConversationsQuerySchema, c.req.query());
		const conversations = await options.conversations.list(query.phoneNumberId);

		return c.json(conversationListResponseSchema.parse({ data: conversations }));
	});

	routes.get("/conversations/:id/messages", async c => {
		const id = c.req.param("id");
		const endpoints = parseConversationId(id);

		if (endpoints === null) {
			return controlError(c, 400, `${id} is not a conversation ID (<phoneNumberId>:<waId>)`, "invalid_conversation");
		}

		const query = parseOrThrow(listMessagesQuerySchema, c.req.query());
		const page = await options.conversations.messages({
			phoneNumberId: endpoints.phoneNumberId,
			contactWaId: endpoints.contactWaId,
			limit: query.limit,
			...(query.before !== undefined && { before: query.before }),
		});

		return c.json(
			conversationMessagesResponseSchema.parse({
				data: page.messages.map(message => toMessageDto(message)),
				paging: { before: page.before },
			}),
		);
	});

	return routes;
}
