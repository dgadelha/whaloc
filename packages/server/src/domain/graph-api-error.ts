/**
 * The one error type Graph API behavior throws (SPEC §8). It carries everything the Meta
 * envelope needs and nothing about HTTP transport, so domain services can raise it without
 * knowing they are being called from a Hono handler.
 *
 * Instances are built through the factories in `meta-errors.ts`, never inline: that keeps the
 * wording of every envelope whaloc emits in one reviewable list.
 */
export interface GraphApiErrorOptions extends ErrorOptions {
	/** Meta's numeric error code, e.g. `100`, `190`, `132000`. */
	code: number;
	/** HTTP status to answer with; defaults to 400, the status Meta uses for almost everything. */
	httpStatus?: number;
	/** `error.error_subcode`, omitted when absent. */
	subcode?: number;
	/** `error.error_data.details`; its presence is what makes `error_data` appear. */
	details?: string;
	/** `error.type`; Meta answers `OAuthException` on the WhatsApp surfaces (SPEC §1.4). */
	type?: string;
	/**
	 * Response headers this failure carries — `Retry-After` and `X-Business-Use-Case-Usage` on a
	 * throttling error (SPEC §1.11). Header *names* are HTTP, but *which* headers a given Meta
	 * failure comes with is part of the failure, so they travel with the error and the Graph
	 * error handler is the only thing that turns them into a `Response`.
	 */
	headers?: Readonly<Record<string, string>>;
}

export const DEFAULT_ERROR_TYPE = "OAuthException";
export const DEFAULT_ERROR_HTTP_STATUS = 400;

export class GraphApiError extends Error {
	readonly code: number;
	readonly subcode: number | undefined;
	readonly httpStatus: number;
	readonly details: string | undefined;
	readonly type: string;
	readonly headers: Readonly<Record<string, string>> | undefined;

	/**
	 * `message` is the `error.message` string, already carrying the `(#<code>) ` prefix when
	 * Meta uses one. Meta is inconsistent about it — `132000` has it, `190` does not — so it is
	 * spelled out at the call site instead of being derived here.
	 */
	constructor(message: string, options: GraphApiErrorOptions) {
		super(message, options);

		this.name = "GraphApiError";
		this.code = options.code;
		this.subcode = options.subcode;
		this.httpStatus = options.httpStatus ?? DEFAULT_ERROR_HTTP_STATUS;
		this.details = options.details;
		this.type = options.type ?? DEFAULT_ERROR_TYPE;
		this.headers = options.headers;
	}
}

export function isGraphApiError(error: unknown): error is GraphApiError {
	return error instanceof GraphApiError;
}
