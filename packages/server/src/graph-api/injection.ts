import type { InjectionTarget } from "@whaloc/shared";
import type { Context, MiddlewareHandler } from "hono";
import { MEDIA_DOWNLOAD_PATH, type InjectionService } from "../domain/index.ts";
import type { GraphEnv } from "./graph-env.ts";

/**
 * Where the injection rules meet HTTP (SPEC §4).
 *
 * The split is the usual one: this file works out **which endpoint class** a request belongs to
 * and turns the domain's answer into a thrown error; {@link InjectionService} owns the decision
 * and the counters. That is why the classification below is a pure function — the interesting
 * part of it is testable without a server.
 */

const VERSION_PREFIX_PATTERN = /^\/v\d+\.\d+(?=\/|$)/;

export interface GraphRequestShape {
	method: string;
	/** The request path, with or without the `/v<major>.<minor>` prefix. */
	path: string;
	/** `?phone_number_id=` present — what identifies the media descriptor hop (SPEC §2.3). */
	hasPhoneNumberId: boolean;
}

/**
 * The endpoint class of one request, or `null` when it is on the Graph surface but in no class of
 * its own (a WABA read, a phone-number listing, `register`, …). A `graph.all` rule still matches
 * those; a targeted rule does not.
 *
 * Two classifications are worth spelling out:
 *
 * - **`messages.send` names the path, not the intention.** `POST /{id}/messages` is also how
 *   Meta delivers a read receipt (SPEC §2.18), and a middleware that had to read the body to
 *   tell them apart would be reaching past its job.
 * - **`media.resolve` is the descriptor hop specifically**: `GET /{id}?phone_number_id=…`, which
 *   is how the consumer asks for media and the only way to know an id is media without a
 *   database lookup.
 */
export function classifyEndpoint(request: GraphRequestShape): InjectionTarget | null {
	const path = request.path.replace(VERSION_PREFIX_PATTERN, "");

	if (path.startsWith(`${MEDIA_DOWNLOAD_PATH}/`)) {
		return "media.download";
	}

	const segments = path.split("/").filter(segment => segment !== "");
	const method = request.method.toUpperCase();

	if (segments.length === 2) {
		switch (`${method} ${segments[1]!}`) {
			case "POST messages": {
				return "messages.send";
			}

			case "POST media": {
				return "media.upload";
			}

			case "POST message_templates": {
				return "templates.create";
			}

			case "GET message_templates": {
				return "templates.list";
			}

			default: {
				return null;
			}
		}
	}

	if (segments.length !== 1) {
		return null;
	}

	// The one `GET /{id}` that names a phone number is the media descriptor hop (SPEC §2.3).
	return method === "GET" && request.hasPhoneNumberId ? "media.resolve" : null;
}

/** Reads the shape off a Hono context, so the classifier itself stays framework-free. */
function shapeOf(c: Context<GraphEnv>): GraphRequestShape {
	return {
		method: c.req.method,
		path: c.req.path,
		hasPhoneNumberId: c.req.query("phone_number_id") !== undefined,
	};
}

export interface InjectionMiddlewareOptions {
	injection: InjectionService;
}

/**
 * The one place a configured failure short-circuits a Graph request (SPEC §4).
 *
 * It runs **after** the bearer-auth gate: authentication is the first thing the real API checks,
 * and an armed `graph.all` rule that swallowed a 401 would turn a token problem into a rate-limit
 * mystery. Everything after it — routing, validation, the handlers — never runs on an injected
 * request: the error is thrown, and the surface's single `onError` writes Meta's envelope with
 * whatever headers the preset carries.
 *
 * Every injection is logged at `info`. A failure whaloc *was told* to produce is not a warning,
 * but it is the first thing a confused developer should find in the log.
 */
export function createInjectionMiddleware(options: InjectionMiddlewareOptions): MiddlewareHandler<GraphEnv> {
	return async (c, next) => {
		const target = classifyEndpoint(shapeOf(c));
		const decision = await options.injection.evaluate(target);

		if (decision === null) {
			await next();

			return;
		}

		const { rule, error } = decision;

		c.var.logger.info(
			{
				ruleId: rule.id,
				target: rule.target,
				matchedAs: target ?? "graph.all",
				preset: rule.preset,
				trigger: rule.trigger,
				remaining: rule.remaining,
				matches: rule.matches,
				status: error.httpStatus,
				code: error.code,
				fbtraceId: c.var.fbRequestId,
			},
			"error injection rule fired: answering with the configured failure",
		);

		throw error;
	};
}
