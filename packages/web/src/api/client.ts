import { controlErrorSchema } from "@whaloc/shared";
import type { output, ZodType } from "zod";

/**
 * The one place the UI talks HTTP (SPEC §5).
 *
 * Every response is parsed with the schema the *server* validated it against, so a contract
 * drift surfaces here — with the route in the message — instead of as an undefined field three
 * components deep. Failures always arrive as an {@link ApiError} the toast surface can show.
 */

export interface ApiErrorOptions {
	/** `0` when the request never reached whaloc (offline, server restarting). */
	status: number;
	code?: string | undefined;
	cause?: unknown;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, options: ApiErrorOptions) {
		super(message, options);
		this.name = "ApiError";
		this.status = options.status;
		this.code = options.code;
	}

	/** Whether whaloc answered at all — a failed fetch is worth a different message. */
	get unreachable(): boolean {
		return this.status === 0;
	}
}

export interface RequestOptions<TSchema extends ZodType> {
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	/** JSON body; mutually exclusive with `form`. */
	body?: unknown;
	form?: FormData;
	/** Parsed against the response body. Omit for routes that answer with nothing. */
	schema: TSchema;
	signal?: AbortSignal | undefined;
}

/** Query parameters, skipping the ones that are not set. */
export function queryString(params: Record<string, string | number | undefined>): string {
	const query = new URLSearchParams();

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			query.set(key, String(value));
		}
	}

	const rendered = query.toString();

	return rendered === "" ? "" : `?${rendered}`;
}

function errorMessage(status: number, body: unknown): string {
	const parsed = controlErrorSchema.safeParse(body);

	return parsed.success ? parsed.data.error.message : `whaloc answered ${String(status)}`;
}

function errorCode(body: unknown): string | undefined {
	const parsed = controlErrorSchema.safeParse(body);

	return parsed.success ? parsed.data.error.code : undefined;
}

export async function request<TSchema extends ZodType>(
	path: string,
	options: RequestOptions<TSchema>,
): Promise<output<TSchema>> {
	const init: RequestInit = {
		method: options.method ?? "GET",
		signal: options.signal ?? null,
		...(options.form === undefined
			? options.body === undefined
				? {}
				: { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }
			: { body: options.form }),
	};

	let response: Response;

	try {
		response = await fetch(path, init);
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			throw error;
		}

		throw new ApiError(`cannot reach whaloc (${path})`, { status: 0, cause: error });
	}

	const text = await response.text();
	let body: unknown = null;

	if (text !== "") {
		try {
			body = JSON.parse(text);
		} catch (error) {
			throw new ApiError(`whaloc answered ${path} with a body that is not JSON`, {
				status: response.status,
				cause: error,
			});
		}
	}

	if (!response.ok) {
		throw new ApiError(errorMessage(response.status, body), {
			status: response.status,
			code: errorCode(body),
		});
	}

	const parsed = options.schema.safeParse(body);

	if (!parsed.success) {
		throw new ApiError(`whaloc answered ${path} with an unexpected shape: ${parsed.error.issues[0]?.message ?? ""}`, {
			status: response.status,
			cause: parsed.error,
		});
	}

	return parsed.data;
}

/** The message to show for anything a component caught while calling the API. */
export function describeError(error: unknown): string {
	if (error instanceof ApiError) {
		return error.unreachable ? "whaloc is unreachable — is the server running?" : error.message;
	}

	return Error.isError(error) ? error.message : String(error);
}
