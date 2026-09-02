import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.ts";
import { createFbtraceId } from "../domain/index.ts";

/**
 * Hono environment of the Graph API surface: the app-wide request logger plus the two values
 * every Graph route needs — the Meta-shaped request id and the version the caller used.
 */
export interface GraphEnv extends AppEnv {
	Variables: AppEnv["Variables"] & {
		fbRequestId: string;
		/** `v25.0`, `v99.9`, … — whatever prefix the caller used, echoed into `paging.next`. */
		version: string;
	};
}

/** Header Meta tags every response with; the consumer logs it verbatim (SPEC §1.11). */
export const FB_REQUEST_ID_HEADER = "x-fb-request-id";

/**
 * The mount point of the whole Graph surface (SPEC §1.1). The consumer bakes a version into
 * `GRAPH_API_BASE_URL`, so **any** `v<major>.<minor>` has to answer, not just `v25.0`.
 */
export const GRAPH_VERSION_PATH = String.raw`/:version{v\d+\.\d+}`;

const VERSION_IN_PATH_PATTERN = /^\/(v\d+\.\d+)(?=\/|$)/;

/** Used only when the version cannot be read back off the path, which the router prevents. */
const FALLBACK_VERSION = "v25.0";

/**
 * Seeds the Graph request context.
 *
 * The request id is generated once and used twice: echoed as `x-fb-request-id` and reused as
 * the `fbtrace_id` of any error envelope. Meta emits two unrelated ids there; sharing one is a
 * deliberate deviation that buys the thing that matters while debugging — the id in the
 * failing response is the id in the logs.
 */
export function createGraphContext(): MiddlewareHandler<GraphEnv> {
	return async (c, next) => {
		const fbRequestId = createFbtraceId();

		c.set("fbRequestId", fbRequestId);
		c.set("version", VERSION_IN_PATH_PATTERN.exec(c.req.path)?.[1] ?? FALLBACK_VERSION);
		c.header(FB_REQUEST_ID_HEADER, fbRequestId);

		await next();
	};
}
