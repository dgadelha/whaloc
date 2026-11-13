import { Hono } from "hono";
import type { AppEnv } from "../app-env.ts";
import { SDK_SCRIPT } from "./sdk-script.ts";

/** Short enough that a new whaloc version reaches the browser within a minute. */
const SDK_CACHE_CONTROL = "public, max-age=60";

/**
 * Meta's JavaScript SDK stand-in at `/sdk.js` (SPEC §2.24), outside any Graph version prefix
 * because it is what `connect.facebook.net` serves, not a Graph call. The dialog it opens is a
 * page of the web UI.
 */
export function createSdkRoutes(): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	routes.get("/sdk.js", c => {
		c.header("Content-Type", "application/javascript; charset=utf-8");
		c.header("Cache-Control", SDK_CACHE_CONTROL);

		return c.body(SDK_SCRIPT);
	});

	return routes;
}
