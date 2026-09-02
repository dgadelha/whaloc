import { inboundMediaResponseSchema, inboundRequestSchema, inboundResponseSchema, metaIdSchema } from "@whaloc/shared";
import { Hono } from "hono";
import { ControlPlaneError, toMessageDto, type InboundService, type MediaService } from "../domain/index.ts";
import { parseOrThrow, readBody, type ControlEnv } from "./control-env.ts";

export interface InboundRoutesOptions {
	inbound: InboundService;
	media: MediaService;
}

/** What an upload is recorded as when neither the `type` part nor the file itself says. */
const FALLBACK_MIME_TYPE = "application/octet-stream";

/**
 * Simulating the user side (SPEC §5).
 *
 * - `POST /api/inbound` covers every inbound type; media branches reference a media id.
 * - `POST /api/inbound-media` is the upload that produces such an id. It exists next to the
 *   Graph API's `POST /{phoneNumberId}/media` because the UI is not the app under test: it
 *   sends a browser `FormData` and wants whaloc's own error shape back, not Meta's.
 *   The bytes land in the same storage, so an inbound image is downloadable through the
 *   normal two-hop Graph flow (SPEC §1.7).
 */
export function createInboundRoutes(options: InboundRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.post("/inbound", async c => {
		const request = await readBody(c, inboundRequestSchema);
		const message = await options.inbound.simulate(request);

		return c.json(inboundResponseSchema.parse({ data: toMessageDto(message) }), 201);
	});

	routes.post("/inbound-media", async c => {
		let form: FormData;

		try {
			form = await c.req.formData();
		} catch (error) {
			throw new ControlPlaneError("expected a multipart/form-data body", {
				status: 400,
				code: "invalid_upload",
				cause: error,
			});
		}

		const file = form.get("file");

		if (!(file instanceof File)) {
			throw new ControlPlaneError("the file part is required", { status: 400, code: "invalid_upload" });
		}

		const phoneNumberId = parseOrThrow(metaIdSchema, form.get("phoneNumberId"));
		const declaredType = form.get("type");
		const mimeType =
			(typeof declaredType === "string" ? declaredType.trim() : "") || file.type.trim() || FALLBACK_MIME_TYPE;
		const media = await options.media.upload({
			phoneNumberId,
			bytes: new Uint8Array(await file.arrayBuffer()),
			mimeType,
		});

		return c.json(
			inboundMediaResponseSchema.parse({
				data: {
					id: media.id,
					phoneNumberId: media.phoneNumberId,
					mimeType: media.mimeType,
					sha256: media.sha256,
					fileSize: media.fileSize,
					createdAt: media.createdAt,
				},
			}),
			201,
		);
	});

	return routes;
}
