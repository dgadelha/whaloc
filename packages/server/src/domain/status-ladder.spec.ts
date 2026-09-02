import type { WsEvent } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusDelays } from "../config/index.ts";
import type { MessageRecord } from "../db/index.ts";
import { createDomainHarness, type DomainHarness } from "../testing/domain-harness.ts";
import { anyString } from "../testing/expectations.ts";
import { StatusLadder } from "./status-ladder.ts";
import { WebhookEmitter } from "./webhook-emitter.ts";

/**
 * The status ladder on fake timers (SPEC §4).
 *
 * The emitter under it is the real one, configured with no webhook URL: deliveries are then
 * skipped but still logged, so the delivery table doubles as the record of what would have
 * gone out — payload included. That keeps these tests about *timing and state* while still
 * asserting on the actual webhook bodies.
 */
const DEFAULT_DELAYS: StatusDelays = { sent: 0, delivered: 800, read: null };

describe("StatusLadder", () => {
	let harness: DomainHarness;
	let events: WsEvent[];

	beforeEach(async () => {
		vi.useFakeTimers();
		harness = await createDomainHarness();
		events = [];
	});

	afterEach(async () => {
		vi.useRealTimers();
		await harness.close();
	});

	function createLadder(delays: StatusDelays = DEFAULT_DELAYS): StatusLadder {
		const publish = (event: WsEvent): void => {
			events.push(event);
		};
		const webhooks = new WebhookEmitter({
			repositories: harness.repositories,
			logger: harness.logger,
			target: {},
			events: { publish },
		});

		return new StatusLadder({
			repositories: harness.repositories,
			webhooks,
			tasks: harness.tasks,
			logger: harness.logger,
			delays,
			events: { publish },
		});
	}

	async function insertOutbound(
		type: "text" | "template" = "text",
		extra: { bizOpaqueCallbackData?: string } = {},
	): Promise<MessageRecord> {
		return harness.repositories.messages.insert({
			id: `wamid.${type}.${String(Math.random()).slice(2)}`,
			direction: "outbound",
			phoneNumberId: harness.phoneNumberId,
			contactWaId: harness.contactWaId,
			type,
			payload:
				type === "template"
					? { template: { name: "order_update", language: { code: "en_US" } } }
					: { text: { body: "Hi" } },
			status: "accepted",
			...extra,
		});
	}

	/** Advances the clock, then lets the work those timers started settle. */
	async function tick(ms: number): Promise<void> {
		await vi.advanceTimersByTimeAsync(ms);
		await harness.tasks.whenIdle();
	}

	async function emittedStatusNames(): Promise<string[]> {
		const emitted = await emittedStatuses();

		return emitted.map(entry => entry.status);
	}

	async function statusOf(messageId: string): Promise<string | undefined> {
		const message = await harness.repositories.messages.findById(messageId);

		return message?.status;
	}

	/** Every status webhook logged so far, in order. */
	async function emittedStatuses(): Promise<{ status: string; value: Record<string, unknown> }[]> {
		const deliveries = await harness.repositories.webhookDeliveries.list({ limit: 100 });

		return deliveries.toReversed().map(delivery => {
			const body = JSON.parse(delivery.requestBody) as {
				entry: [{ changes: [{ value: { statuses: [Record<string, unknown>] } }] }];
			};
			const [statusNode] = body.entry[0].changes[0].value.statuses;

			return { status: String(statusNode["status"]), value: statusNode };
		});
	}

	it("climbs to sent, then to delivered, and stops there by default", async () => {
		const ladder = createLadder();
		const message = await insertOutbound();

		ladder.onOutboundAccepted(message);
		expect(await statusOf(message.id)).toBe("accepted");

		await tick(0);
		expect(await statusOf(message.id)).toBe("sent");

		await tick(799);
		expect(await statusOf(message.id)).toBe("sent");

		await tick(1);
		expect(await statusOf(message.id)).toBe("delivered");

		// `read` is manual unless configured (SPEC §4), so nothing more happens.
		await tick(60_000);
		expect(await statusOf(message.id)).toBe("delivered");
		expect(await emittedStatusNames()).toEqual(["sent", "delivered"]);
		expect(ladder.pendingCount).toBe(0);
	});

	/**
	 * The recipient's BSUID (SPEC §1.15). A status is the only place a consumer learns which
	 * business-scoped id a message went to, so it rides along on every rung.
	 */
	it("reports recipient_user_id when the recipient has a BSUID", async () => {
		await harness.repositories.contacts.update(harness.contactWaId, { userId: "BR.ENT.4KgQ2wJ8" });

		const ladder = createLadder();
		const message = await insertOutbound();

		ladder.onOutboundAccepted(message);
		await tick(800);

		const emitted = await emittedStatuses();

		expect(emitted.map(entry => entry.value["recipient_user_id"])).toEqual(["BR.ENT.4KgQ2wJ8", "BR.ENT.4KgQ2wJ8"]);
		expect(emitted[0]?.value).toMatchObject({ recipient_id: harness.contactWaId });
	});

	it("leaves recipient_user_id off a recipient that has none", async () => {
		const ladder = createLadder();
		const message = await insertOutbound();

		ladder.onOutboundAccepted(message);
		await tick(0);

		const emitted = await emittedStatuses();

		expect(emitted[0]?.value).not.toHaveProperty("recipient_user_id");
	});

	it("climbs to read when the delays configure it", async () => {
		const ladder = createLadder({ sent: 0, delivered: 100, read: 500 });
		const message = await insertOutbound();

		ladder.onOutboundAccepted(message);
		await tick(600);

		expect(await statusOf(message.id)).toBe("read");
		expect(await emittedStatusNames()).toEqual(["sent", "delivered", "read"]);
	});

	it("honors a non-zero sent delay", async () => {
		const ladder = createLadder({ sent: 250, delivered: 100, read: null });
		const message = await insertOutbound();

		ladder.onOutboundAccepted(message);
		await tick(249);
		expect(await statusOf(message.id)).toBe("accepted");

		await tick(1);
		expect(await statusOf(message.id)).toBe("sent");
	});

	it("carries conversation and pricing on sent and delivered, and neither on read", async () => {
		const ladder = createLadder({ sent: 0, delivered: 1, read: 1 });
		const message = await insertOutbound();

		ladder.onOutboundAccepted(message);
		await tick(0);
		await tick(1);
		await tick(1);

		const [sent, delivered, read] = await emittedStatuses();

		for (const entry of [sent, delivered]) {
			expect(entry!.value).toMatchObject({
				conversation: { id: anyString(), expiration_timestamp: anyString(), origin: { type: "service" } },
				pricing: { billable: true, pricing_model: "PMP", type: "regular", category: "service" },
			});
		}

		expect(read!.value).not.toHaveProperty("conversation");
		expect(read!.value).not.toHaveProperty("pricing");
		// The statuses of one exchange share a conversation id.
		expect((sent!.value["conversation"] as { id: string }).id).toBe(
			(delivered!.value["conversation"] as { id: string }).id,
		);
	});

	it("prices a template send with the template's own category", async () => {
		await harness.repositories.templates.insert({
			id: "1689556908129832",
			wabaId: harness.wabaId,
			name: "order_update",
			language: "en_US",
			category: "MARKETING",
			components: [{ type: "BODY", text: "Hi" }],
			status: "APPROVED",
		});

		const ladder = createLadder({ sent: 0, delivered: 1, read: null });
		const message = await insertOutbound("template");

		ladder.onOutboundAccepted(message);
		await tick(0);
		await tick(1);

		const [sent] = await emittedStatuses();

		expect(sent!.value).toMatchObject({
			conversation: { origin: { type: "marketing" } },
			pricing: { category: "marketing" },
		});
	});

	describe("manual transitions", () => {
		it("stops the ladder dead when a message is marked failed", async () => {
			const ladder = createLadder();
			const message = await insertOutbound();

			ladder.onOutboundAccepted(message);
			await tick(0);
			expect(ladder.pendingCount).toBe(1);

			const failed = await ladder.markStatus(message.id, "failed", 131_026);

			await harness.tasks.whenIdle();

			expect(failed?.status).toBe("failed");
			expect(ladder.pendingCount).toBe(0);
			expect(failed?.error).toMatchObject({
				code: 131_026,
				title: "Message undeliverable",
				error_data: { details: anyString() },
				href: "/documentation/business-messaging/whatsapp/support/error-codes",
			});

			// The `delivered` rung that was queued never fires.
			await tick(60_000);
			expect(await statusOf(message.id)).toBe("failed");

			const emitted = await emittedStatuses();

			expect(emitted.map(entry => entry.status)).toEqual(["sent", "failed"]);
			expect(emitted.at(-1)!.value["errors"]).toEqual([expect.objectContaining({ code: 131_026 })]);
		});

		it("defaults to the engagement preset when no code is given", async () => {
			const ladder = createLadder();
			const message = await insertOutbound();
			const failed = await ladder.markStatus(message.id, "failed");

			await harness.tasks.whenIdle();

			expect(failed?.error).toMatchObject({ code: 131_049 });
		});

		it("lets a read receipt skip the delivered rung it never reached", async () => {
			const ladder = createLadder();
			const message = await insertOutbound();

			ladder.onOutboundAccepted(message);
			await tick(0);

			const read = await ladder.markStatus(message.id, "read");

			await harness.tasks.whenIdle();

			expect(read?.status).toBe("read");
			expect(ladder.pendingCount).toBe(0);

			await tick(60_000);
			expect(await statusOf(message.id)).toBe("read");
			expect(await emittedStatusNames()).toEqual(["sent", "read"]);
		});

		it("refuses to move a message backwards, or to touch one that failed", async () => {
			const ladder = createLadder();
			const message = await insertOutbound();

			await ladder.markStatus(message.id, "read");
			await harness.tasks.whenIdle();

			expect(await ladder.markStatus(message.id, "delivered")).toBeNull();
			expect(await ladder.markStatus(message.id, "read")).toBeNull();

			const other = await insertOutbound();

			await ladder.markStatus(other.id, "failed");
			await harness.tasks.whenIdle();

			expect(await ladder.markStatus(other.id, "read")).toBeNull();
			expect(await statusOf(other.id)).toBe("failed");
		});

		it("reports an unknown message id", async () => {
			expect(await createLadder().markStatus("wamid.nope", "read")).toBeNull();
		});
	});

	describe("events", () => {
		it("announces the message and every status change", async () => {
			const ladder = createLadder();
			const message = await insertOutbound();

			ladder.onOutboundAccepted(message);
			await tick(800);

			// The state change is announced first and the delivery attempt follows it: the UI
			// shows the new status immediately, then the webhook row that carried it.
			expect(events.map(event => event.type)).toEqual([
				"message.created",
				"message.status_changed",
				"webhook.delivery",
				"message.status_changed",
				"webhook.delivery",
			]);

			const [created, sent] = events;

			expect(created).toMatchObject({ payload: { message: { id: message.id, status: "accepted" } } });
			expect(sent).toMatchObject({ payload: { message: { status: "sent" }, previousStatus: "accepted" } });
		});
	});

	/**
	 * `biz_opaque_callback_data` (SPEC §2.5). The promise is "**every** status webhook for that
	 * message", which is what makes it usable as a correlation key — so this walks the whole
	 * ladder and then a manual rung, and asserts the key is on all of them.
	 */
	describe("biz_opaque_callback_data", () => {
		it("rides on every automatic rung", async () => {
			const ladder = createLadder({ sent: 0, delivered: 10, read: 20 });
			const message = await insertOutbound("text", { bizOpaqueCallbackData: "order-42" });

			ladder.onOutboundAccepted(message);
			await tick(100);

			const emitted = await emittedStatuses();

			expect(emitted.map(entry => entry.status)).toEqual(["sent", "delivered", "read"]);

			for (const entry of emitted) {
				expect(entry.value["biz_opaque_callback_data"]).toBe("order-42");
			}
		});

		it("rides on a manual failure too", async () => {
			const ladder = createLadder();
			const message = await insertOutbound("text", { bizOpaqueCallbackData: "order-42" });

			await ladder.markStatus(message.id, "failed");
			await tick(0);

			const [failed] = await emittedStatuses();

			expect(failed?.status).toBe("failed");
			expect(failed?.value["biz_opaque_callback_data"]).toBe("order-42");
			// …alongside Meta's `errors[]`, not instead of it.
			expect(failed?.value["errors"]).toBeDefined();
		});

		it("is absent from the statuses of a send that named none", async () => {
			const ladder = createLadder();
			const message = await insertOutbound();

			ladder.onOutboundAccepted(message);
			await tick(1000);

			const emitted = await emittedStatuses();

			for (const entry of emitted) {
				expect(entry.value).not.toHaveProperty("biz_opaque_callback_data");
			}
		});
	});

	describe("cancelAll", () => {
		it("drops every pending timer, which is what a reset needs", async () => {
			const ladder = createLadder();
			const first = await insertOutbound();
			const second = await insertOutbound();

			ladder.onOutboundAccepted(first);
			ladder.onOutboundAccepted(second);
			expect(ladder.pendingCount).toBe(2);

			ladder.cancelAll();
			await tick(60_000);

			expect(ladder.pendingCount).toBe(0);
			expect(await statusOf(first.id)).toBe("accepted");
			expect(await statusOf(second.id)).toBe("accepted");
		});
	});
});
