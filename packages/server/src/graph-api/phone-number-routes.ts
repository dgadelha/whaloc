import { Hono } from "hono";
import {
	graphPhoneNumberCreateRequestSchema,
	registerPhoneNumberRequestSchema,
	requestCodeRequestSchema,
	verifyCodeRequestSchema,
	type ObjectService,
	type PhoneNumberService,
} from "../domain/index.ts";
import { parseFields, projectFields } from "./fields.ts";
import type { GraphEnv } from "./graph-env.ts";
import { phoneNumberNode } from "./object-routes.ts";
import { pagingOf } from "./paging.ts";
import { parseOrThrow, readJsonBody } from "./request-parsing.ts";

export interface PhoneNumberRoutesOptions {
	phoneNumbers: PhoneNumberService;
	objects: ObjectService;
}

/**
 * Phone number management (SPEC §2.11, §2.13–§2.17): listing a WABA's numbers, adding one, and
 * the four actions that walk it up the registration ladder (§4).
 *
 * All six are two segments deep with a literal second segment, so they never collide with
 * `POST /{id}` (the template edit) or with `messages` / `media` / `message_templates`.
 *
 * `request_code` and `verify_code` answer `{"success":true}` exactly like Meta: the code itself
 * is deliberately absent from every Graph response — it is read through the control plane, which
 * is whaloc playing the *phone* rather than Meta.
 */
export function createPhoneNumberRoutes(options: PhoneNumberRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.post("/:id/phone_numbers", async c => {
		const request = parseOrThrow(graphPhoneNumberCreateRequestSchema, await readJsonBody(c));
		const phoneNumber = await options.phoneNumbers.addToWaba(c.req.param("id"), request);

		return c.json({ id: phoneNumber.id });
	});

	routes.get("/:id/phone_numbers", async c => {
		const phoneNumbers = await options.objects.listPhoneNumbers(c.req.param("id"));
		const fields = parseFields(c.req.query("fields"));

		return c.json({
			data: phoneNumbers.map(phoneNumber => projectFields(phoneNumberNode(phoneNumber), fields)),
			// Unpaginated: every number of a WABA comes back at once, so there is no next page.
			paging: pagingOf(phoneNumbers.map(phoneNumber => phoneNumber.id)),
		});
	});

	routes.post("/:id/request_code", async c => {
		const request = parseOrThrow(requestCodeRequestSchema, await readJsonBody(c));

		await options.phoneNumbers.requestCode(c.req.param("id"), request);

		return c.json({ success: true });
	});

	routes.post("/:id/verify_code", async c => {
		const request = parseOrThrow(verifyCodeRequestSchema, await readJsonBody(c));

		await options.phoneNumbers.verifyCode(c.req.param("id"), request.code);

		return c.json({ success: true });
	});

	routes.post("/:id/register", async c => {
		parseOrThrow(registerPhoneNumberRequestSchema, await readJsonBody(c));

		await options.phoneNumbers.register(c.req.param("id"));

		return c.json({ success: true });
	});

	// Meta's deregister takes no body, so none is read: a bare `curl -X POST` has to work.
	routes.post("/:id/deregister", async c => {
		await options.phoneNumbers.deregister(c.req.param("id"));

		return c.json({ success: true });
	});

	return routes;
}
