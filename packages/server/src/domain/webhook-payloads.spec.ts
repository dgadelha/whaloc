import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_UNSUPPORTED_MESSAGE_TYPE, UNSUPPORTED_MESSAGE_TYPES } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContactRecord, PhoneNumberRecord, TemplateRecord } from "../db/index.ts";
import { createDomainHarness, HARNESS_CONTACT_NAME, type DomainHarness } from "../testing/domain-harness.ts";
import {
	accountUpdateValue,
	businessCapabilityValue,
	conversationIdFor,
	conversationNode,
	CONVERSATION_WINDOW_MS,
	displayPhoneNumberDigits,
	inboundMessageValue,
	phoneNumberQualityValue,
	pricingNode,
	statusValue,
	systemNumberChangeValue,
	SYSTEM_USER_CHANGED_NUMBER,
	templateQualityValue,
	templateStatusValue,
	unixSeconds,
	unsupportedMessageErrorNode,
	unsupportedMessageNode,
	UNSUPPORTED_MESSAGE_ERROR_CODE,
	webhookEnvelope,
	WEBHOOK_FIELDS,
} from "./webhook-payloads.ts";

/**
 * The builders against the captured Meta samples (SPEC §1, §3).
 *
 * Every test here answers the same question: *would a receiver written against Meta parse
 * this?* So the comparison is structural — same keys, same nesting, same JSON types — with
 * only the values whaloc generates (ids, timestamps, names) allowed to differ. `structureOf`
 * is what makes that precise: it replaces every leaf with its type, so a `message_template_id`
 * that turned into a string, or a `timestamp` that turned into a number, fails.
 */

const FIXTURES_DIR = path.join(fileURLToPath(new URL("../../../../docs/fixtures/webhooks", import.meta.url)));

async function loadFixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(path.join(FIXTURES_DIR, `${name}.json`), "utf8")) as unknown;
}

/** The shape of a payload: keys and nesting kept, leaves replaced by their JSON type. */
function structureOf(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => structureOf(item));
	}

	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, structureOf(item)]),
		);
	}

	return typeof value;
}

/** The three BSUID keys (SPEC §1.15), stripped anywhere they appear. */
const IDENTITY_KEYS = ["user_id", "from_user_id", "recipient_user_id"];

/**
 * A payload with the named keys removed, so what is left can be compared against a captured
 * sample that predates them — proving an additive field really is the *only* addition.
 */
function withoutKeys(value: unknown, keys: readonly string[]): unknown {
	if (Array.isArray(value)) {
		return value.map(item => withoutKeys(item, keys));
	}

	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !keys.includes(key))
				.map(([key, item]) => [key, withoutKeys(item, keys)]),
		);
	}

	return value;
}

/** {@link withoutKeys} for the BSUID fields, which several specs below compare against. */
function withoutIdentityKeys(value: unknown): unknown {
	return withoutKeys(value, IDENTITY_KEYS);
}

const NOW = new Date("2026-06-12T12:00:00.000Z");

describe("webhook payload builders", () => {
	let harness: DomainHarness;
	let phoneNumber: PhoneNumberRecord;

	beforeEach(async () => {
		harness = await createDomainHarness();
		phoneNumber = (await harness.repositories.phoneNumbers.findById(harness.phoneNumberId))!;
	});

	afterEach(async () => {
		await harness.close();
	});

	async function insertMessage(overrides: Partial<Parameters<typeof harness.repositories.messages.insert>[0]> = {}) {
		return harness.repositories.messages.insert({
			id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
			direction: "inbound",
			phoneNumberId: harness.phoneNumberId,
			contactWaId: harness.contactWaId,
			type: "text",
			payload: { text: { body: "Does it come in another color?" } },
			timestamp: NOW.toISOString(),
			...overrides,
		});
	}

	async function insertTemplate(overrides: Partial<TemplateRecord> = {}): Promise<TemplateRecord> {
		return harness.repositories.templates.insert({
			id: "1689556908129832",
			wabaId: harness.wabaId,
			name: "order_confirmation",
			language: "en-US",
			category: "UTILITY",
			components: [{ type: "BODY", text: "Hi" }],
			...overrides,
		});
	}

	it("builds the envelope every event is wrapped in", async () => {
		const fixture = await loadFixture("text-message");
		const message = await insertMessage();
		const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;
		const envelope = webhookEnvelope({
			wabaId: harness.wabaId,
			field: WEBHOOK_FIELDS.messages,
			value: inboundMessageValue({ phoneNumber, contact, message }),
		});

		expect(structureOf(envelope)).toEqual(structureOf(fixture));
	});

	it("matches the inbound text sample", async () => {
		const fixture = await loadFixture("text-message");
		const message = await insertMessage();
		const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;
		const value = inboundMessageValue({ phoneNumber, contact, message });

		expect(value).toEqual({
			messaging_product: "whatsapp",
			metadata: { display_phone_number: "15550783881", phone_number_id: harness.phoneNumberId },
			contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: harness.contactWaId }],
			messages: [
				{
					from: harness.contactWaId,
					id: message.id,
					timestamp: String(unixSeconds(NOW)),
					type: "text",
					text: { body: "Does it come in another color?" },
				},
			],
		});
		expect(structureOf({ value })).toEqual(structureOf({ value: firstValue(fixture) }));
	});

	it("matches the inbound image sample, media metadata included", async () => {
		const fixture = await loadFixture("image-message");
		const message = await insertMessage({
			type: "image",
			payload: {
				image: {
					caption: "Is this the one?",
					mime_type: "image/jpeg",
					sha256: "lRvdoYJL5FRnY+B5y93Lp5NH/7oXdzR+4sCKs+vUT/0=",
					id: "1234567890",
					url: "http://localhost:9999/whaloc-media/token",
				},
			},
		});
		const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;

		expect(structureOf(inboundMessageValue({ phoneNumber, contact, message }))).toEqual(
			structureOf(firstValue(fixture)),
		);
	});

	it("quotes the message an inbound reply answers", async () => {
		const message = await insertMessage({ replyTo: "wamid.OUTBOUND" });
		const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;
		const value = inboundMessageValue({ phoneNumber, contact, message }) as {
			messages: [{ context: unknown }];
		};

		expect(value.messages[0].context).toEqual({ from: "15550783881", id: "wamid.OUTBOUND" });
	});

	it("reports the display number as digits, never as the formatted form", () => {
		expect(displayPhoneNumberDigits(phoneNumber)).toBe("15550783881");
		expect(phoneNumber.displayPhoneNumber).toContain(" ");
	});

	it.each(["sent", "delivered"] as const)("matches the status %s sample", async status => {
		const fixture = await loadFixture("status-sent");
		const message = await insertMessage({ direction: "outbound", type: "template" });
		const value = statusValue({
			phoneNumber,
			message,
			status,
			at: NOW,
			conversation: conversationNode({
				phoneNumberId: message.phoneNumberId,
				contactWaId: message.contactWaId,
				category: "marketing",
				at: NOW,
			}),
			pricing: pricingNode("marketing"),
		});

		expect(structureOf(value)).toEqual(structureOf(firstValue(fixture)));
		expect(value).toMatchObject({
			statuses: [
				{
					status,
					timestamp: String(unixSeconds(NOW)),
					recipient_id: harness.contactWaId,
					pricing: { billable: true, pricing_model: "PMP", type: "regular", category: "marketing" },
				},
			],
		});
	});

	it("matches the status failed sample, errors included", async () => {
		const fixture = await loadFixture("status-failed");
		const message = await insertMessage({ direction: "outbound" });
		const value = statusValue({
			phoneNumber,
			message,
			status: "failed",
			at: NOW,
			errors: [
				{
					code: 131_049,
					title: "This message was not delivered to maintain healthy ecosystem engagement.",
					message: "This message was not delivered to maintain healthy ecosystem engagement.",
					error_data: { details: "In order to maintain a healthy ecosystem engagement, …" },
					href: "/documentation/business-messaging/whatsapp/support/error-codes",
				},
			],
		});

		expect(structureOf(value)).toEqual(structureOf(firstValue(fixture)));
	});

	it("keeps a conversation id stable for a phone number, a contact and a day", () => {
		const morning = new Date("2026-06-12T08:00:00.000Z");
		const id = conversationIdFor("1", "2", morning);

		expect(id).toMatch(/^[\da-f]{32}$/);
		// Same day, later on: same conversation.
		expect(conversationIdFor("1", "2", new Date("2026-06-12T20:00:00.000Z"))).toBe(id);
		// A new day, another contact, another number: all different conversations.
		expect(conversationIdFor("1", "2", new Date("2026-06-13T08:00:00.000Z"))).not.toBe(id);
		expect(conversationIdFor("1", "3", morning)).not.toBe(id);
		expect(conversationIdFor("9", "2", morning)).not.toBe(id);
	});

	it("expires the conversation window 24 hours out", () => {
		const node = conversationNode({ phoneNumberId: "1", contactWaId: "2", category: "service", at: NOW });
		const tomorrow = new Date(NOW.getTime() + CONVERSATION_WINDOW_MS);

		expect(node).toMatchObject({
			expiration_timestamp: String(unixSeconds(tomorrow)),
			origin: { type: "service" },
		});
	});

	it("matches the template APPROVED sample, with the id as a JSON number", async () => {
		const fixture = await loadFixture("template-approved");
		const template = await insertTemplate();
		const envelope = webhookEnvelope({
			wabaId: harness.wabaId,
			field: WEBHOOK_FIELDS.templateStatus,
			value: templateStatusValue({ template, event: "APPROVED" }),
			time: NOW,
		});

		expect(structureOf(envelope)).toEqual(structureOf(fixture));
		expect(firstValue(envelope)).toMatchObject({
			event: "APPROVED",
			message_template_id: 1_689_556_908_129_832,
			message_template_name: "order_confirmation",
			message_template_language: "en-US",
			reason: "NONE",
			message_template_category: "UTILITY",
		});
	});

	it("matches the template REJECTED sample, rejection_info included", async () => {
		const fixture = await loadFixture("template-rejected");
		const template = await insertTemplate({ name: "abandoned_cart", language: "en", category: "MARKETING" });
		const value = templateStatusValue({
			template,
			event: "REJECTED",
			reason: "INVALID_FORMAT",
			rejectionInfo: { reason: "Parameters are next to each other.", recommendation: "Separate them." },
		});

		expect(structureOf(value)).toEqual(structureOf(firstValue(fixture)));
	});

	it("matches the template quality sample", async () => {
		const fixture = await loadFixture("template-quality");
		const template = await insertTemplate({ name: "welcome_template" });
		const value = templateQualityValue({ template, previousQualityScore: "GREEN", qualityScore: "YELLOW" });

		expect(structureOf(value)).toEqual(structureOf(firstValue(fixture)));
		expect(value).toMatchObject({ previous_quality_score: "GREEN", new_quality_score: "YELLOW" });
	});

	it("reports an unknown previous quality score the way Meta does", async () => {
		const template = await insertTemplate();

		expect(templateQualityValue({ template, previousQualityScore: null, qualityScore: "RED" })).toMatchObject({
			previous_quality_score: "UNKNOWN",
		});
	});

	it("matches the phone number quality sample", async () => {
		const fixture = await loadFixture("phone-number-quality");
		const value = phoneNumberQualityValue({
			phoneNumber,
			event: "THROUGHPUT_UPGRADE",
			currentLimit: "TIER_UNLIMITED",
		});

		expect(structureOf(value)).toEqual(structureOf(firstValue(fixture)));
		expect(value).toMatchObject({ display_phone_number: "15550783881" });
	});

	/**
	 * The BSUID fields (SPEC §1.15). The captured samples are from a contact that has no
	 * business-scoped user id, so each of these asserts *the fixture's structure plus exactly the
	 * identity keys* — which is the promise: `user_id`, `from_user_id` and `recipient_user_id`
	 * ride **alongside** `wa_id`, `from` and `recipient_id`, never instead of them.
	 */
	describe("business-scoped user ids", () => {
		const USER_ID = "US.13491208655302741918";

		async function contactWithUserId(): Promise<ContactRecord> {
			return (await harness.repositories.contacts.update(harness.contactWaId, { userId: USER_ID }))!;
		}

		it("adds contacts[].user_id and messages[].from_user_id to an inbound message", async () => {
			const fixture = await loadFixture("text-message");
			const message = await insertMessage();
			const value = inboundMessageValue({ phoneNumber, contact: await contactWithUserId(), message }) as {
				contacts: [{ wa_id: string; user_id: string }];
				messages: [{ from: string; from_user_id: string }];
			};

			expect(value.contacts[0]).toMatchObject({ wa_id: harness.contactWaId, user_id: USER_ID });
			expect(value.messages[0]).toMatchObject({ from: harness.contactWaId, from_user_id: USER_ID });
			expect(structureOf(withoutIdentityKeys(value))).toEqual(structureOf(firstValue(fixture)));
		});

		it("leaves both off a contact that has none", async () => {
			const message = await insertMessage();
			const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;
			const value = inboundMessageValue({ phoneNumber, contact, message }) as {
				contacts: [Record<string, unknown>];
				messages: [Record<string, unknown>];
			};

			expect(contact.userId).toBeNull();
			expect(value.contacts[0]).not.toHaveProperty("user_id");
			expect(value.messages[0]).not.toHaveProperty("from_user_id");
		});

		it("adds recipient_user_id to a status for a recipient that has one", async () => {
			const fixture = await loadFixture("status-sent");
			const message = await insertMessage({ direction: "outbound" });
			const contact = await contactWithUserId();
			const value = statusValue({
				phoneNumber,
				message,
				status: "sent",
				at: NOW,
				recipientUserId: contact.userId,
				conversation: conversationNode({
					phoneNumberId: message.phoneNumberId,
					contactWaId: message.contactWaId,
					category: "marketing",
					at: NOW,
				}),
				pricing: pricingNode("marketing"),
			}) as { statuses: [{ recipient_id: string; recipient_user_id: string }] };

			expect(value.statuses[0]).toMatchObject({ recipient_id: harness.contactWaId, recipient_user_id: USER_ID });
			expect(structureOf(withoutIdentityKeys(value))).toEqual(structureOf(firstValue(fixture)));
		});

		it.each([null, undefined])("leaves recipient_user_id off when the recipient id is %s", async userId => {
			const message = await insertMessage({ direction: "outbound" });
			const value = statusValue({
				phoneNumber,
				message,
				status: "read",
				at: NOW,
				...(userId !== undefined && { recipientUserId: userId }),
			}) as { statuses: [Record<string, unknown>] };

			expect(value.statuses[0]).not.toHaveProperty("recipient_user_id");
		});
	});

	/** Meta's `user_changed_number` notice (SPEC §5). */
	describe("the user_changed_number system event", () => {
		const PREVIOUS_WA_ID = "16505551234";
		const NEW_WA_ID = "12195555358";

		async function movedContact(userId?: string): Promise<ContactRecord> {
			if (userId !== undefined) {
				await harness.repositories.contacts.update(PREVIOUS_WA_ID, { userId });
			}

			return (await harness.repositories.contacts.changeWaId(PREVIOUS_WA_ID, NEW_WA_ID))!;
		}

		it("matches the documented sample", async () => {
			const fixture = await loadFixture("system-user-changed-number");
			const contact = await movedContact();
			const value = systemNumberChangeValue({
				phoneNumber,
				contact,
				previousWaId: PREVIOUS_WA_ID,
				messageId: "wamid.HBgLMTY1MDU1NTEyMzQVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
				at: NOW,
			});

			expect(value).toEqual(firstValue(fixture));
			expect(structureOf(webhookEnvelope({ wabaId: harness.wabaId, field: WEBHOOK_FIELDS.messages, value }))).toEqual(
				structureOf(fixture),
			);
		});

		it("comes from the old number while the contact is already on the new one", async () => {
			const contact = await movedContact();
			const value = systemNumberChangeValue({
				phoneNumber,
				contact,
				previousWaId: PREVIOUS_WA_ID,
				messageId: "wamid.SYSTEM",
				at: NOW,
			}) as {
				messages: [{ from: string; type: string; system: Record<string, unknown> }];
			};

			// Meta's system reference is explicit: system webhooks carry no `contacts` array, so
			// the new wa_id is only in `system` and a consumer has to read it there.
			expect(value).not.toHaveProperty("contacts");
			expect(Object.keys(value)).toEqual(["messaging_product", "metadata", "messages"]);
			expect(value.messages[0]).toMatchObject({ from: PREVIOUS_WA_ID, type: "system" });
			// Both spellings of the new number: Meta's webhook version decides which one it
			// sends, and a consumer reads `wa_id ?? new_wa_id` (SPEC §5).
			expect(value.messages[0].system).toEqual({
				// Meta's wording carries a `User ` prefix: `User <name> changed from <old> to <new>`.
				body: `User ${HARNESS_CONTACT_NAME} changed from ${PREVIOUS_WA_ID} to ${NEW_WA_ID}`,
				wa_id: NEW_WA_ID,
				new_wa_id: NEW_WA_ID,
				type: SYSTEM_USER_CHANGED_NUMBER,
			});
		});

		it("carries the BSUID, which is the identity that survives the move", async () => {
			const contact = await movedContact("US.13491208655302741918");
			const value = systemNumberChangeValue({
				phoneNumber,
				contact,
				previousWaId: PREVIOUS_WA_ID,
				messageId: "wamid.SYSTEM",
				at: NOW,
			}) as { messages: [{ from_user_id: string }] };

			// With no `contacts[]` to carry it, `from_user_id` is the only key that still pairs
			// this notice with a contact the consumer already knows.
			expect(value.messages[0].from_user_id).toBe("US.13491208655302741918");
			expect(value).not.toHaveProperty("contacts");
		});
	});

	/**
	 * The context riders and the click-to-WhatsApp `referral` (SPEC §5). They are stored on the
	 * payload and land in different places — `referral` top-level, the rest inside `context` — so
	 * each of these asserts *where*, not just *that*.
	 */
	describe("context riders", () => {
		const REFERRAL = {
			source_url: "https://fb.me/2Ax9kLm",
			source_id: "120210000000000000",
			source_type: "ad",
			headline: "Autumn sale, 30% off",
			body: "Message us to reserve yours.",
			media_type: "image",
			image_url: "https://scontent.example/ad-image.jpg",
			video_url: "https://scontent.example/ad-video.mp4",
			thumbnail_url: "https://scontent.example/ad-thumb.jpg",
			ctwa_clid: "ARAxYzc1YzExMS0yNTIyLTQ4ZmEtYmM3Ng",
		};

		it("matches the documented referral sample, with referral riding top-level", async () => {
			const fixture = await loadFixture("referral-message");
			const message = await insertMessage({
				payload: { text: { body: "Is this still available?" }, referral: REFERRAL },
			});
			const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;
			const value = inboundMessageValue({ phoneNumber, contact, message }) as {
				messages: [{ referral: unknown; context?: unknown }];
			};

			expect(structureOf(value)).toEqual(structureOf(firstValue(fixture)));
			expect(value.messages[0].referral).toEqual(REFERRAL);
			expect(value.messages[0]).not.toHaveProperty("context");
		});

		it("puts forwarded, frequently_forwarded and referred_product inside context", async () => {
			const message = await insertMessage({
				payload: {
					text: { body: "Look at this" },
					context: {
						forwarded: true,
						frequently_forwarded: true,
						referred_product: { catalog_id: "1234567", product_retailer_id: "SKU-9" },
					},
				},
			});
			const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;
			const value = inboundMessageValue({ phoneNumber, contact, message }) as {
				messages: [Record<string, unknown>];
			};

			expect(value.messages[0]["context"]).toEqual({
				forwarded: true,
				frequently_forwarded: true,
				referred_product: { catalog_id: "1234567", product_retailer_id: "SKU-9" },
			});
			// The riders live in `context`, never beside it.
			expect(value.messages[0]).not.toHaveProperty("forwarded");
			expect(value.messages[0]).not.toHaveProperty("referred_product");
		});

		it("merges the reply quote and the riders into one context, the way Meta sends it", async () => {
			const message = await insertMessage({
				replyTo: "wamid.OUTBOUND",
				payload: { text: { body: "Passing this on" }, context: { forwarded: true } },
			});
			const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;
			const value = inboundMessageValue({ phoneNumber, contact, message }) as {
				messages: [{ context: unknown }];
			};

			expect(value.messages[0].context).toEqual({ from: "15550783881", id: "wamid.OUTBOUND", forwarded: true });
		});
	});

	/** Meta's placeholder for a message this API version cannot represent (SPEC §5). */
	describe("the unsupported message type", () => {
		it("matches the documented sample, error node and unsupported node included", async () => {
			const fixture = await loadFixture("unsupported-message");
			const message = await insertMessage({
				type: "unsupported",
				payload: { errors: [unsupportedMessageErrorNode()], unsupported: unsupportedMessageNode("poll_update") },
			});
			const contact = (await harness.repositories.contacts.findByWaId(harness.contactWaId))!;
			const value = inboundMessageValue({ phoneNumber, contact, message }) as {
				messages: [Record<string, unknown>];
			};

			expect(structureOf(value)).toEqual(structureOf(firstValue(fixture)));
			// `errors[]` explains *why*, `unsupported.type` says *what* — Meta sends both.
			expect(value.messages[0]).toEqual({
				from: harness.contactWaId,
				id: message.id,
				timestamp: String(unixSeconds(NOW)),
				type: "unsupported",
				errors: [unsupportedMessageErrorNode()],
				unsupported: { type: "poll_update" },
			});
		});

		it("uses the v16+ error node shape, with Meta's wording inside error_data", () => {
			expect(unsupportedMessageErrorNode()).toEqual({
				code: UNSUPPORTED_MESSAGE_ERROR_CODE,
				title: "Message type unknown",
				message: "Message type unknown",
				// Verbatim from Meta's `unsupported` reference — "currently not", not "not currently".
				error_data: { details: "Message type is currently not supported." },
			});
			expect(UNSUPPORTED_MESSAGE_ERROR_CODE).toBe(131_051);
		});

		it("names the unsupported type from Meta's own list", () => {
			expect(unsupportedMessageNode("edit")).toEqual({ type: "edit" });
			expect(UNSUPPORTED_MESSAGE_TYPES).toContain(DEFAULT_UNSUPPORTED_MESSAGE_TYPE);
		});
	});

	/** The account-level notices (SPEC §3), against Meta's own documentation samples. */
	describe("account-level events", () => {
		it("matches the account_update sample", async () => {
			const fixture = await loadFixture("account-update");
			const envelope = webhookEnvelope({
				wabaId: harness.wabaId,
				field: WEBHOOK_FIELDS.accountUpdate,
				value: accountUpdateValue({ phoneNumber, event: "VERIFIED_ACCOUNT" }),
				time: NOW,
			});

			expect(structureOf(envelope)).toEqual(structureOf(fixture));
			expect(firstValue(envelope)).toEqual({ phone_number: "15550783881", event: "VERIFIED_ACCOUNT" });
		});

		it("matches the ACCOUNT_RESTRICTION sample, restriction_info included", async () => {
			const fixture = await loadFixture("account-restriction");
			const value = accountUpdateValue({
				event: "ACCOUNT_RESTRICTION",
				restrictionInfo: [{ restrictionType: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: "1748540794" }],
			});

			expect(structureOf(value)).toEqual(structureOf(firstValue(fixture)));
			// No number was named, so Meta's `phone_number` key is absent rather than empty.
			expect(value).not.toHaveProperty("phone_number");
		});

		it("leaves expiration off a restriction that does not lift", () => {
			const value = accountUpdateValue({
				event: "ACCOUNT_RESTRICTION",
				restrictionInfo: [{ restrictionType: "RESTRICTED_ADD_PHONE_NUMBER_ACTION" }],
			}) as { restriction_info: [Record<string, unknown>] };

			expect(value.restriction_info[0]).toEqual({ restriction_type: "RESTRICTED_ADD_PHONE_NUMBER_ACTION" });
		});

		it("matches the business_capability_update sample, with the limits as JSON numbers", async () => {
			const fixture = await loadFixture("business-capability-update");
			const envelope = webhookEnvelope({
				wabaId: harness.wabaId,
				field: WEBHOOK_FIELDS.businessCapabilityUpdate,
				value: businessCapabilityValue({ maxDailyConversationPerPhone: 1000, maxPhoneNumbersPerBusiness: 25 }),
				time: NOW,
			});

			expect(structureOf(envelope)).toEqual(structureOf(fixture));
			expect(firstValue(envelope)).toEqual({
				max_daily_conversation_per_phone: 1000,
				max_phone_numbers_per_business: 25,
			});
		});
	});

	/**
	 * `biz_opaque_callback_data` (SPEC §2.5). The captured samples come from sends that carried
	 * none, so this asserts *the fixture's structure plus exactly that key* — the same promise the
	 * BSUID fields make: it rides alongside everything else, never instead of it.
	 */
	describe("biz_opaque_callback_data", () => {
		it.each(["sent", "delivered", "read", "failed"] as const)("echoes it on a %s status", async status => {
			const fixture = await loadFixture("status-sent");
			const message = await insertMessage({ direction: "outbound" });
			const value = statusValue({
				phoneNumber,
				message,
				status,
				at: NOW,
				bizOpaqueCallbackData: "order-42",
				conversation: conversationNode({
					phoneNumberId: message.phoneNumberId,
					contactWaId: message.contactWaId,
					category: "service",
					at: NOW,
				}),
				pricing: pricingNode("service"),
			}) as { statuses: [Record<string, unknown>] };

			expect(value.statuses[0]["biz_opaque_callback_data"]).toBe("order-42");
			expect(structureOf(withoutKeys(value, ["biz_opaque_callback_data"]))).toEqual(structureOf(firstValue(fixture)));
		});

		it.each([null, undefined])("leaves it off when the send carried %s", async callbackData => {
			const message = await insertMessage({ direction: "outbound" });
			const value = statusValue({
				phoneNumber,
				message,
				status: "read",
				at: NOW,
				...(callbackData !== undefined && { bizOpaqueCallbackData: callbackData }),
			}) as { statuses: [Record<string, unknown>] };

			expect(value.statuses[0]).not.toHaveProperty("biz_opaque_callback_data");
		});
	});

	it("puts entry.time on the events Meta timestamps, and leaves it off the others", async () => {
		const template = await insertTemplate();
		const timed = webhookEnvelope({
			wabaId: harness.wabaId,
			field: WEBHOOK_FIELDS.templateStatus,
			value: templateStatusValue({ template, event: "APPROVED" }),
			time: NOW,
		}) as { entry: [{ time?: unknown }] };
		const untimed = webhookEnvelope({
			wabaId: harness.wabaId,
			field: WEBHOOK_FIELDS.messages,
			value: { messaging_product: "whatsapp" },
		}) as { entry: [{ time?: unknown }] };

		expect(timed.entry[0].time).toBe(unixSeconds(NOW));
		expect(untimed.entry[0]).not.toHaveProperty("time");
	});
});

/** The `value` of a fixture's single change entry. */
function firstValue(fixture: unknown): unknown {
	const { entry } = fixture as { entry: [{ changes: [{ value: unknown }] }] };

	return entry[0].changes[0].value;
}

/** Kept honest: a shape mismatch really does fail. */
describe("structureOf", () => {
	it("distinguishes a number from the string spelling of it", () => {
		expect(structureOf({ id: 1 })).not.toEqual(structureOf({ id: "1" }));
	});

	it("ignores key order but not the keys themselves", () => {
		expect(structureOf({ a: 1, b: "x" })).toEqual(structureOf({ b: "y", a: 2 }));
		expect(structureOf({ a: 1 })).not.toEqual(structureOf({ a: 1, b: 2 }));
	});
});
