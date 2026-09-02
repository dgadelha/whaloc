import {
	accountUpdateRequestSchema,
	businessCapabilityUpdateRequestSchema,
	handshakeResponseSchema,
	listWebhookDeliveriesQuerySchema,
	rawWebhookRequestSchema,
	webhookDeliveryAttemptsResponseSchema,
	webhookDeliveryListResponseSchema,
} from "@whaloc/shared";
import { Hono } from "hono";
import type { WebhookDeliveryRecord } from "../db/index.ts";
import { toWebhookDeliveryDto, type AccountEventService, type WebhookEmitter } from "../domain/index.ts";
import { controlError, parseOrThrow, readBody, type ControlEnv } from "./control-env.ts";

export interface WebhookRoutesOptions {
	webhooks: WebhookEmitter;
	accountEvents: AccountEventService;
}

function attempts(records: readonly WebhookDeliveryRecord[]) {
	return webhookDeliveryAttemptsResponseSchema.parse({
		data: records.map(record => toWebhookDeliveryDto(record)),
	});
}

/**
 * The delivery log and the three actions around it (SPEC §5).
 *
 * - `GET /api/webhook-deliveries` — newest first, `before` pages backwards through history.
 * - `POST /api/webhook-deliveries/:id/redeliver` — replays a stored body, re-signed, as new
 *   attempt rows.
 * - `POST /api/webhook/handshake` — runs the `hub.challenge` round trip and reports it.
 * - `POST /api/webhook/raw` — the escape hatch: any JSON object, signed and delivered like a
 *   real event, which is how a receiver can be pointed at a payload whaloc does not model.
 * - `POST /api/webhook/account-update` and `…/business-capability-update` — the two
 *   account-level notices (SPEC §3). They live here rather than under `/api/wabas/:id` because
 *   they are **emissions and nothing else**: no whaloc state changes when one goes out, and the
 *   answer is the delivery attempts, exactly like the raw sender's.
 */
export function createWebhookRoutes(options: WebhookRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/webhook-deliveries", async c => {
		const query = parseOrThrow(listWebhookDeliveriesQuerySchema, c.req.query());
		const deliveries = await options.webhooks.listDeliveries({
			limit: query.limit,
			...(query.before !== undefined && { before: query.before }),
		});

		return c.json(
			webhookDeliveryListResponseSchema.parse({
				data: deliveries.map(delivery => toWebhookDeliveryDto(delivery)),
				// A full page means there is probably more behind it.
				paging: { before: deliveries.length < query.limit ? null : (deliveries.at(-1)?.createdAt ?? null) },
			}),
		);
	});

	routes.post("/webhook-deliveries/:id/redeliver", async c => {
		const id = c.req.param("id");
		const records = await options.webhooks.redeliver(id);

		if (records === null) {
			return controlError(c, 404, `no webhook delivery with ID ${id}`, "unknown_delivery");
		}

		return c.json(attempts(records), 201);
	});

	routes.post("/webhook/handshake", async c =>
		c.json(handshakeResponseSchema.parse({ data: await options.webhooks.handshake() })),
	);

	routes.post("/webhook/raw", async c => {
		const payload = await readBody(c, rawWebhookRequestSchema);

		return c.json(attempts(await options.webhooks.emitRaw(payload)), 201);
	});

	routes.post("/webhook/account-update", async c => {
		const request = await readBody(c, accountUpdateRequestSchema);

		return c.json(attempts(await options.accountEvents.emitAccountUpdate(request)), 201);
	});

	routes.post("/webhook/business-capability-update", async c => {
		const request = await readBody(c, businessCapabilityUpdateRequestSchema);

		return c.json(attempts(await options.accountEvents.emitBusinessCapabilityUpdate(request)), 201);
	});

	return routes;
}
