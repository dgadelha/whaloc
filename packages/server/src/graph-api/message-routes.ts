import { Hono } from "hono";
import type { ZodError } from "zod";
import {
	invalidParameterError,
	isMarkReadBody,
	markReadRequestSchema,
	sendMessageRequestSchema,
	SEND_MESSAGE_TYPES,
	type MessageService,
	type ReadReceiptService,
} from "../domain/index.ts";
import type { GraphEnv } from "./graph-env.ts";
import { parseOrThrow, readJsonBody, zodIssueDetails } from "./request-parsing.ts";

export interface MessageRoutesOptions {
	messages: MessageService;
	readReceipts: ReadReceiptService;
}

const KNOWN_SEND_TYPES = new Set<string>(SEND_MESSAGE_TYPES);

/**
 * zod reports an unmatched discriminator as a bare "invalid union", which tells a developer
 * nothing. Naming the eleven types it could have been does, and matches how Meta phrases its
 * own parameter complaints.
 */
function sendRequestDetails(body: unknown, error: ZodError): string {
	const type: unknown =
		typeof body === "object" && body !== null ? (body as Record<string, unknown>)["type"] : undefined;

	if (typeof type === "string" && !KNOWN_SEND_TYPES.has(type)) {
		return `Param type must be one of ${SEND_MESSAGE_TYPES.join(", ")}`;
	}

	return zodIssueDetails(error);
}

/**
 * `POST /{phoneNumberId}/messages` (SPEC §2.5, §2.18). The route validates and maps; everything
 * that happens to an accepted send lives in {@link MessageService}.
 *
 * Meta overloads this one path: a body carrying `status: "read"` is a **read receipt** (with an
 * optional typing indicator) rather than a message, and answers `{"success":true}`. Sends
 * answer the shape captured in SPEC §1.6 — `messages` is always non-empty and `messages[0].id`
 * is the wamid, which is the only field the consumer reads.
 */
export function createMessageRoutes(options: MessageRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.post("/:id/messages", async c => {
		const body = await readJsonBody(c);

		if (isMarkReadBody(body)) {
			await options.readReceipts.markRead(c.req.param("id"), parseOrThrow(markReadRequestSchema, body));

			return c.json({ success: true });
		}

		const parsed = sendMessageRequestSchema.safeParse(body);

		if (!parsed.success) {
			throw invalidParameterError(sendRequestDetails(body, parsed.error));
		}

		const result = await options.messages.send(c.req.param("id"), parsed.data);

		return c.json({
			messaging_product: "whatsapp",
			contacts: [{ input: result.input, wa_id: result.waId }],
			messages: [{ id: result.message.id, message_status: result.message.status }],
		});
	});

	return routes;
}
