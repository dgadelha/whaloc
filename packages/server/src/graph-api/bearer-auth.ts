import type { MiddlewareHandler } from "hono";
import { missingAccessTokenError, type TokenRegistry } from "../domain/index.ts";
import type { GraphEnv } from "./graph-env.ts";

/** `Bearer <token>`, case-insensitive on the scheme as RFC 6750 requires. */
const BEARER_PATTERN = /^Bearer[ \t]+(\S.*)$/i;

export interface BearerAuthOptions {
	/** Decides whether a token is acceptable; permissive unless `WHALOC_TOKENS` is set. */
	tokens: TokenRegistry;
}

/**
 * The bearer gate on the Graph surface (SPEC §1.9).
 *
 * Missing, empty or non-bearer credentials are always the 401 / code 190 envelope. What happens
 * to a token that *is* there depends on whether `WHALOC_TOKENS` was configured, and the whole of
 * that decision lives in {@link TokenRegistry}:
 *
 * - **unset (the default)** — any non-empty token is accepted. The consumer keeps one token per
 *   WABA and never validates its content, so neither does whaloc.
 * - **set** — only the listed tokens pass; anything else is the same 401 / 190, and one marked
 *   expired through the control plane is 401 / 190 / subcode 463.
 *
 * `GET /whaloc-media/:token` is deliberately outside this: the token in the URL is the credential
 * there, which lets the web UI render media in an `<img>` tag.
 */
export function createBearerAuth(options: BearerAuthOptions): MiddlewareHandler<GraphEnv> {
	return async (c, next) => {
		const authorization = c.req.header("authorization")?.trim() ?? "";
		const bearer = BEARER_PATTERN.exec(authorization);

		if (bearer === null) {
			throw missingAccessTokenError();
		}

		await options.tokens.authenticate(bearer[1]!.trim());

		await next();
	};
}
