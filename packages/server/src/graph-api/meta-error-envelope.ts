import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { GraphApiError, isGraphApiError } from "../domain/index.ts";
import { FB_REQUEST_ID_HEADER, type GraphEnv } from "./graph-env.ts";

/**
 * The single place a domain error becomes Meta's error envelope (SPEC §1.4, §8).
 *
 * ```json
 * {"error":{"message":"(#132000) …","type":"OAuthException","code":132000,
 *   "error_subcode":33,"error_data":{"messaging_product":"whatsapp","details":"…"},
 *   "fbtrace_id":"A…"}}
 * ```
 *
 * `error_subcode` and `error_data` appear only when the error carries them; `fbtrace_id`
 * always does.
 */
export interface MetaErrorEnvelope {
	error: {
		message: string;
		type: string;
		code: number;
		error_subcode?: number;
		error_data?: { messaging_product: "whatsapp"; details: string };
		fbtrace_id: string;
	};
}

/** What Meta answers when its own side broke; the vendored v25.0 specs use code 1. */
const INTERNAL_ERROR = new GraphApiError("An unexpected error occurred", { code: 1, httpStatus: 500 });

export function toMetaErrorEnvelope(error: GraphApiError, fbtraceId: string): MetaErrorEnvelope {
	return {
		error: {
			message: error.message,
			type: error.type,
			code: error.code,
			...(error.subcode !== undefined && { error_subcode: error.subcode }),
			...(error.details !== undefined && {
				error_data: { messaging_product: "whatsapp", details: error.details } as const,
			}),
			fbtrace_id: fbtraceId,
		},
	};
}

/**
 * The Graph surface's `onError`. Anything that is not a {@link GraphApiError} is a bug in
 * whaloc, so it is logged with its stack and answered with Meta's internal-error envelope —
 * stack traces never reach the wire (SPEC §8).
 */
export function createGraphErrorHandler(): ErrorHandler<GraphEnv> {
	return (error, c) => {
		const graphError = isGraphApiError(error) ? error : INTERNAL_ERROR;
		// Always set: `createGraphContext` is the first middleware on this router, so it has
		// run before anything downstream can throw.
		const fbtraceId = c.var.fbRequestId;

		if (graphError === INTERNAL_ERROR) {
			c.var.logger.error({ err: error, fbtraceId }, "graph api request failed unexpectedly");
		} else {
			c.var.logger.debug(
				{ code: graphError.code, subcode: graphError.subcode, details: graphError.details, fbtraceId },
				graphError.message,
			);
		}

		const response = c.json(toMetaErrorEnvelope(graphError, fbtraceId), graphError.httpStatus as ContentfulStatusCode);

		// Headers that belong to the failure itself: `Retry-After` and
		// `X-Business-Use-Case-Usage` on a throttle (SPEC §1.11). Set here rather than at the
		// throw site, so *one* place turns a domain error into an HTTP response.
		if (graphError.headers != null) {
			for (const [name, value] of Object.entries(graphError.headers)) {
				response.headers.set(name, value);
			}
		}

		// `c.header()` from the request-id middleware never ran for errors thrown inside it,
		// and a response built here bypasses prepared headers on some Hono paths; setting it
		// on the finished response keeps the guarantee that *every* Graph response carries one.
		response.headers.set(FB_REQUEST_ID_HEADER, fbtraceId);

		return response;
	};
}
