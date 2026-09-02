import {
	messageErrorPresetListResponseSchema,
	messageResponseSchema,
	messageStatusRequestSchema,
} from "@whaloc/shared";
import { Hono } from "hono";
import { listMessageErrorPresets, toMessageDto, type StatusLadder } from "../domain/index.ts";
import { controlError, readBody, type ControlEnv } from "./control-env.ts";

export interface MessageRoutesOptions {
	statusLadder: StatusLadder;
}

/**
 * `POST /api/messages/:id/status` — the manual half of the status ladder (SPEC §4, §5).
 *
 * A transition that would move a message backwards (or touch one that already failed) is a
 * 409 rather than a silent no-op: the UI is showing a stale state and should say so.
 */
export function createMessageRoutes(options: MessageRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.post("/messages/:id/status", async c => {
		const body = await readBody(c, messageStatusRequestSchema);
		const id = c.req.param("id");
		const message = await options.statusLadder.markStatus(id, body.status, body.errorCode);

		if (message === null) {
			return controlError(
				c,
				409,
				`message ${id} is unknown, or cannot move to ${body.status} from where it is`,
				"invalid_transition",
			);
		}

		return c.json(messageResponseSchema.parse({ data: toMessageDto(message) }));
	});

	// The presets the `failed` transition above accepts, with Meta's own wording: what the
	// UI's "fail…" menu is built from (SPEC §4).
	routes.get("/message-error-presets", c =>
		c.json(messageErrorPresetListResponseSchema.parse({ data: listMessageErrorPresets() })),
	);

	return routes;
}
