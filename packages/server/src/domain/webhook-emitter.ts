import type { HandshakeResult } from "@whaloc/shared";
import type { JsonObject, Repositories, WebhookDeliveryHeaders, WebhookDeliveryRecord } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import { toWebhookDeliveryDto } from "./control-dto.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createWebhookChallenge, createWebhookDeliveryId, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { metaSignatureHeader, serializeMetaJson, SIGNATURE_HEADER } from "./meta-json.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";

/**
 * The one service that talks to the app under test (SPEC §3).
 *
 * Three things make it worth its own class:
 *
 * - **The body is produced once.** `serializeMetaJson` runs, and that exact string is what is
 *   signed and what is sent (SPEC §1.12). Re-encoding anywhere in between would break every
 *   receiver that verifies the signature.
 * - **Every attempt is logged**, including retries and including the attempts that never
 *   happened because no webhook URL is configured. The delivery log is a first-class feature:
 *   pointing whaloc at nothing and still seeing what it would have sent is how the UI is
 *   useful before an integration exists.
 * - **Retries are deterministic**: 3 attempts at 0 s / 2 s / 10 s, only on a 5xx or a network
 *   error. A 2xx is a success and a 4xx is the receiver's answer, not a hiccup — Meta itself
 *   retries far longer, but a dev tool that hammers a broken endpoint for hours is noise.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The webhook half of `AppConfig` (SPEC §7), narrowed to what the emitter reads. */
export interface WebhookTarget {
	url?: string | undefined;
	appSecret?: string | undefined;
	verifyToken?: string | undefined;
}

export interface WebhookEmitterOptions {
	repositories: Repositories;
	logger: Logger;
	target: WebhookTarget;
	events?: EventPublisher;
	scheduler?: Scheduler;
	/** Injected in tests; defaults to the global `fetch`. */
	fetch?: FetchLike;
	random?: RandomBytes;
	/** One entry per attempt, the delay *before* it. Defaults to 0 s / 2 s / 10 s. */
	retryDelaysMs?: readonly number[];
	requestTimeoutMs?: number;
}

/** SPEC §3: three attempts, spaced 0 s / 2 s / 10 s. */
export const DEFAULT_RETRY_DELAYS_MS = [0, 2000, 10_000] as const;

/** Response bodies are logged for debugging, not archived — 64 KiB is plenty. */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

/** Same ceiling for what a receiver echoes back during the handshake. */
const MAX_ECHO_LENGTH = 1024;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The `url` a skipped delivery is stored with; `toWebhookDeliveryDto` reads it as `skipped`. */
export const SKIPPED_DELIVERY_URL = "";

export const SKIPPED_DELIVERY_ERROR = "WHALOC_WEBHOOK_URL is not set: nothing was sent, the payload is logged only";

/** Event type of a `POST /api/webhook/raw` escape-hatch delivery (SPEC §5). */
export const RAW_EVENT_TYPE = "raw";

const USER_AGENT = "facebookexternalua";

function truncate(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * The response body, capped and never fatal: a receiver that answers with a broken stream has
 * still answered, and the status is the part that decides whether to retry.
 */
async function readBody(response: Response, max: number): Promise<string> {
	try {
		return truncate(await response.text(), max);
	} catch {
		return "";
	}
}

/** What lands in `webhook_deliveries.error`: readable, no stack, cause included. */
function describeError(error: unknown): string {
	if (Error.isError(error)) {
		const cause = Error.isError(error.cause) ? ` (${error.cause.message})` : "";

		return `${error.name}: ${error.message}${cause}`;
	}

	return String(error);
}

export class WebhookEmitter {
	readonly #repositories: Repositories;
	readonly #logger: Logger;
	readonly #target: WebhookTarget;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #fetch: FetchLike;
	readonly #random: RandomBytes;
	readonly #retryDelaysMs: readonly number[];
	readonly #requestTimeoutMs: number;
	#lastHandshake: HandshakeResult | null = null;

	constructor(options: WebhookEmitterOptions) {
		this.#repositories = options.repositories;
		this.#logger = options.logger;
		this.#target = options.target;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#random = options.random ?? defaultRandomBytes;
		this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	#headers(body: string): WebhookDeliveryHeaders {
		return {
			"content-type": "application/json",
			// Meta's own user agent; receivers log it and some check it.
			"user-agent": USER_AGENT,
			...(this.#target.appSecret !== undefined && {
				[SIGNATURE_HEADER]: metaSignatureHeader(this.#target.appSecret, body),
			}),
		};
	}

	async #record(input: {
		eventType: string;
		url: string;
		body: string;
		headers: WebhookDeliveryHeaders;
		attempt: number;
		responseStatus?: number | null;
		responseBody?: string | null;
		error?: string | null;
		durationMs?: number | null;
	}): Promise<WebhookDeliveryRecord> {
		const record = await this.#repositories.webhookDeliveries.insert({
			id: createWebhookDeliveryId(this.#random),
			eventType: input.eventType,
			url: input.url,
			requestBody: input.body,
			requestHeaders: input.headers,
			responseStatus: input.responseStatus ?? null,
			responseBody: input.responseBody ?? null,
			error: input.error ?? null,
			attempt: input.attempt,
			durationMs: input.durationMs ?? null,
			createdAt: this.#scheduler.now().toISOString(),
		});

		this.#events.publish({ type: "webhook.delivery", payload: { delivery: toWebhookDeliveryDto(record) } });

		return record;
	}

	/**
	 * One POST. Never throws: a network failure is an outcome, and the caller decides whether
	 * it is worth another attempt.
	 */
	async #attempt(
		url: string,
		body: string,
		headers: WebhookDeliveryHeaders,
	): Promise<{ status: number | null; responseBody: string | null; error: string | null; durationMs: number }> {
		const startedAt = Date.now();

		try {
			const response = await this.#fetch(url, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(this.#requestTimeoutMs),
			});
			return {
				status: response.status,
				responseBody: await readBody(response, MAX_RESPONSE_BODY_BYTES),
				error: null,
				durationMs: Date.now() - startedAt,
			};
		} catch (error) {
			return { status: null, responseBody: null, error: describeError(error), durationMs: Date.now() - startedAt };
		}
	}

	/**
	 * Sends an already-serialized body, retrying while the failure looks transient. Returns
	 * one record per attempt, oldest first.
	 */
	async #deliver(eventType: string, body: string): Promise<WebhookDeliveryRecord[]> {
		const url = this.#target.url;
		const headers = this.#headers(body);

		if (url === undefined) {
			// Deliveries are still logged so the UI shows what the app under test would have
			// received (SPEC §3) — the payload is exactly the one that would have gone out.
			this.#logger.debug({ eventType }, "webhook delivery skipped, no WHALOC_WEBHOOK_URL configured");

			return [
				await this.#record({
					eventType,
					url: SKIPPED_DELIVERY_URL,
					body,
					headers,
					attempt: 1,
					error: SKIPPED_DELIVERY_ERROR,
				}),
			];
		}

		const records: WebhookDeliveryRecord[] = [];

		for (const [index, delayMs] of this.#retryDelaysMs.entries()) {
			if (delayMs > 0) {
				await this.#scheduler.sleep(delayMs);
			}

			const outcome = await this.#attempt(url, body, headers);
			const attempt = index + 1;

			records.push(
				await this.#record({
					eventType,
					url,
					body,
					headers,
					attempt,
					responseStatus: outcome.status,
					responseBody: outcome.responseBody,
					error: outcome.error,
					durationMs: outcome.durationMs,
				}),
			);

			const isRetryable = outcome.status === null || outcome.status >= 500;

			if (!isRetryable) {
				this.#logger.debug({ eventType, url, status: outcome.status, attempt }, "webhook delivered");

				return records;
			}

			this.#logger.warn(
				{ eventType, url, status: outcome.status, err: outcome.error, attempt },
				"webhook delivery attempt failed",
			);
		}

		return records;
	}

	#handshakeFailure(url: string, challenge: string, error: string): HandshakeResult {
		const result: HandshakeResult = {
			ok: false,
			url,
			status: null,
			challenge,
			echo: null,
			error,
			at: this.#scheduler.now().toISOString(),
		};

		this.#lastHandshake = result;

		return result;
	}

	/** The round trip itself: `hub.mode=subscribe` in, the challenge echoed back out. */
	async #verify(url: string, verifyToken: string, challenge: string): Promise<HandshakeResult> {
		const target = new URL(url);

		target.searchParams.set("hub.mode", "subscribe");
		target.searchParams.set("hub.verify_token", verifyToken);
		target.searchParams.set("hub.challenge", challenge);

		const response = await this.#fetch(target.href, {
			method: "GET",
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(this.#requestTimeoutMs),
		});
		const echo = await readBody(response, MAX_ECHO_LENGTH);
		const isEchoed = response.ok && echo === challenge;

		return {
			ok: isEchoed,
			url,
			status: response.status,
			challenge,
			echo,
			error: isEchoed ? null : "the receiver did not echo the challenge",
			at: this.#scheduler.now().toISOString(),
		};
	}

	get isConfigured(): boolean {
		return this.#target.url !== undefined;
	}

	/** Result of the most recent handshake, served by `GET /api/state` (SPEC §5). */
	get lastHandshake(): HandshakeResult | null {
		return this.#lastHandshake;
	}

	/**
	 * Serializes, signs and delivers a webhook envelope. Fire-and-forget by design: callers
	 * announce an event and move on, so a send response is never held up by a slow receiver.
	 * Never rejects — a failure is a logged delivery row.
	 */
	async emit(eventType: string, envelope: JsonObject): Promise<WebhookDeliveryRecord[]> {
		try {
			return await this.#deliver(eventType, serializeMetaJson(envelope));
		} catch (error) {
			this.#logger.error({ err: error, eventType }, "webhook emission failed");

			return [];
		}
	}

	/** `POST /api/webhook/raw` — any JSON object, signed and logged like a real event. */
	async emitRaw(payload: JsonObject): Promise<WebhookDeliveryRecord[]> {
		return this.emit(RAW_EVENT_TYPE, payload);
	}

	/**
	 * Re-sends a stored delivery's body as new attempt rows (SPEC §5). The body is replayed
	 * byte for byte and **re-signed**, so a delivery captured before `WHALOC_APP_SECRET` was
	 * set goes out signed the second time.
	 */
	async redeliver(deliveryId: string): Promise<WebhookDeliveryRecord[] | null> {
		const delivery = await this.#repositories.webhookDeliveries.findById(deliveryId);

		if (delivery === null) {
			return null;
		}

		return this.#deliver(delivery.eventType, delivery.requestBody);
	}

	async listDeliveries(query: { limit?: number; before?: string } = {}): Promise<WebhookDeliveryRecord[]> {
		return this.#repositories.webhookDeliveries.list(query);
	}

	/**
	 * The `hub.challenge` handshake, initiated by whaloc (SPEC §1.13): `GET <webhookUrl>` with
	 * `hub.mode=subscribe`, the configured verify token and a random challenge, which the
	 * receiver must echo back verbatim. Run on demand from the control plane, and at boot when
	 * `WHALOC_VERIFY_ON_START` is set.
	 */
	async handshake(): Promise<HandshakeResult> {
		const challenge = createWebhookChallenge(this.#random);
		const url = this.#target.url;

		if (url === undefined) {
			return this.#handshakeFailure("", challenge, "WHALOC_WEBHOOK_URL is not set");
		}

		if (this.#target.verifyToken === undefined) {
			return this.#handshakeFailure(url, challenge, "WHALOC_WEBHOOK_VERIFY_TOKEN is not set");
		}

		let result: HandshakeResult;

		try {
			result = await this.#verify(url, this.#target.verifyToken, challenge);
		} catch (error) {
			this.#logger.warn({ url, err: error }, "webhook handshake failed");

			return this.#handshakeFailure(url, challenge, describeError(error));
		}

		this.#lastHandshake = result;

		if (result.ok) {
			this.#logger.info({ url }, "webhook handshake succeeded");
		} else {
			this.#logger.warn({ url, status: result.status }, "webhook handshake failed");
		}

		return result;
	}
}
