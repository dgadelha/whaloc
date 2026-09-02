import { Hono, type Context } from "hono";
import { z } from "zod";
import {
	invalidParameterError,
	parseUploadSessionId,
	uploadSessionIdOf,
	type MediaService,
	type UploadService,
} from "../domain/index.ts";
import type { GraphEnv } from "./graph-env.ts";
import { parseOrThrow } from "./request-parsing.ts";

export interface UploadRoutesOptions {
	uploads: UploadService;
	/** The shared upload cap; a chunk is checked against it before its bytes are read. */
	media: MediaService;
}

/**
 * Meta's **Resumable Upload API** (SPEC §2.21) — the three calls a `header_handle` really comes
 * from, mounted under the version prefix like everything else on this surface.
 *
 * ```
 * POST /v25.0/{app-id}/uploads?file_length=&file_type=&file_name=  → {"id":"upload:<opaque>"}
 * POST /v25.0/upload:<opaque>   (file_offset: 0, raw bytes)        → {"h":"<handle>"}
 * GET  /v25.0/upload:<opaque>                                      → {"id":…,"file_offset":N}
 * ```
 *
 * Two things about the second and third are worth spelling out:
 *
 * - **The path segment contains a colon**, because Meta's session id is literally `upload:` plus
 *   an opaque string and the caller pastes it straight into the URL. A regex-constrained
 *   parameter (`:uploadId{upload:…}`) matches it as one segment, and this router is mounted
 *   *before* the template one so `POST /upload:…` never reaches `POST /{templateId}`.
 * - **The parameters may arrive twice.** Meta documents them as query parameters, its own SDKs
 *   send them in the body, and `file_offset` is a header. whaloc reads the query first and falls
 *   back to a JSON or form body, so either style works and neither has to be guessed at.
 */

/** The one segment shape a session id can take; `\w` covers base64url minus its `-`. */
const UPLOAD_SESSION_ROUTE = String.raw`/:uploadId{upload:[\w-]+}`;

const fileLengthSchema = z.coerce
	.number("Param file_length must be a whole number of bytes")
	.int("Param file_length must be a whole number of bytes")
	.positive("Param file_length must be a whole number of bytes greater than zero");

const fileOffsetSchema = z.coerce
	.number("Param file_offset must be a whole number of bytes")
	.int("Param file_offset must be a whole number of bytes")
	.nonnegative("Param file_offset must be a whole number of bytes");

/** The session-open parameters, from wherever the caller put them. */
interface SessionParameters {
	fileLength: unknown;
	fileType: unknown;
	fileName: unknown;
}

function readParameters(query: Record<string, string>, body: unknown): SessionParameters {
	const fromBody = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

	return {
		fileLength: query["file_length"] ?? fromBody["file_length"],
		fileType: query["file_type"] ?? fromBody["file_type"],
		fileName: query["file_name"] ?? fromBody["file_name"],
	};
}

/**
 * The body of a session-open call, which usually has none. A `POST` with no body at all, an
 * empty one, a JSON one and a form one all have to work, so nothing here is fatal.
 */
async function readOptionalBody(c: Context<GraphEnv>): Promise<unknown> {
	try {
		return await c.req.json<unknown>();
	} catch {
		try {
			return await c.req.parseBody();
		} catch {
			return {};
		}
	}
}

export function createUploadRoutes(options: UploadRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.post("/:appId/uploads", async c => {
		const parameters = readParameters(c.req.query(), await readOptionalBody(c));

		if (typeof parameters.fileType !== "string") {
			throw invalidParameterError("Param file_type is required and must be a MIME type such as image/jpeg");
		}

		const session = await options.uploads.createSession({
			appId: c.req.param("appId"),
			fileLength: parseOrThrow(fileLengthSchema, parameters.fileLength),
			fileType: parameters.fileType,
			...(typeof parameters.fileName === "string" && { fileName: parameters.fileName }),
		});

		return c.json({ id: uploadSessionIdOf(session) });
	});

	routes.get(UPLOAD_SESSION_ROUTE, async c => {
		// The route pattern guarantees the `upload:` prefix, so this never falls back.
		const sessionId = parseUploadSessionId(c.req.param("uploadId") ?? "") ?? "";
		const status = await options.uploads.status(sessionId);

		// The domain speaks camelCase; Meta's wire name is `file_offset`, and this is the edge.
		return c.json({ id: status.id, file_offset: status.fileOffset });
	});

	routes.post(UPLOAD_SESSION_ROUTE, async c => {
		const sessionId = parseUploadSessionId(c.req.param("uploadId") ?? "") ?? "";
		const contentLength = Number(c.req.header("content-length") ?? "");

		if (Number.isFinite(contentLength)) {
			options.media.assertWithinCap(contentLength);
		}

		// Meta puts the offset in a header on this call; the query string is accepted too, because
		// a curl-driven smoke test is easier to write that way and nothing is lost by taking both.
		const fileOffset = parseOrThrow(fileOffsetSchema, c.req.header("file_offset") ?? c.req.query("file_offset") ?? 0);
		const bytes = new Uint8Array(await c.req.arrayBuffer());

		options.media.assertWithinCap(bytes.byteLength);

		const session = await options.uploads.append(sessionId, fileOffset, bytes);

		// A session that is not full yet has no handle to give: Meta answers the completed upload
		// with `{"h":…}` and an in-progress one with the offset it is now at (SPEC §2.21).
		return session.handle === null
			? c.json({ id: uploadSessionIdOf(session), file_offset: session.receivedBytes })
			: c.json({ h: session.handle });
	});

	return routes;
}
