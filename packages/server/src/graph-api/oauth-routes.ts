import { Hono } from "hono";
import type { EmbeddedSignupService } from "../domain/index.ts";
import { graphAccessToken } from "./bearer-auth.ts";
import type { GraphEnv } from "./graph-env.ts";

export interface OAuthRoutesOptions {
	embeddedSignup: EmbeddedSignupService;
}

/** Both scopes the Embedded Signup configuration asks for, each granted on the shared WABAs. */
const SIGNUP_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;

/**
 * The two Graph calls that finish an Embedded Signup (SPEC §2.23).
 *
 * Neither carries a business token, so {@link createGraphRoutes} mounts this router **ahead of the
 * bearer gate and the injection rules**: the code exchange authenticates with `client_id` and
 * `client_secret`, and `debug_token` with the app token `{app-id}|{app-secret}`, found where the
 * gate finds a business token: the bearer header, or `access_token` in the query without one.
 */
export function createOAuthRoutes(options: OAuthRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.get("/oauth/access_token", c => {
		const accessToken = options.embeddedSignup.exchangeCode({
			clientId: c.req.query("client_id"),
			clientSecret: c.req.query("client_secret"),
			code: c.req.query("code"),
		});

		return c.json({ access_token: accessToken, token_type: "bearer" });
	});

	routes.get("/debug_token", c => {
		const info = options.embeddedSignup.debugToken(graphAccessToken(c.req), c.req.query("input_token"));

		if (info.wabaIds === null) {
			return c.json({
				data: {
					is_valid: false,
					error: { code: 190, message: "Invalid OAuth access token - Cannot parse access token" },
					scopes: [],
				},
			});
		}

		const wabaIds = info.wabaIds;

		return c.json({
			data: {
				app_id: info.appId,
				type: "SYSTEM_USER",
				application: "whaloc",
				is_valid: true,
				scopes: [...SIGNUP_SCOPES],
				granular_scopes: SIGNUP_SCOPES.map(scope => ({ scope, target_ids: wabaIds })),
			},
		});
	});

	return routes;
}
