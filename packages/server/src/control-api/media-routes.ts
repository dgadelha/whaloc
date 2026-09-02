import { mediaResponseSchema, uploadQuerySchema, uploadResponseSchema } from "@whaloc/shared";
import { Hono } from "hono";
import type { MediaService, UploadService } from "../domain/index.ts";
import { controlError, parseOrThrow, type ControlEnv } from "./control-env.ts";

export interface MediaRoutesOptions {
	media: MediaService;
	uploads: UploadService;
}

/**
 * `GET /api/media/:id` (SPEC §5).
 *
 * A media message stores the node Meta puts in the webhook — `{id, mime_type, sha256}` — and
 * nothing more, so the UI needs one lookup to turn that id into something an `<img>` can
 * point at. It is the Graph API's first download hop (SPEC §1.7) in the control plane's
 * clothes: no bearer token, whaloc's own error shape, and a plain 404 for an unknown id
 * instead of Meta's "object missing" envelope.
 *
 * `WHALOC_MEDIA_TTL_SECONDS` is deliberately **not** applied here (SPEC §4): the TTL belongs to
 * the surface under test, and whaloc's own inspector still has to be able to say what a
 * message's media id points at after the Graph surface has aged it out.
 */
export function createMediaRoutes(options: MediaRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/media/:id", async c => {
		const id = c.req.param("id");
		const media = await options.media.find(id);

		if (media === null) {
			return controlError(c, 404, `no media object with ID ${id}`, "unknown_media");
		}

		return c.json(mediaResponseSchema.parse({ data: options.media.descriptor(media) }));
	});

	/**
	 * `GET /api/uploads?handle=…` — the same lookup for a **resumable-upload handle** (SPEC §5).
	 *
	 * A template's `example.header_handle` carries a handle, not a media id, so the Templates view
	 * cannot preview a media header through `GET /api/media/:id`. The handle rides in the query
	 * string rather than in the path because Meta's handles are full of colons and slashes-adjacent
	 * base64: one less escaping question between the UI and the router.
	 */
	routes.get("/uploads", async c => {
		const { handle } = parseOrThrow(uploadQuerySchema, c.req.query());
		const session = await options.uploads.findByHandle(handle);
		const descriptor = session === null ? null : options.uploads.descriptor(session);

		if (descriptor === null) {
			return controlError(c, 404, `no completed upload with handle ${handle}`, "unknown_upload");
		}

		return c.json(uploadResponseSchema.parse({ data: descriptor }));
	});

	return routes;
}
