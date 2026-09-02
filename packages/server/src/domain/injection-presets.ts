import {
	DEFAULT_REGAIN_ACCESS_MINUTES,
	DEFAULT_RETRY_AFTER_SECONDS,
	type InjectionCustomResponse,
	type InjectionPreset,
} from "@whaloc/shared";
import { GraphApiError } from "./graph-api-error.ts";
import { applicationRateLimitError, pairRateLimitError, rateLimitError, unknownServerError } from "./meta-errors.ts";

/**
 * Turns an injection rule's preset into the failure whaloc answers with (SPEC §4).
 *
 * Nothing here touches HTTP: a preset produces a {@link GraphApiError}, headers included, and
 * the Graph surface's single `onError` writes it out as Meta's envelope like any other failure.
 */

/** `Retry-After`, in delta-seconds — the consumer also accepts an HTTP-date (SPEC §1.11). */
export const RETRY_AFTER_HEADER = "retry-after";
/** Meta's usage header. Its `estimated_time_to_regain_access` is in **minutes**, not seconds. */
export const BUSINESS_USE_CASE_USAGE_HEADER = "x-business-use-case-usage";

/**
 * The usage numbers whaloc reports alongside a throttle. `call_count`, `total_cputime` and
 * `total_time` are percentages of the app's quota, and a rate-limited app is at 100 of each —
 * which is the only combination consistent with the 429 that carries them.
 */
const EXHAUSTED_QUOTA_PERCENT = 100;

export interface ThrottleHeaderOptions {
	/** The business the usage header is keyed by; `undefined` when whaloc has no WABA at all. */
	wabaId: string | undefined;
	retryAfterSeconds: number;
	/** `estimated_time_to_regain_access`, in minutes. */
	regainAccessMinutes: number;
}

/**
 * The body of `X-Business-Use-Case-Usage`, keyed by business id, exactly as the consumer parses
 * it (SPEC §1.11):
 *
 * ```json
 * {"<waba-id>":[{"type":"whatsapp","call_count":100,"total_cputime":100,"total_time":100,
 *   "estimated_time_to_regain_access":15}]}
 * ```
 */
export function businessUseCaseUsage(wabaId: string, regainAccessMinutes: number): string {
	return JSON.stringify({
		[wabaId]: [
			{
				type: "whatsapp",
				call_count: EXHAUSTED_QUOTA_PERCENT,
				total_cputime: EXHAUSTED_QUOTA_PERCENT,
				total_time: EXHAUSTED_QUOTA_PERCENT,
				estimated_time_to_regain_access: regainAccessMinutes,
			},
		],
	});
}

/**
 * The two headers a throttled response carries. `X-Business-Use-Case-Usage` is keyed by a
 * business id, so it is left off entirely when whaloc has no WABA — an empty object there would
 * be a header the consumer parses into nothing.
 */
export function throttleHeaders(options: ThrottleHeaderOptions): Record<string, string> {
	return {
		[RETRY_AFTER_HEADER]: String(options.retryAfterSeconds),
		...(options.wabaId !== undefined && {
			[BUSINESS_USE_CASE_USAGE_HEADER]: businessUseCaseUsage(options.wabaId, options.regainAccessMinutes),
		}),
	};
}

export interface InjectionResponseOptions {
	preset: InjectionPreset;
	/** From the rule; the preset default applies when it was left out. */
	retryAfterSeconds?: number | null;
	regainAccessMinutes?: number | null;
	custom?: InjectionCustomResponse | null;
	/** Keys the usage header; the first WABA whaloc knows about. */
	wabaId?: string | undefined;
}

/** The `custom` preset: the caller wrote the envelope, so it is copied out field by field. */
function customError(custom: InjectionCustomResponse): GraphApiError {
	return new GraphApiError(custom.message, {
		code: custom.code,
		httpStatus: custom.httpStatus,
		...(custom.subcode !== undefined && { subcode: custom.subcode }),
		...(custom.details !== undefined && { details: custom.details }),
		...(custom.type !== undefined && { type: custom.type }),
	});
}

/**
 * Builds the failure one rule answers with. A `custom` rule always carries its envelope — the
 * schema refuses the combination where it does not — so the fallback only exists to keep this
 * total.
 */
export function injectionResponse(options: InjectionResponseOptions): GraphApiError {
	const headers = (): Record<string, string> => {
		return throttleHeaders({
			wabaId: options.wabaId,
			retryAfterSeconds: options.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
			regainAccessMinutes: options.regainAccessMinutes ?? DEFAULT_REGAIN_ACCESS_MINUTES,
		});
	};

	switch (options.preset) {
		case "rate_limit_429": {
			return rateLimitError(headers());
		}

		case "throughput_131056": {
			return pairRateLimitError();
		}

		case "spam_rate_4": {
			return applicationRateLimitError(headers());
		}

		case "server_error_500": {
			return unknownServerError();
		}

		case "custom": {
			const custom = options.custom ?? null;

			return custom === null ? unknownServerError() : customError(custom);
		}
	}
}
