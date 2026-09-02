import { Hono } from "hono";
import type { PhoneNumberRecord, TemplateRecord, WabaRecord } from "../db/index.ts";
import type { MediaDescriptor, MediaService, ObjectService } from "../domain/index.ts";
import { parseFields, projectFields } from "./fields.ts";
import type { GraphEnv } from "./graph-env.ts";

export interface ObjectRoutesOptions {
	objects: ObjectService;
	media: MediaService;
}

/**
 * SPEC §2.1 — `display_phone_number` stays formatted, and is never blank.
 *
 * The three lifecycle fields ride along (SPEC §4): a consumer that manages its own numbers reads
 * them, and `fields` narrows the node for one that does not — the usual four-field request
 * (`verified_name`, `display_phone_number`, `quality_rating`, `throughput`) is unaffected either
 * way.
 */
export function phoneNumberNode(record: PhoneNumberRecord): Record<string, unknown> {
	return {
		verified_name: record.verifiedName,
		display_phone_number: record.displayPhoneNumber,
		quality_rating: record.qualityRating,
		throughput: { level: record.throughputLevel },
		status: record.status,
		code_verification_status: record.codeVerificationStatus,
		name_status: record.nameStatus,
		id: record.id,
	};
}

/** SPEC §2.2. */
function wabaNode(record: WabaRecord): Record<string, unknown> {
	return { name: record.name, id: record.id };
}

/** SPEC §2.4. `parameter_format` rides along because a send is validated against it. */
export function templateNode(record: TemplateRecord): Record<string, unknown> {
	return {
		name: record.name,
		language: record.language,
		status: record.status,
		category: record.category,
		parameter_format: record.parameterFormat,
		components: record.components,
		id: record.id,
	};
}

/** SPEC §2.3 / §1.7 — the first hop of a media download. */
function mediaNode(descriptor: MediaDescriptor): Record<string, unknown> {
	return {
		messaging_product: "whatsapp",
		url: descriptor.url,
		mime_type: descriptor.mimeType,
		sha256: descriptor.sha256,
		file_size: descriptor.fileSize,
		id: descriptor.id,
	};
}

/**
 * `GET /{id}` for all four kinds of object (SPEC §2, rows 1–4). Which one it is comes from
 * whichever store holds the id, exactly like the real Graph API's node reads.
 *
 * Media is the one node that ignores `fields`: the consumer needs `url`, `mime_type`, `sha256`
 * and `file_size` together to complete the second hop (SPEC §1.7), and a projection that
 * dropped one of them would break it in a way that is hard to spot.
 */
export function createObjectRoutes(options: ObjectRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.get("/:id", async c => {
		const object = await options.objects.resolve(c.req.param("id"));
		const fields = parseFields(c.req.query("fields"));

		switch (object.kind) {
			case "phoneNumber": {
				return c.json(projectFields(phoneNumberNode(object.phoneNumber), fields));
			}

			case "waba": {
				return c.json(projectFields(wabaNode(object.waba), fields));
			}

			case "media": {
				const descriptor = options.media.describe(object.media, c.req.query("phone_number_id"));

				return c.json(mediaNode(descriptor));
			}

			case "template": {
				return c.json(projectFields(templateNode(object.template), fields));
			}
		}
	});

	return routes;
}
