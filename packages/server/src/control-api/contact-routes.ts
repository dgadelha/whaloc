import {
	contactCreateRequestSchema,
	contactListResponseSchema,
	contactNumberChangeRequestSchema,
	contactResponseSchema,
	contactUpdateRequestSchema,
} from "@whaloc/shared";
import { Hono } from "hono";
import { toContactDto, type ContactService } from "../domain/index.ts";
import { controlError, readBody, type ControlEnv } from "./control-env.ts";

export interface ContactRoutesOptions {
	contacts: ContactService;
}

/**
 * `GET/POST /api/contacts`, `PATCH /api/contacts/:waId` and
 * `POST /api/contacts/:waId/change-number` (SPEC §5).
 */
export function createContactRoutes(options: ContactRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/contacts", async c => {
		const contacts = await options.contacts.list();

		return c.json(contactListResponseSchema.parse({ data: contacts.map(contact => toContactDto(contact)) }));
	});

	routes.post("/contacts", async c => {
		const body = await readBody(c, contactCreateRequestSchema);
		const contact = await options.contacts.create(body);

		return c.json(contactResponseSchema.parse({ data: toContactDto(contact) }), 201);
	});

	routes.patch("/contacts/:waId", async c => {
		const body = await readBody(c, contactUpdateRequestSchema);
		const contact = await options.contacts.update(c.req.param("waId"), body);

		if (contact === null) {
			return controlError(c, 404, `no contact with wa_id ${c.req.param("waId")}`, "unknown_contact");
		}

		return c.json(contactResponseSchema.parse({ data: toContactDto(contact) }));
	});

	/** Meta's `user_changed_number`: the contact moves, its history follows, the webhook goes out. */
	routes.post("/contacts/:waId/change-number", async c => {
		const body = await readBody(c, contactNumberChangeRequestSchema);
		const contact = await options.contacts.changeNumber(c.req.param("waId"), body);

		return c.json(contactResponseSchema.parse({ data: toContactDto(contact) }));
	});

	return routes;
}
