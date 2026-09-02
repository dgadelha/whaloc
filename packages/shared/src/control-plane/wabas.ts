import { z } from "zod";
import { metaIdSchema } from "./common.ts";

/**
 * WhatsApp Business Accounts as the control plane manages them (SPEC §5).
 *
 * `WHALOC_SEED` describes the world whaloc boots with; these routes are how a dev adds a second
 * WABA — or a second number under one — without restarting the container.
 */
export const wabaSchema = z.object({
	id: z.string(),
	name: z.string(),
	/**
	 * When an app subscribed to this WABA's webhooks through
	 * `POST /{wabaId}/subscribed_apps`, `null` when none has (SPEC §2.20). whaloc models one
	 * implicit app, so this is the whole of the subscription state.
	 */
	subscribedAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
});

export type Waba = z.infer<typeof wabaSchema>;

export const wabaResponseSchema = z.object({ data: wabaSchema });

export type WabaResponse = z.infer<typeof wabaResponseSchema>;

export const wabaListResponseSchema = z.object({ data: z.array(wabaSchema) });

export type WabaListResponse = z.infer<typeof wabaListResponseSchema>;

/** `POST /api/wabas`. An explicit `id` is allowed so a fixed `GRAPH_API_BASE_URL` can be met. */
export const wabaCreateRequestSchema = z.object({
	name: z.string().min(1).max(120),
	/**
	 * The id to give the account, so it can match the one an app is already configured with.
	 * Left out, whaloc mints one the way Meta does. It has to be free in **every** id store, not
	 * just this one (SPEC §2).
	 */
	id: metaIdSchema.optional(),
});

export type WabaCreateRequest = z.infer<typeof wabaCreateRequestSchema>;

/** `PATCH /api/wabas/:id` — the name is the only thing a WABA owns of its own. */
export const wabaUpdateRequestSchema = z.object({
	name: z.string().min(1).max(120),
});

export type WabaUpdateRequest = z.infer<typeof wabaUpdateRequestSchema>;
