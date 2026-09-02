import {
	businessProfileUpdateRequestSchema,
	phoneNumberCreateRequestSchema,
	phoneNumberListResponseSchema,
	phoneNumberQualityRequestSchema,
	phoneNumberResponseSchema,
	phoneNumberUpdateRequestSchema,
} from "@whaloc/shared";
import { Hono } from "hono";
import { toPhoneNumberDto, type BusinessProfileService, type PhoneNumberService } from "../domain/index.ts";
import { readBody, type ControlEnv } from "./control-env.ts";

export interface PhoneNumberRoutesOptions {
	phoneNumbers: PhoneNumberService;
	businessProfiles: BusinessProfileService;
}

/**
 * The phone numbers whaloc is emulating (SPEC §5): create one under a WABA, fix its display
 * number or verified name, delete it with everything hanging off it, and set the quality and
 * throughput `GET /{phoneNumberId}` reports — optionally announcing the change with
 * `phone_number_quality_update`, the way Meta does.
 *
 * A number created here is `CONNECTED` and `VERIFIED`: this is the "already onboarded" path, so
 * it can send immediately. The registration ladder lives on the Graph surface (SPEC §4), and the
 * verification code it generates is served in `pendingVerification` on every number below.
 */
export function createPhoneNumberRoutes(options: PhoneNumberRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/phone-numbers", async c => {
		const phoneNumbers = await options.phoneNumbers.list();

		return c.json(
			phoneNumberListResponseSchema.parse({
				data: phoneNumbers.map(phoneNumber => toPhoneNumberDto(phoneNumber)),
			}),
		);
	});

	routes.post("/phone-numbers", async c => {
		const body = await readBody(c, phoneNumberCreateRequestSchema);
		const phoneNumber = await options.phoneNumbers.create(body);

		return c.json(phoneNumberResponseSchema.parse({ data: toPhoneNumberDto(phoneNumber) }), 201);
	});

	routes.patch("/phone-numbers/:id", async c => {
		const body = await readBody(c, phoneNumberUpdateRequestSchema);
		const phoneNumber = await options.phoneNumbers.update(c.req.param("id"), body);

		return c.json(phoneNumberResponseSchema.parse({ data: toPhoneNumberDto(phoneNumber) }));
	});

	routes.delete("/phone-numbers/:id", async c => {
		const phoneNumber = await options.phoneNumbers.delete(c.req.param("id"));

		return c.json(phoneNumberResponseSchema.parse({ data: toPhoneNumberDto(phoneNumber) }));
	});

	/**
	 * The business profile, editable from Settings (SPEC §2.19, §5). Same merge semantics as the
	 * Graph endpoint — a field left out is left alone, an empty one is cleared — so the two ways
	 * in cannot drift.
	 */
	routes.post("/phone-numbers/:id/business-profile", async c => {
		const body = await readBody(c, businessProfileUpdateRequestSchema);
		const phoneNumber = await options.businessProfiles.update(c.req.param("id"), body);

		return c.json(phoneNumberResponseSchema.parse({ data: toPhoneNumberDto(phoneNumber) }));
	});

	routes.post("/phone-numbers/:id/quality", async c => {
		const body = await readBody(c, phoneNumberQualityRequestSchema);
		const phoneNumber = await options.phoneNumbers.updateQuality(c.req.param("id"), body);

		return c.json(phoneNumberResponseSchema.parse({ data: toPhoneNumberDto(phoneNumber) }));
	});

	return routes;
}
