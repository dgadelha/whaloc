import { tokenListResponseSchema, tokenResponseSchema } from "@whaloc/shared";
import { Hono } from "hono";
import type { TokenRegistry } from "../domain/index.ts";
import type { ControlEnv } from "./control-env.ts";

export interface TokenRoutesOptions {
	tokens: TokenRegistry;
}

/**
 * `GET /api/tokens` and the two actions on one of them (SPEC §1.9).
 *
 * The registry is `WHALOC_TOKENS`, so there is nothing to create or delete here — only to
 * *invalidate*: `expire` makes a listed token answer 401 / 190 / subcode 463, and `restore`
 * brings it back. Both are idempotent, which keeps a UI button honest when it is clicked twice.
 *
 * With `WHALOC_TOKENS` unset the listing answers `{strict:false, data:[]}` rather than a 404:
 * "there is no registry" is a state the UI renders (by hiding the section), not an error.
 * Expiring anything in that mode is a 404 for the id, because there is no such token.
 */
export function createTokenRoutes(options: TokenRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/tokens", async c => {
		return c.json(
			tokenListResponseSchema.parse({ strict: options.tokens.isStrict, data: await options.tokens.list() }),
		);
	});

	routes.post("/tokens/:id/expire", async c => {
		const token = await options.tokens.setExpired(c.req.param("id"), true);

		return c.json(tokenResponseSchema.parse({ data: token }));
	});

	routes.post("/tokens/:id/restore", async c => {
		const token = await options.tokens.setExpired(c.req.param("id"), false);

		return c.json(tokenResponseSchema.parse({ data: token }));
	});

	return routes;
}
