import { GraphApiError } from "./graph-api-error.ts";

/**
 * Every error envelope whaloc can emit, in one list (SPEC §1.4).
 *
 * Wording is copied from real Meta responses wherever a capture exists — those factories say
 * so in their doc comment. The rest is *modeled* on Meta's phrasing: the consumer only ever
 * branches on `code`/`error_subcode`, so the exact sentence is a developer-experience choice,
 * but keeping it plausible means logs from whaloc read like logs from production.
 */

/** Meta answers 400 for nearly everything; only these deviate. */
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** `error_subcode` for "the object you asked for is not there" (SPEC §1.4). */
export const OBJECT_MISSING_SUBCODE = 33;
/** `error_subcode` Meta attaches to `(#100) Invalid parameter` on the messaging surfaces. */
export const INVALID_PARAMETER_SUBCODE = 2_494_010;
/** `error_subcode` for a template that already exists under the same name and language. */
export const TEMPLATE_ALREADY_EXISTS_SUBCODE = 2_388_024;
/** `error_subcode` of an OAuth token whose session has expired (SPEC §1.9). */
export const EXPIRED_ACCESS_TOKEN_SUBCODE = 463;

/** Meta's code for "you are going too fast" on the messaging surface. */
export const RATE_LIMIT_CODE = 130_429;
/** The (business account, consumer) pair rate limit — a 400, unlike the other two. */
export const PAIR_RATE_LIMIT_CODE = 131_056;
/** The app-level request limit, which Meta reports without a `(#code)`-free message. */
export const APPLICATION_RATE_LIMIT_CODE = 4;
/** "Something broke on Meta's side"; the vendored v25.0 specs use code 1. */
export const UNKNOWN_ERROR_CODE = 1;

/**
 * Missing or empty `Authorization` on a Graph route (SPEC §1.9).
 *
 * In whaloc's default (permissive) mode this is the only authentication failure it can produce;
 * with `WHALOC_TOKENS` set, an unregistered token joins it — see {@link invalidAccessTokenError},
 * whose envelope is deliberately identical.
 */
export function missingAccessTokenError(): GraphApiError {
	return new GraphApiError("Invalid OAuth access token - Cannot parse access token", {
		code: 190,
		httpStatus: HTTP_UNAUTHORIZED,
	});
}

/**
 * A bearer token that is not in `WHALOC_TOKENS` (SPEC §1.9, strict mode).
 *
 * **The same envelope as a missing token, on purpose**: Meta does not tell a caller whether it
 * sent no token or the wrong one, and neither does whaloc. Two factories rather than one call
 * site because the two situations read differently in the code that raises them.
 */
export function invalidAccessTokenError(): GraphApiError {
	return new GraphApiError("Invalid OAuth access token - Cannot parse access token", {
		code: 190,
		httpStatus: HTTP_UNAUTHORIZED,
	});
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * `Tuesday, 01-Sep-26 12:00:00 UTC` — the shape Meta prints inside an expired-session message.
 *
 * Meta stamps it in Pacific time; whaloc says UTC, because a dev tool that reported a timezone
 * it is not running in would be a puzzle rather than a detail. Written by hand instead of
 * through `Intl` so the string cannot drift with the host's locale data.
 */
export function formatSessionTime(value: Date): string {
	const date = `${pad(value.getUTCDate())}-${MONTHS[value.getUTCMonth()]!}-${pad(value.getUTCFullYear() % 100)}`;
	const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;

	return `${WEEKDAYS[value.getUTCDay()]!}, ${date} ${time} UTC`;
}

/**
 * A registered token the control plane marked expired (SPEC §1.9). Code 190 with
 * **subcode 463**, which is what a consumer keys "re-authenticate" on.
 *
 * No `error_data`: Meta's expired-session envelope carries the explanation in `message` alone.
 */
export function expiredAccessTokenError(expiredAt: Date, now: Date): GraphApiError {
	return new GraphApiError(
		`Error validating access token: Session has expired on ${formatSessionTime(expiredAt)}. ` +
			`The current time is ${formatSessionTime(now)}.`,
		{ code: 190, subcode: EXPIRED_ACCESS_TOKEN_SUBCODE, httpStatus: HTTP_UNAUTHORIZED },
	);
}

/**
 * Cloud API throughput exhausted (SPEC §1.11). HTTP **429**, and the only whaloc envelope that
 * comes with headers: `Retry-After` and `X-Business-Use-Case-Usage`, both built by the caller
 * because their values are what an injection rule configures.
 */
export function rateLimitError(headers: Readonly<Record<string, string>>): GraphApiError {
	return new GraphApiError("(#130429) Rate limit hit", {
		code: RATE_LIMIT_CODE,
		httpStatus: HTTP_TOO_MANY_REQUESTS,
		details: "Cloud API message throughput has been reached.",
		headers,
	});
}

/**
 * The (business account, consumer) pair rate limit: too many messages to *one* recipient in a
 * short window. Meta answers this one with **400**, not 429, and without throttling headers.
 */
export function pairRateLimitError(): GraphApiError {
	return new GraphApiError("(#131056) (Business Account, Consumer account) pair rate limit hit", {
		code: PAIR_RATE_LIMIT_CODE,
		details:
			"Too many messages sent from this phone number to the same phone number in a short period of time. " +
			"Please retry after some delay.",
	});
}

/** The app-level request limit — Meta's spam-rate 429, carrying the same two headers as 130429. */
export function applicationRateLimitError(headers: Readonly<Record<string, string>>): GraphApiError {
	return new GraphApiError("(#4) Application request limit reached", {
		code: APPLICATION_RATE_LIMIT_CODE,
		httpStatus: HTTP_TOO_MANY_REQUESTS,
		headers,
	});
}

/** Meta's own side broke: HTTP 500, code 1, nothing else in the envelope. */
export function unknownServerError(): GraphApiError {
	return new GraphApiError("An unknown error occurred", {
		code: UNKNOWN_ERROR_CODE,
		httpStatus: HTTP_INTERNAL_SERVER_ERROR,
	});
}

/**
 * The id is not in any store. **HTTP 400, code 100, subcode 33 — never 404** (SPEC §1.4): the
 * consumer keys expired-media and deregistered-phone detection on exactly this envelope.
 * Message copied verbatim from Meta, id interpolated.
 */
export function unknownObjectError(id: string): GraphApiError {
	const message =
		`Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to ` +
		"missing permissions, or does not support this operation. Please read the Graph API " +
		"documentation at https://developers.facebook.com/docs/graph-api";

	return new GraphApiError(message, { code: 100, subcode: OBJECT_MISSING_SUBCODE });
}

/**
 * A request body or query string whaloc could not accept. Shape captured from Meta: the
 * message is always the same sentence and the specific complaint travels in
 * `error_data.details`.
 */
export function invalidParameterError(details: string, options: ErrorOptions = {}): GraphApiError {
	return new GraphApiError("(#100) Invalid parameter", {
		code: 100,
		subcode: INVALID_PARAMETER_SUBCODE,
		details,
		cause: options.cause,
	});
}

/**
 * A `template` send naming a template that is not there, not in that language, or not
 * `APPROVED` (SPEC §2). Message captured from Meta; `details` follows its `template name (x)
 * does not exist in <language>` phrasing.
 */
export function templateNotFoundError(details: string): GraphApiError {
	return new GraphApiError("(#132001) Template name does not exist in the translation", {
		code: 132_001,
		details,
	});
}

/**
 * The parameters of a `template` send do not line up with the template's placeholders.
 * Message and `details` are the captured sample in SPEC §1 ("Real captured samples").
 */
export function templateParameterMismatchError(details: string): GraphApiError {
	return new GraphApiError("(#132000) Number of parameters does not match the expected number of params", {
		code: 132_000,
		details,
	});
}

/** Creating a template whose name and language are already taken (SPEC §2.7). */
export function templateAlreadyExistsError(name: string, language: string): GraphApiError {
	return new GraphApiError(`(#100) Template name (${name}) and language (${language}) already exists`, {
		code: 100,
		subcode: TEMPLATE_ALREADY_EXISTS_SUBCODE,
	});
}

/**
 * Deleting a template that is not there. The only route that answers **404** (SPEC §2.10) —
 * the consumer treats that status as an idempotent success.
 */
export function templateNotDeletedError(name: string): GraphApiError {
	return new GraphApiError(`(#100) Message template name (${name}) does not exist`, {
		code: 100,
		httpStatus: HTTP_NOT_FOUND,
	});
}

/**
 * `phone_number` that is not E.164 digits (SPEC §2.13). Message copied verbatim from the 400
 * sample in `docs/meta-openapi/phone-number-management.yaml` — which, unlike the messaging
 * surfaces, carries no `(#100)` prefix and no subcode.
 */
export function invalidPhoneNumberError(): GraphApiError {
	return new GraphApiError("Invalid parameter: phone_number must be in E.164 format", { code: 100 });
}

/**
 * A number whose digits are already registered. whaloc compares across **every** WABA: one
 * MSISDN is one WhatsApp account, so a duplicate is a duplicate wherever it sits. Status, code
 * and type are the 409 sample from phone-number-management.yaml — `GraphMethodException`, one of
 * the two places Meta does not say `OAuthException`.
 */
export function phoneNumberAlreadyExistsError(): GraphApiError {
	return new GraphApiError("Phone number is already registered with WhatsApp Business", {
		code: 100,
		httpStatus: HTTP_CONFLICT,
		type: "GraphMethodException",
	});
}

/**
 * A send from a number that is not `CONNECTED` (SPEC §4). `133010` is the code the Cloud API
 * answers a deregistered number with, and what consumers key "this number is not usable" on.
 */
export function phoneNumberNotRegisteredError(displayPhoneNumber: string): GraphApiError {
	return new GraphApiError("(#133010) Phone number not registered", {
		code: 133_010,
		details:
			`The phone number ${displayPhoneNumber} is not registered on the WhatsApp Business Platform. ` +
			"Register it with POST /{phone-number-id}/register before sending messages.",
	});
}

/** `register` on a number whose verification code was never confirmed (SPEC §4). */
export function phoneNumberNotVerifiedError(): GraphApiError {
	return new GraphApiError("(#133006) Phone number re-verification needed", {
		code: 133_006,
		details:
			"Verify the phone number with POST /{phone-number-id}/request_code and " +
			"POST /{phone-number-id}/verify_code before registering it.",
	});
}

/**
 * A `POST /upload:<id>` whose `file_offset` is not where the session actually is (SPEC §2.21).
 *
 * Meta's Resumable Upload API answers a mismatched offset with a `(#100)`-style complaint rather
 * than resuming from somewhere else, and the truthful offset is the thing the caller needs, so it
 * travels in `details` — the same place `GET /upload:<id>` reports it.
 */
export function invalidUploadOffsetError(expected: number, received: number): GraphApiError {
	return invalidParameterError(
		`Param file_offset must be ${String(expected)}, the number of bytes this session has received; got ${String(
			received,
		)}`,
	);
}

/** More bytes than the session's `file_length` promised; the upload is refused rather than truncated. */
export function uploadTooLongError(fileLength: number, received: number): GraphApiError {
	return invalidParameterError(
		`This upload session was opened for ${String(fileLength)} bytes and has been sent ${String(received)}`,
	);
}

/** An upload above the cap (SPEC §2.6); Meta answers 400 with code 100, not 413. */
export function mediaTooLargeError(maxBytes: number): GraphApiError {
	const maxMebibytes = Math.floor(maxBytes / 1024 / 1024);

	return new GraphApiError(
		`(#100) Media file size too big. Max file size we currently support: ${String(maxMebibytes)}MB`,
		{
			code: 100,
		},
	);
}
