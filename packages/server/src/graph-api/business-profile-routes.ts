import { Hono } from "hono";
import {
	businessProfileNode,
	businessProfileUpdateSchema,
	toBusinessProfilePatch,
	type BusinessProfileService,
} from "../domain/index.ts";
import { parseFields, projectFields } from "./fields.ts";
import type { GraphEnv } from "./graph-env.ts";
import { parseOrThrow, readJsonBody } from "./request-parsing.ts";

export interface BusinessProfileRoutesOptions {
	businessProfiles: BusinessProfileService;
}

/**
 * `GET|POST /{phoneNumberId}/whatsapp_business_profile` (SPEC §2.19).
 *
 * The read is an **edge**, not a node: Meta wraps the single profile in `{data:[…]}`, and
 * `messaging_product` is always there whatever `fields` asked for — which is why the projection
 * runs over the profile fields only.
 */
export function createBusinessProfileRoutes(options: BusinessProfileRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.get("/:id/whatsapp_business_profile", async c => {
		const profile = await options.businessProfiles.get(c.req.param("id"));
		const { messaging_product: messagingProduct, ...node } = businessProfileNode(profile);
		const projected = projectFields(node, parseFields(c.req.query("fields")));

		return c.json({ data: [{ messaging_product: messagingProduct, ...projected }] });
	});

	routes.post("/:id/whatsapp_business_profile", async c => {
		const request = parseOrThrow(businessProfileUpdateSchema, await readJsonBody(c));

		await options.businessProfiles.update(c.req.param("id"), toBusinessProfilePatch(request));

		return c.json({ success: true });
	});

	return routes;
}
