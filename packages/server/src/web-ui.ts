import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AppEnv } from "./app-env.ts";

export interface WebUiRoutesOptions {
	/** Absolute path to the built Vite bundle (`packages/web/dist`). */
	webDir: string;
}

/**
 * The paths the single whaloc port already owns (SPEC §8). The SPA fallback must never
 * shadow them: a typo in an API path has to come back as whaloc's 404, not as the UI's
 * `index.html` with a 200 — the failure mode that makes a fetch client report "unexpected
 * token <" instead of the mistake.
 */
const RESERVED_PATHS = [/^\/api(?:\/|$)/, /^\/v\d+\.\d+(?:\/|$)/, /^\/whaloc-media(?:\/|$)/, /^\/health$/];

export function isReservedPath(pathname: string): boolean {
	return RESERVED_PATHS.some(pattern => pattern.test(pathname));
}

/** Vite fingerprints everything under `assets/`; the entry document must never be cached. */
const IMMUTABLE_PREFIX = "/assets/";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache";

export function cacheControlFor(pathname: string): string {
	return pathname.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

/**
 * `serveStatic` builds its response before it calls `onFound`, so a header set from there
 * never lands; this wraps the handler and stamps the response it actually returns.
 */
function cached(
	handler: MiddlewareHandler<AppEnv>,
	cacheControl: (pathname: string) => string,
): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const response = await handler(c, next);

		if (response instanceof Response) {
			response.headers.set("Cache-Control", cacheControl(c.req.path));
		}

		return response;
	};
}

/**
 * Serves the built web UI at `/` (SPEC §5, §8).
 *
 * Two handlers: the first answers with the file when one exists, the second answers every
 * other in-app route (`/w/:wabaId/p/:phoneNumberId/chats`, `/settings`, …) with `index.html` so a deep link and a
 * reload work — react-router does the rest in the browser. Mounted last in `createApp`,
 * after the surfaces whose paths are reserved above.
 *
 * In development the UI is served by Vite instead, which proxies those same paths here; a
 * missing `dist` is therefore not an error, it just leaves `/` unrouted.
 */
export function createWebUiRoutes(options: WebUiRoutesOptions): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();
	const file = cached(serveStatic<AppEnv>({ root: options.webDir }), cacheControlFor);
	const index = cached(
		serveStatic<AppEnv>({ root: options.webDir, path: "index.html" }),
		() => REVALIDATE_CACHE_CONTROL,
	);

	const spaFallback: MiddlewareHandler<AppEnv> = async (c, next) =>
		isReservedPath(c.req.path) ? next() : index(c, next);

	routes.use("*", file);
	routes.get("*", spaFallback);

	return routes;
}

/** Whether {@link createWebUiRoutes} has anything to serve: `npm run build --workspace @whaloc/web` ran. */
export function hasWebUiBundle(webDir: string): boolean {
	return existsSync(path.join(webDir, "index.html"));
}
