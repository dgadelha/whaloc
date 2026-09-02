import type { WsEvent, WsEventOf } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRecord } from "../db/index.ts";
import { TYPING_INDICATOR_TTL_MS, TypingService } from "./typing-service.ts";

/**
 * Typing indicators on fake timers (SPEC §2.18).
 *
 * The service is pure in-memory state plus one scheduled dismissal, so these tests are the
 * whole contract: it goes up, it comes down after Meta's 25-second window, it comes down early
 * when the business sends something, and every edge is announced exactly once.
 */
const PHONE_NUMBER_ID = "106540352242922";
const CONTACT_WA_ID = "16505551234";
const CONVERSATION_ID = `${PHONE_NUMBER_ID}:${CONTACT_WA_ID}`;

describe("TypingService", () => {
	let events: WsEvent[];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
		events = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createService(): TypingService {
		return new TypingService({
			events: {
				publish: event => {
					events.push(event);
				},
			},
		});
	}

	function typingEvents(): WsEventOf<"typing.changed">["payload"]["typing"][] {
		return events
			.filter((event): event is WsEventOf<"typing.changed"> => event.type === "typing.changed")
			.map(event => event.payload.typing);
	}

	function outboundMessage(contactWaId = CONTACT_WA_ID): MessageRecord {
		return {
			id: "wamid.OUT",
			direction: "outbound",
			phoneNumberId: PHONE_NUMBER_ID,
			contactWaId,
			type: "text",
			payload: { text: { body: "Hi" } },
			status: "accepted",
			error: null,
			bizOpaqueCallbackData: null,
			replyTo: null,
			timestamp: "2026-09-01T12:00:00.000Z",
			createdAt: "2026-09-01T12:00:00.000Z",
			updatedAt: "2026-09-01T12:00:00.000Z",
		};
	}

	it("raises an indicator that expires 25 seconds out, and announces it", () => {
		const service = createService();
		const indicator = service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);

		expect(indicator).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			contactWaId: CONTACT_WA_ID,
			expiresAt: "2026-09-01T12:00:25.000Z",
		});
		expect(TYPING_INDICATOR_TTL_MS).toBe(25_000);
		expect(service.list()).toEqual([indicator]);
		expect(typingEvents()).toEqual([indicator]);
	});

	it("dismisses it after Meta's window, exactly once", async () => {
		const service = createService();

		service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);

		await vi.advanceTimersByTimeAsync(TYPING_INDICATOR_TTL_MS - 1);
		expect(service.list()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);

		expect(service.list()).toEqual([]);
		expect(service.activeCount).toBe(0);
		expect(typingEvents().at(-1)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			contactWaId: CONTACT_WA_ID,
			expiresAt: null,
		});
		expect(typingEvents()).toHaveLength(2);
	});

	it("pushes the dismissal back when the app says it is still typing", async () => {
		const service = createService();

		service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);
		await vi.advanceTimersByTimeAsync(20_000);

		const refreshed = service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);

		expect(refreshed.expiresAt).toBe("2026-09-01T12:00:45.000Z");

		// The first timer must not take the refreshed indicator down with it.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(service.list()).toEqual([refreshed]);

		await vi.advanceTimersByTimeAsync(15_000);
		expect(service.list()).toEqual([]);
	});

	it("comes down when the conversation's next outbound message is accepted", () => {
		const service = createService();

		service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);
		service.onOutboundAccepted(outboundMessage());

		expect(service.list()).toEqual([]);
		expect(typingEvents().at(-1)?.expiresAt).toBeNull();
	});

	it("leaves other conversations alone", () => {
		const service = createService();

		service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);
		service.onOutboundAccepted(outboundMessage("5571990000002"));

		expect(service.list().map(indicator => `${indicator.phoneNumberId}:${indicator.contactWaId}`)).toEqual([
			CONVERSATION_ID,
		]);
	});

	it("says nothing when there was nothing to clear", () => {
		const service = createService();

		service.clear(PHONE_NUMBER_ID, CONTACT_WA_ID);

		expect(typingEvents()).toEqual([]);
	});

	it("narrows the listing to one phone number", () => {
		const service = createService();

		service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);
		service.start("999999999999999", CONTACT_WA_ID);

		expect(service.list(PHONE_NUMBER_ID)).toHaveLength(1);
		expect(service.list()).toHaveLength(2);
	});

	it("hides an indicator whose window has passed even if its timer never ran", () => {
		const service = createService();

		service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);
		// The clock moves without the timers firing — which is what a paused test run, or a
		// scheduler whose `now` a spec drives by hand, looks like.
		vi.setSystemTime(new Date("2026-09-01T12:01:00.000Z"));

		expect(service.list()).toEqual([]);
	});

	it("drops everything without announcing, for a reset", () => {
		const service = createService();

		service.start(PHONE_NUMBER_ID, CONTACT_WA_ID);
		events.length = 0;
		service.clearAll();

		expect(service.activeCount).toBe(0);
		expect(typingEvents()).toEqual([]);
	});
});
