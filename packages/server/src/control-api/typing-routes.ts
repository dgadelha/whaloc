import { listTypingIndicatorsQuerySchema, typingIndicatorListResponseSchema } from "@whaloc/shared";
import { Hono } from "hono";
import type { TypingService } from "../domain/index.ts";
import { parseOrThrow, type ControlEnv } from "./control-env.ts";

export interface TypingRoutesOptions {
	typing: TypingService;
}

/**
 * `GET /api/typing` (SPEC §5) — the typing indicators that are currently up.
 *
 * Read-only on purpose: a typing indicator is something the **app under test** declares, by
 * sending `typing_indicator` on `POST /{phoneNumberId}/messages` (SPEC §2.18). The control plane
 * is the user's side of the conversation and has no business raising one; it serves them so a UI
 * that just loaded can render an indicator that went up before the socket was open, and so a
 * test script can assert on the state a read receipt left behind.
 */
export function createTypingRoutes(options: TypingRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/typing", c => {
		const query = parseOrThrow(listTypingIndicatorsQuerySchema, c.req.query());

		return c.json(typingIndicatorListResponseSchema.parse({ data: options.typing.list(query.phoneNumberId) }));
	});

	return routes;
}
