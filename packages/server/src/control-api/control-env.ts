import type { ControlError } from "@whaloc/shared";
import type { Context, ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { output, ZodError, ZodType } from "zod";
import type { AppEnv } from "../app-env.ts";
import { ControlPlaneError, isControlPlaneError, isGraphApiError } from "../domain/index.ts";

/**
 * The control plane's HTTP conventions (SPEC §5, §8).
 *
 * It is whaloc's own API, not Meta's: errors are a plain `{error:{message,code?}}`, there is
 * **no bearer authentication** (it is a local dev tool, and the UI is a pure browser client),
 * and every request body is validated with the same zod schemas the UI imports from
 * `@whaloc/shared` — so a shape the UI can send is a shape the server accepts, by construction.
 */
export type ControlEnv = AppEnv;

function errorBody(message: string, code?: string): ControlError {
	return { error: { message, ...(code !== undefined && { code }) } };
}

/** Answers a control-plane request with the plain error shape. */
export function controlError(
	c: Context<ControlEnv>,
	status: ContentfulStatusCode,
	message: string,
	code?: string,
): Response {
	return c.json(errorBody(message, code), status);
}

/** `Param text.body Too small: …`, the same phrasing the Graph surface uses in `details`. */
function describeIssue(issue: ZodError["issues"][number]): string {
	const path = issue.path.map(String).join(".");

	return path === "" ? issue.message : `${path}: ${issue.message}`;
}

export function zodMessage(error: ZodError): string {
	return error.issues.map(issue => describeIssue(issue)).join("; ");
}

export async function readJsonBody(c: Context<ControlEnv>): Promise<unknown> {
	try {
		return await c.req.json<unknown>();
	} catch (error) {
		throw new ControlPlaneError("invalid JSON in request body", { status: 400, code: "invalid_json", cause: error });
	}
}

/**
 * The body of a request that may not have one — the moderation actions take their options as
 * an optional body, so a bare `POST` from a UI button has to work.
 */
export async function readOptionalJsonBody(c: Context<ControlEnv>): Promise<unknown> {
	try {
		return await c.req.json<unknown>();
	} catch {
		return {};
	}
}

/** Parses a value with a shared schema, raising a 400 with every issue listed. */
export function parseOrThrow<Schema extends ZodType>(schema: Schema, value: unknown): output<Schema> {
	const result = schema.safeParse(value);

	if (!result.success) {
		throw new ControlPlaneError(zodMessage(result.error), { status: 400, code: "invalid_request" });
	}

	return result.data;
}

/** Reads and validates a JSON body in one step. */
export async function readBody<Schema extends ZodType>(
	c: Context<ControlEnv>,
	schema: Schema,
): Promise<output<Schema>> {
	return parseOrThrow(schema, await readJsonBody(c));
}

/**
 * The control plane's `onError`. Domain errors carry their own status; a
 * {@link GraphApiError} raised by a service shared with the Graph surface (a media upload,
 * say) keeps its status too, but is reported in the control plane's shape rather than Meta's.
 * Anything else is a bug: logged with its stack, answered without one (SPEC §8).
 */
export function createControlErrorHandler(): ErrorHandler<ControlEnv> {
	return (error, c) => {
		if (isControlPlaneError(error)) {
			return controlError(c, error.status as ContentfulStatusCode, error.message, error.code);
		}

		if (isGraphApiError(error)) {
			return controlError(c, error.httpStatus as ContentfulStatusCode, error.message, String(error.code));
		}

		c.var.logger.error({ err: error }, "control-plane request failed unexpectedly");

		return controlError(c, 500, "Internal Server Error");
	};
}
