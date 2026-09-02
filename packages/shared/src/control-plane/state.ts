import { z } from "zod";
import { phoneNumberSchema } from "./phone-numbers.ts";
import { handshakeResultSchema } from "./webhooks.ts";

/** `GET /api/state` — everything the UI needs to render itself on load (SPEC §5). */

export const wabaStateSchema = z.object({
	id: z.string(),
	name: z.string(),
	/** `null` when no app is subscribed to this WABA's webhooks (SPEC §2.20). */
	subscribedAt: z.iso.datetime().nullable(),
	phoneNumbers: z.array(phoneNumberSchema),
});

export type WabaState = z.infer<typeof wabaStateSchema>;

/** The deterministic behavior knobs, so the UI can explain what will happen (SPEC §4). */
export const behaviorStateSchema = z.object({
	statusDelays: z.object({
		sent: z.number().int().nonnegative(),
		delivered: z.number().int().nonnegative(),
		/** `null` = `read` is only ever sent manually. */
		read: z.number().int().nonnegative().nullable(),
	}),
	/** `null` = templates stay `PENDING` until moderated through the control plane. */
	templateAutoApproveMs: z.number().int().nonnegative().nullable(),
	/**
	 * `WHALOC_TOKENS` is set, so only the registered bearer tokens are accepted (SPEC §1.9).
	 * `false` — the default — is whaloc's permissive mode: any non-empty token passes, and
	 * `GET /api/tokens` has nothing to list.
	 */
	strictTokens: z.boolean(),
	/** `WHALOC_MEDIA_TTL_SECONDS`; `null` = uploaded media never expires. */
	mediaTtlSeconds: z.number().int().nonnegative().nullable(),
});

export type BehaviorState = z.infer<typeof behaviorStateSchema>;

/**
 * Webhook target status. Secrets are never served — only whether they are configured — and
 * `lastHandshake` is the result of the most recent `hub.challenge` round trip (SPEC §1.13).
 */
export const webhookStateSchema = z.object({
	url: z.string().nullable(),
	appSecretConfigured: z.boolean(),
	verifyTokenConfigured: z.boolean(),
	verifyOnStart: z.boolean(),
	lastHandshake: handshakeResultSchema.nullable(),
});

export type WebhookState = z.infer<typeof webhookStateSchema>;

/**
 * The one app whaloc plays on the `subscribed_apps` surface (SPEC §2.20): the id
 * `POST /{wabaId}/subscribed_apps` registers and `GET` reports, so the UI can say *which* app a
 * WABA is subscribed to. Its id comes from `WHALOC_APP_ID`, or is derived deterministically.
 */
export const appIdentitySchema = z.object({
	id: z.string(),
	name: z.string(),
});

export type AppIdentity = z.infer<typeof appIdentitySchema>;

export const stateResponseSchema = z.object({
	publicUrl: z.string(),
	app: appIdentitySchema,
	wabas: z.array(wabaStateSchema),
	behavior: behaviorStateSchema,
	webhook: webhookStateSchema,
});

export type StateResponse = z.infer<typeof stateResponseSchema>;

/** `POST /api/reset` answers with the state the server came back up with. */
export const resetResponseSchema = z.object({ data: stateResponseSchema });

export type ResetResponse = z.infer<typeof resetResponseSchema>;
