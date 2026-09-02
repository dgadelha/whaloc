import type { Context } from "hono";
import type { output, ZodError, ZodType } from "zod";
import { invalidParameterError } from "../domain/index.ts";

/**
 * Turning a request into validated data, and a validation failure into Meta's envelope.
 *
 * Meta answers a bad body with one sentence — `(#100) Invalid parameter` — and puts the
 * specific complaint in `error_data.details` (`Param messaging_product must be whatsapp`).
 * whaloc reproduces that, filling `details` from the zod issues so a developer sees what is
 * actually wrong instead of having to guess.
 */

export async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json<unknown>();
	} catch (error) {
		throw invalidParameterError("Invalid JSON in request body", { cause: error });
	}
}

/** `Param text.body Too small: …`, or the issue's own wording when it already reads that way. */
function describeIssue(issue: ZodError["issues"][number]): string {
	if (issue.message.startsWith("Param ")) {
		return issue.message;
	}

	const path = issue.path.map(String).join(".");

	return path === "" ? issue.message : `Param ${path} ${issue.message}`;
}

export function zodIssueDetails(error: ZodError): string {
	return error.issues.map(issue => describeIssue(issue)).join("; ");
}

/** Parses with a schema, raising the Meta envelope on failure. */
export function parseOrThrow<Schema extends ZodType>(schema: Schema, value: unknown): output<Schema> {
	const result = schema.safeParse(value);

	if (!result.success) {
		throw invalidParameterError(zodIssueDetails(result.error));
	}

	return result.data;
}
