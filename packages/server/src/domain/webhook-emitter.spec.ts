import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsEvent } from "@whaloc/shared";
import { startCaptureServer, type CaptureServer } from "../testing/capture-server.ts";
import { createDomainHarness, createRecordingScheduler, type DomainHarness } from "../testing/domain-harness.ts";
import type { EventPublisher } from "./event-bus.ts";
import { isValidMetaSignature, SIGNATURE_HEADER } from "./meta-json.ts";
import { DEFAULT_RETRY_DELAYS_MS, SKIPPED_DELIVERY_ERROR, WebhookEmitter } from "./webhook-emitter.ts";
import { webhookEnvelope, WEBHOOK_FIELDS } from "./webhook-payloads.ts";

/**
 * The webhook engine against a real HTTP server (SPEC §3).
 *
 * Nothing is stubbed but the clock: the emitter's own `fetch` reaches a throwaway server that
 * keeps the raw bytes it received, which is what makes the signature assertions meaningful —
 * they compare the HMAC against the body that actually arrived.
 */
const APP_SECRET = "dev-meta-app-secret";
const VERIFY_TOKEN = "dev-verify-token";

describe("WebhookEmitter", () => {
	let harness: DomainHarness;
	let capture: CaptureServer;

	beforeEach(async () => {
		harness = await createDomainHarness();
		capture = await startCaptureServer();
	});

	afterEach(async () => {
		await capture.close();
		await harness.close();
	});

	function createEmitter(
		overrides: {
			url?: string | undefined;
			appSecret?: string | undefined;
			verifyToken?: string | undefined;
			events?: EventPublisher;
		} = {},
	) {
		const scheduler = createRecordingScheduler();
		const emitter = new WebhookEmitter({
			repositories: harness.repositories,
			logger: harness.logger,
			target: {
				url: "url" in overrides ? overrides.url : capture.url,
				appSecret: "appSecret" in overrides ? overrides.appSecret : APP_SECRET,
				verifyToken: "verifyToken" in overrides ? overrides.verifyToken : VERIFY_TOKEN,
			},
			scheduler,
			...(overrides.events !== undefined && { events: overrides.events }),
		});

		return { emitter, scheduler };
	}

	function envelopeWith(value: Record<string, unknown>) {
		return webhookEnvelope({ wabaId: harness.wabaId, field: WEBHOOK_FIELDS.messages, value });
	}

	describe("delivery", () => {
		it("POSTs the payload with Meta's headers", async () => {
			const { emitter } = createEmitter();

			await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			const request = capture.requests[0]!;

			expect(request.method).toBe("POST");
			expect(request.headers["content-type"]).toBe("application/json");
			expect(request.headers["user-agent"]).toBe("facebookexternalua");
			expect(JSON.parse(request.body)).toMatchObject({ object: "whatsapp_business_account" });
		});

		it("signs exactly the bytes it sends, multibyte payloads included", async () => {
			const { emitter } = createEmitter();

			await emitter.emit(
				WEBHOOK_FIELDS.messages,
				envelopeWith({ messages: [{ text: { body: "Olá! 🍕 日本語 — ñ ü" } }] }),
			);

			const request = capture.requests[0]!;
			const signature = request.headers[SIGNATURE_HEADER]!;

			// The body that arrived is pure ASCII (everything above U+007F was escaped), so its
			// byte count and its character count agree — and the HMAC is over those same bytes.
			expect(request.rawBody.byteLength).toBe(request.body.length);
			// The emoji went out as its two escaped surrogate halves, never as raw UTF-8.
			expect(request.body).toMatch(/\\u[\da-f]{4}/);
			expect(request.body).not.toContain("🍕");
			expect(signature).toMatch(/^sha256=[\da-f]{64}$/);
			expect(isValidMetaSignature(signature, APP_SECRET, request.body)).toBe(true);
			expect(isValidMetaSignature(signature, APP_SECRET, request.rawBody.toString("utf8"))).toBe(true);
		});

		it("leaves the signature off when no app secret is configured", async () => {
			const { emitter } = createEmitter({ appSecret: undefined });

			await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(capture.requests[0]!.headers[SIGNATURE_HEADER]).toBeUndefined();
		});

		it("persists an attempt row with the request and the response", async () => {
			capture.respondWith(() => ({ status: 202, body: "EVENT_RECEIVED" }));

			const { emitter } = createEmitter();
			const [record] = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(record).toMatchObject({
				eventType: WEBHOOK_FIELDS.messages,
				url: capture.url,
				responseStatus: 202,
				responseBody: "EVENT_RECEIVED",
				error: null,
				attempt: 1,
			});
			expect(record!.requestBody).toBe(capture.requests[0]!.body);
			expect(record!.requestHeaders[SIGNATURE_HEADER]).toBe(capture.requests[0]!.headers[SIGNATURE_HEADER]);
			expect(record!.durationMs).toBeGreaterThanOrEqual(0);
			expect(await harness.repositories.webhookDeliveries.list()).toHaveLength(1);
		});

		it("announces every attempt on the event bus", async () => {
			const events: WsEvent[] = [];
			const { emitter } = createEmitter({
				events: {
					publish: event => {
						events.push(event);
					},
				},
			});

			await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(events).toHaveLength(1);
			expect(events[0]!.type).toBe("webhook.delivery");
		});
	});

	describe("retries", () => {
		it("retries a 5xx on the documented backoff and stops once it succeeds", async () => {
			capture.respondWith((_request, attempt) =>
				attempt < 3 ? { status: 500, body: "boom" } : { status: 200, body: "ok" },
			);

			const { emitter, scheduler } = createEmitter();
			const records = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(capture.requests).toHaveLength(3);
			expect(records.map(record => record.attempt)).toEqual([1, 2, 3]);
			expect(records.map(record => record.responseStatus)).toEqual([500, 500, 200]);
			// The first attempt is immediate; the retries wait 2 s and 10 s (SPEC §3).
			expect(scheduler.sleeps).toEqual([...DEFAULT_RETRY_DELAYS_MS].slice(1));
		});

		it("gives up after three attempts", async () => {
			capture.respondWith(() => ({ status: 503, body: "unavailable" }));

			const { emitter } = createEmitter();
			const records = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(records).toHaveLength(DEFAULT_RETRY_DELAYS_MS.length);
			expect(capture.requests).toHaveLength(DEFAULT_RETRY_DELAYS_MS.length);
		});

		it("does not retry a 4xx: that is the receiver's answer, not a hiccup", async () => {
			capture.respondWith(() => ({ status: 403, body: "forbidden" }));

			const { emitter, scheduler } = createEmitter();
			const records = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(records).toHaveLength(1);
			expect(capture.requests).toHaveLength(1);
			expect(scheduler.sleeps).toEqual([]);
		});

		it("retries a network error and logs it on the row", async () => {
			await capture.close();

			const { emitter } = createEmitter();
			const records = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(records).toHaveLength(DEFAULT_RETRY_DELAYS_MS.length);
			expect(records[0]).toMatchObject({ responseStatus: null });
			expect(records[0]!.error).toEqual(expect.any(String));

			capture = await startCaptureServer();
		});
	});

	describe("without a webhook URL", () => {
		it("skips the delivery but still logs what it would have sent", async () => {
			const { emitter } = createEmitter({ url: undefined });
			const [record] = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(emitter.isConfigured).toBe(false);
			expect(record).toMatchObject({ url: "", responseStatus: null, error: SKIPPED_DELIVERY_ERROR, attempt: 1 });
			// The payload is the real one — and it is signed, so the UI can show what a
			// receiver would have had to verify.
			expect(JSON.parse(record!.requestBody)).toMatchObject({ object: "whatsapp_business_account" });
			expect(record!.requestHeaders[SIGNATURE_HEADER]).toMatch(/^sha256=/);
			expect(capture.requests).toHaveLength(0);
		});
	});

	describe("redeliver", () => {
		it("replays the stored body as new attempt rows", async () => {
			const { emitter } = createEmitter();
			const [original] = await emitter.emit(
				WEBHOOK_FIELDS.messages,
				envelopeWith({ messages: [{ text: { body: "olá" } }] }),
			);

			const replayed = await emitter.redeliver(original!.id);

			expect(replayed).toHaveLength(1);
			expect(replayed![0]!.id).not.toBe(original!.id);
			expect(replayed![0]!.requestBody).toBe(original!.requestBody);
			expect(capture.requests).toHaveLength(2);
			expect(capture.requests[1]!.body).toBe(capture.requests[0]!.body);
		});

		it("signs the replay again, so a body captured while unsigned goes out signed", async () => {
			const unsigned = createEmitter({ appSecret: undefined });
			const [original] = await unsigned.emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ a: "b" }));
			const signed = createEmitter();

			await signed.emitter.redeliver(original!.id);

			const replay = capture.requests.at(-1)!;

			expect(isValidMetaSignature(replay.headers[SIGNATURE_HEADER]!, APP_SECRET, replay.body)).toBe(true);
		});

		it("reports an unknown delivery id", async () => {
			const { emitter } = createEmitter();

			expect(await emitter.redeliver("nope")).toBeNull();
		});
	});

	describe("handshake", () => {
		it("echoes the challenge back", async () => {
			capture.respondWith(request => ({ status: 200, body: request.query.get("hub.challenge") ?? "" }));

			const { emitter } = createEmitter();
			const result = await emitter.handshake();

			expect(result.ok).toBe(true);
			expect(result.status).toBe(200);
			expect(result.echo).toBe(result.challenge);
			expect(emitter.lastHandshake).toEqual(result);

			const request = capture.requests[0]!;

			expect(request.method).toBe("GET");
			expect(request.query.get("hub.mode")).toBe("subscribe");
			expect(request.query.get("hub.verify_token")).toBe(VERIFY_TOKEN);
			expect(request.query.get("hub.challenge")).toBe(result.challenge);
		});

		it("fails when the receiver echoes something else", async () => {
			capture.respondWith(() => ({ status: 200, body: "not-the-challenge" }));

			const { emitter } = createEmitter();
			const result = await emitter.handshake();

			expect(result).toMatchObject({ ok: false, status: 200, echo: "not-the-challenge" });
			expect(result.error).toBe("the receiver did not echo the challenge");
		});

		it("fails on a 403, the way a wrong verify token answers", async () => {
			capture.respondWith(() => ({ status: 403, body: "" }));

			const { emitter } = createEmitter();

			expect(await emitter.handshake()).toMatchObject({ ok: false, status: 403 });
		});

		it("fails without ever leaving the process when nothing is configured", async () => {
			const { emitter } = createEmitter({ url: undefined });

			expect(await emitter.handshake()).toMatchObject({ ok: false, error: "WHALOC_WEBHOOK_URL is not set" });

			const { emitter: tokenless } = createEmitter({ verifyToken: undefined });

			expect(await tokenless.handshake()).toMatchObject({
				ok: false,
				error: "WHALOC_WEBHOOK_VERIFY_TOKEN is not set",
			});
			expect(capture.requests).toHaveLength(0);
		});

		it("reports a receiver that is not up", async () => {
			await capture.close();

			const { emitter } = createEmitter();
			const result = await emitter.handshake();

			expect(result.ok).toBe(false);
			expect(result.status).toBeNull();
			expect(result.error).toEqual(expect.any(String));

			capture = await startCaptureServer();
		});
	});

	describe("emit", () => {
		it("never rejects, whatever the receiver does", async () => {
			const { emitter } = createEmitter();
			const failing = vi.fn().mockRejectedValue(new Error("boom"));
			const broken = new WebhookEmitter({
				repositories: harness.repositories,
				logger: harness.logger,
				target: { url: capture.url },
				scheduler: createRecordingScheduler(),
				fetch: failing,
				retryDelaysMs: [0],
			});

			await expect(broken.emit("raw", { a: 1 })).resolves.toHaveLength(1);
			await expect(emitter.emitRaw({ a: 1 })).resolves.toHaveLength(1);
			expect(capture.requests.at(-1)!.body).toBe('{"a":1}');
		});

		it("lists deliveries newest first", async () => {
			const { emitter } = createEmitter();

			await emitter.emitRaw({ first: true });
			await emitter.emitRaw({ second: true });

			const deliveries = await emitter.listDeliveries({ limit: 10 });

			expect(deliveries).toHaveLength(2);
			expect(JSON.parse(deliveries[0]!.requestBody)).toEqual({ second: true });
		});
	});
});
