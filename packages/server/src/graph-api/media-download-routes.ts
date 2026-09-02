import { Hono, type Context } from "hono";
import { Readable } from "node:stream";
import {
	MEDIA_DOWNLOAD_PATH,
	UPLOAD_DOWNLOAD_PATH,
	type InjectionService,
	type MediaService,
	type UploadService,
} from "../domain/index.ts";
import { contentRangeHeader, parseByteRange, unsatisfiableContentRangeHeader } from "./byte-range.ts";
import { createGraphContext, type GraphEnv } from "./graph-env.ts";
import { createInjectionMiddleware } from "./injection.ts";
import { createGraphErrorHandler } from "./meta-error-envelope.ts";

export interface MediaDownloadRoutesOptions {
	media: MediaService;
	/** Serves the bytes behind a resumable-upload handle (SPEC §2.22). */
	uploads: UploadService;
	/** Error simulation (SPEC §4): `media.download` and `graph.all` rules fire here too. */
	injection: InjectionService;
}

/** Everything a byte response needs, whichever store the object came out of. */
interface ServedObject {
	size: number;
	mimeType: string;
	open: (range?: { start: number; end: number }) => Promise<Readable>;
}

/**
 * The second hop of a media download (SPEC §1.7, §2.12). Mounted at the **root**, with no
 * version prefix, because the URL handed out by `GET /{mediaId}` is opaque to the consumer.
 *
 * Four properties the consumer depends on, all of them load-bearing:
 *
 * - **Never redirects.** A 3xx here is treated as a hard failure on the other side.
 * - **Serves `Range`**: a single range answers 206 with `Content-Range` and a `Content-Length`
 *   covering only the slice; an unsatisfiable one answers 416.
 * - **Sets `Content-Type`** from the stored MIME type and always advertises `Accept-Ranges`.
 * - **No `Authorization` required.** The unguessable token in the path *is* the credential,
 *   which also lets the web UI render media straight from an `<img>` tag. Unknown tokens are a
 *   plain 404 — this route is outside the Graph surface, so it carries no Meta envelope. Media
 *   past `WHALOC_MEDIA_TTL_SECONDS` answers the same way, which is what Meta's CDN does with an
 *   expired object: the descriptor hop is where an expiry is *explained* (SPEC §4).
 *
 * It carries the Graph request context and error handler all the same, because it is a target of
 * the injection rules (SPEC §4) and an injected failure has to be Meta-shaped wherever it lands.
 */
export function createMediaDownloadRoutes(options: MediaDownloadRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.use(createGraphContext());
	routes.use(createInjectionMiddleware({ injection: options.injection }));

	/** The response itself, shared by both byte endpoints — the rules above are the same for each. */
	async function serve(c: Context<GraphEnv>, object: ServedObject): Promise<Response> {
		const { size } = object;
		const range = parseByteRange(c.req.header("range"), size);

		if (range.kind === "unsatisfiable") {
			return c.body(null, 416, {
				"Accept-Ranges": "bytes",
				"Content-Range": unsatisfiableContentRangeHeader(size),
			});
		}

		const slice = range.kind === "range" ? range : { start: 0, end: Math.max(size - 1, 0) };
		const contentLength = size === 0 ? 0 : slice.end - slice.start + 1;
		const stream = await object.open(range.kind === "range" ? range : undefined);

		return c.body(Readable.toWeb(stream), range.kind === "range" ? 206 : 200, {
			"Accept-Ranges": "bytes",
			"Content-Type": object.mimeType,
			"Content-Length": String(contentLength),
			...(range.kind === "range" && { "Content-Range": contentRangeHeader(range, size) }),
		});
	}

	routes.get(`${MEDIA_DOWNLOAD_PATH}/:token`, async c => {
		const media = await options.media.findByUrlToken(c.req.param("token"));

		if (media === null) {
			return c.text("Not Found", 404);
		}

		return serve(c, {
			size: media.fileSize,
			mimeType: media.mimeType,
			open: range => options.media.open(media, range),
		});
	});

	/**
	 * The same endpoint for a **resumable-upload handle** (SPEC §2.22).
	 *
	 * A handle is not a media id and its bytes are not scoped to a phone number, so they get
	 * their own token space rather than being smuggled into the media one. It is what a template's
	 * header preview and a `profile_picture_url` set from a handle point at, which is why it
	 * carries no `Authorization` requirement either: the unguessable token is the credential, and
	 * a browser `<img>` has none to give.
	 *
	 * Only a **completed** session is served: a half-filled one has no token, so its bytes have no
	 * URL to be reached by.
	 */
	routes.get(`${UPLOAD_DOWNLOAD_PATH}/:token`, async c => {
		const session = await options.uploads.findByUrlToken(c.req.param("token"));

		if (session === null || session.handle === null) {
			return c.text("Not Found", 404);
		}

		return serve(c, {
			size: session.receivedBytes,
			mimeType: session.fileType,
			open: range => options.uploads.open(session, range),
		});
	});

	routes.onError(createGraphErrorHandler());

	return routes;
}
