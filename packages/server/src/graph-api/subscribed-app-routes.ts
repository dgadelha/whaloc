import { Hono } from "hono";
import type { SubscribedAppService } from "../domain/index.ts";
import type { GraphEnv } from "./graph-env.ts";

export interface SubscribedAppRoutesOptions {
	subscribedApps: SubscribedAppService;
}

/**
 * `GET|POST|DELETE /{wabaId}/subscribed_apps` (SPEC §2.20) — how an app registers itself for a
 * WABA's webhooks, and reads back that it did.
 *
 * `POST` and `DELETE` take no body (Meta's own take neither), so a bare `curl -X POST` works.
 * The listing is Meta's nested shape: `{data:[{whatsapp_business_api_data:{id, name, link}}]}`.
 */
export function createSubscribedAppRoutes(options: SubscribedAppRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.post("/:id/subscribed_apps", async c => {
		await options.subscribedApps.subscribe(c.req.param("id"));

		return c.json({ success: true });
	});

	routes.get("/:id/subscribed_apps", async c => {
		const apps = await options.subscribedApps.list(c.req.param("id"));

		return c.json({
			data: apps.map(app => ({ whatsapp_business_api_data: { id: app.id, name: app.name, link: app.link } })),
		});
	});

	routes.delete("/:id/subscribed_apps", async c => {
		await options.subscribedApps.unsubscribe(c.req.param("id"));

		return c.json({ success: true });
	});

	return routes;
}
