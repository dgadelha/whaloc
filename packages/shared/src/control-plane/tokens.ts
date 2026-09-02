import { z } from "zod";

/**
 * The bearer tokens `WHALOC_TOKENS` registers, as the control plane reports them (SPEC §1.9).
 *
 * **The token itself is never served.** A token is addressed by an `id` derived from it (a
 * truncated SHA-256), and shown as `masked` — everything but the last four characters replaced —
 * which is enough for a developer to tell two tokens apart without the UI holding a credential.
 */
export const tokenStateSchema = z.object({
	/** Stable across restarts: derived from the token, not from its position in the list. */
	id: z.string(),
	/** `••••••••cdef`. */
	masked: z.string(),
	/** The last four characters, or fewer for a very short token. */
	last4: z.string(),
	/** Marked expired through the control plane: a request with it is 401 / 190 / 463. */
	expired: z.boolean(),
	/** When it was marked expired; `null` while it is valid. */
	expiredAt: z.iso.datetime().nullable(),
});

export type TokenState = z.infer<typeof tokenStateSchema>;

/**
 * `GET /api/tokens`. `strict` is `false` — and `data` empty — when `WHALOC_TOKENS` is unset,
 * which is whaloc's default: any non-empty bearer token is accepted and there is no registry.
 */
export const tokenListResponseSchema = z.object({
	strict: z.boolean(),
	data: z.array(tokenStateSchema),
});

export type TokenListResponse = z.infer<typeof tokenListResponseSchema>;

export const tokenResponseSchema = z.object({ data: tokenStateSchema });

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
