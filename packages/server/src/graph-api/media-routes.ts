import { Hono } from "hono";
import { invalidParameterError, unknownObjectError, type MediaService } from "../domain/index.ts";
import type { GraphEnv } from "./graph-env.ts";

export interface MediaRoutesOptions {
	media: MediaService;
}

/** What an upload is recorded as when neither the `type` part nor the file itself says. */
const FALLBACK_MIME_TYPE = "application/octet-stream";

/**
 * `POST /{phoneNumberId}/media` (SPEC §2.6).
 *
 * The consumer streams a multipart body whose first part is an injected
 * `messaging_product=whatsapp`, followed by `file` (binary) and `type` (a MIME string), with
 * `Content-Length` present or the body chunked (SPEC §1.8). Three decisions follow from that:
 *
 * - **`messaging_product` is accepted and ignored.** Meta requires it; rejecting a body that
 *   spells it differently would only make whaloc harder to point a client at.
 * - **`type` is optional but recorded.** Meta documents it as required, yet the part is easy
 *   to forget and the browser already labels the file part with a content type. When `type`
 *   is absent whaloc falls back to the file part's own type, then to
 *   `application/octet-stream`. Whatever it settles on is what `GET /{mediaId}` reports as
 *   `mime_type` and what the byte endpoint serves as `Content-Type`.
 * - **The body is buffered, not streamed.** `Request.formData()` materializes the parts, so a
 *   100 MiB upload is a 100 MiB allocation. Streaming multipart would mean another
 *   dependency for a dev tool that uploads a handful of files; the cap is checked against
 *   `Content-Length` first so an oversized body is rejected before it is read.
 */
export function createMediaRoutes(options: MediaRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.post("/:id/media", async c => {
		const contentLength = Number(c.req.header("content-length") ?? "");

		if (Number.isFinite(contentLength)) {
			options.media.assertWithinCap(contentLength);
		}

		let form: FormData;

		try {
			form = await c.req.formData();
		} catch (error) {
			throw invalidParameterError("Param file is required in a multipart/form-data body", { cause: error });
		}

		const file = form.get("file");

		if (!(file instanceof File)) {
			throw invalidParameterError("Param file is required in a multipart/form-data body");
		}

		options.media.assertWithinCap(file.size);

		const declaredType = form.get("type");
		const mimeType =
			(typeof declaredType === "string" ? declaredType.trim() : "") || file.type.trim() || FALLBACK_MIME_TYPE;
		const media = await options.media.upload({
			phoneNumberId: c.req.param("id"),
			bytes: new Uint8Array(await file.arrayBuffer()),
			mimeType,
		});

		return c.json({ id: media.id });
	});

	/**
	 * `DELETE /{mediaId}` (SPEC §2.6b) — the object and its bytes, gone.
	 *
	 * `?phone_number_id=` is optional and scopes the delete exactly like the descriptor hop does:
	 * another number's object is reported missing rather than deleted. So is an id that is not
	 * media at all — a phone number, a WABA, a template — because `DELETE /{id}` on this surface
	 * is the media endpoint and nothing else, and answering the uniform missing-object envelope
	 * (400 / 100 / 33, SPEC §1.4) is what a consumer already knows how to read.
	 *
	 * Afterwards the id resolves to that same envelope and the byte URL 404s like an unknown
	 * token, which is the whole point: it is how a consumer's "this media is gone" path is
	 * rehearsed without waiting out `WHALOC_MEDIA_TTL_SECONDS`.
	 */
	routes.delete("/:id", async c => {
		const id = c.req.param("id");
		const media = await options.media.find(id);

		if (media === null) {
			throw unknownObjectError(id);
		}

		await options.media.delete(media, c.req.query("phone_number_id"));

		return c.json({ success: true });
	});

	return routes;
}
