import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WAMID_PATTERN, WEBHOOK_FIELDS } from "../domain/index.ts";
import { anyString, readJson, stringContaining, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

const RECIPIENT = "5511912345678";

interface SendResponse {
	messaging_product: string;
	contacts: { input: string; wa_id: string }[];
	messages: { id: string; message_status: string }[];
}

/** A body Meta accepts for each of the eleven send types (SPEC §2.5). */
const SEND_BODIES: Record<string, Record<string, unknown>> = {
	text: { type: "text", text: { body: "Hello World!", preview_url: false } },
	image: { type: "image", image: { id: "1234567890", caption: "A photo" } },
	video: { type: "video", video: { link: "https://example.com/clip.mp4", caption: "A clip" } },
	audio: { type: "audio", audio: { id: "1234567890" } },
	document: { type: "document", document: { id: "1234567890", caption: "Invoice", filename: "invoice.pdf" } },
	sticker: { type: "sticker", sticker: { id: "1234567890" } },
	location: { type: "location", location: { latitude: "37.4847", longitude: "-122.1486", name: "Meta HQ" } },
	reaction: { type: "reaction", reaction: { message_id: "wamid.ABC", emoji: "\u{1F44D}" } },
	interactive: {
		type: "interactive",
		interactive: {
			type: "button",
			body: { text: "Pick one" },
			action: { buttons: [{ type: "reply", reply: { id: "yes", title: "Yes" } }] },
		},
	},
	contacts: { type: "contacts", contacts: [{ name: { first_name: "John", formatted_name: "John Smith" } }] },
};

const TEXT_BODY = SEND_BODIES["text"]!;

describe("POST /:phoneNumberId/messages (SPEC §2.5)", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	function send(body: unknown, phoneNumberId = fixture.phoneNumberId) {
		return fixture.app.request(`/v25.0/${phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function sendText(overrides: Record<string, unknown> = {}) {
		return send({ messaging_product: "whatsapp", to: RECIPIENT, ...TEXT_BODY, ...overrides });
	}

	/** The wamid of an accepted send, which is how the stored row is looked up. */
	async function sentMessageId(response: Response): Promise<string> {
		const body = await readJson<SendResponse>(response);

		return body.messages[0]!.id;
	}

	async function createTemplate(overrides: Record<string, unknown> = {}): Promise<string> {
		const response = await fixture.app.request(`/v25.0/${fixture.wabaId}/message_templates`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({
				name: "order_update",
				language: "en_US",
				category: "UTILITY",
				components: [{ type: "BODY", text: "Order {{1}} ships on {{2}}" }],
				...overrides,
			}),
		});
		const created = await readJson<{ id: string }>(response);

		return created.id;
	}

	async function createApprovedTemplate(overrides: Record<string, unknown> = {}): Promise<string> {
		const id = await createTemplate(overrides);

		await fixture.services.repositories.templates.update(id, { status: "APPROVED" });

		return id;
	}

	describe("the response envelope (SPEC §1.6)", () => {
		it("matches the captured production sample", async () => {
			const response = await sendText();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				messaging_product: "whatsapp",
				contacts: [{ input: RECIPIENT, wa_id: RECIPIENT }],
				messages: [{ id: stringMatching(WAMID_PATTERN), message_status: "accepted" }],
			});
		});

		it("never repeats a wamid", async () => {
			const first = await sentMessageId(await sendText());
			const second = await sentMessageId(await sendText());

			expect(first).not.toBe(second);
		});

		it("echoes the recipient exactly as written but normalizes wa_id", async () => {
			const response = await sendText({ to: "+55 (11) 91234-5678" });

			expect(await response.json()).toMatchObject({
				contacts: [{ input: "+55 (11) 91234-5678", wa_id: RECIPIENT }],
			});
		});

		it("resolves a business-scoped user id via `recipient` (SPEC §1.15)", async () => {
			await fixture.services.repositories.contacts.insert({
				waId: RECIPIENT,
				profileName: "Ana Souza",
				userId: "BR.ENT.4KgQ2wJ8",
			});

			const response = await send({ messaging_product: "whatsapp", recipient: "BR.ENT.4KgQ2wJ8", ...TEXT_BODY });

			expect(response.status).toBe(200);
			// The `input` is echoed exactly as written — a BSUID — while `wa_id` is the number
			// behind it, which is the whole point of addressing by identity.
			expect(await response.json()).toMatchObject({
				contacts: [{ input: "BR.ENT.4KgQ2wJ8", wa_id: RECIPIENT }],
			});
		});

		it("answers the missing-object envelope for an unknown BSUID (SPEC §1.4)", async () => {
			const response = await send({ messaging_product: "whatsapp", recipient: "BR.ENT.nobody", ...TEXT_BODY });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
			// Nothing was invented for it: a BSUID says nothing about a phone number.
			expect(await fixture.services.repositories.contacts.findByUserId("BR.ENT.nobody")).toBeNull();
		});

		it("treats a `recipient` that is not BSUID-shaped like a `to`", async () => {
			const response = await send({ messaging_product: "whatsapp", recipient: RECIPIENT, ...TEXT_BODY });

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ contacts: [{ input: RECIPIENT, wa_id: RECIPIENT }] });
		});
	});

	describe("persistence", () => {
		it("stores the message as an accepted outbound one", async () => {
			const id = await sentMessageId(await sendText());
			const stored = await fixture.services.repositories.messages.findById(id);

			expect(stored).toMatchObject({
				direction: "outbound",
				status: "accepted",
				type: "text",
				phoneNumberId: fixture.phoneNumberId,
				contactWaId: RECIPIENT,
				payload: { text: { body: "Hello World!", preview_url: false } },
				replyTo: null,
			});
		});

		it("records a reply's context.message_id", async () => {
			const id = await sentMessageId(await sendText({ context: { message_id: "wamid.PARENT" } }));
			const stored = await fixture.services.repositories.messages.findById(id);

			expect(stored?.replyTo).toBe("wamid.PARENT");
		});

		it("auto-creates an unknown contact with the MSISDN as its profile name (SPEC §2)", async () => {
			expect(await fixture.services.repositories.contacts.findByWaId("5511999999999")).toBeNull();

			await sendText({ to: "5511999999999" });

			expect(await fixture.services.repositories.contacts.findByWaId("5511999999999")).toMatchObject({
				waId: "5511999999999",
				profileName: "5511999999999",
			});
		});

		it("leaves a known contact's profile name alone", async () => {
			await sendText({ to: "5571990000001" });

			expect(await fixture.services.repositories.contacts.findByWaId("5571990000001")).toMatchObject({
				profileName: "Ana Souza",
			});
		});

		/** `biz_opaque_callback_data` (SPEC §2.5): stored on the row, echoed on the statuses. */
		describe("biz_opaque_callback_data", () => {
			it("is stored on the message row", async () => {
				const id = await sentMessageId(await sendText({ biz_opaque_callback_data: "order-42" }));

				expect(await fixture.services.repositories.messages.findById(id)).toMatchObject({
					bizOpaqueCallbackData: "order-42",
				});
			});

			it("is null for a send that named none", async () => {
				const id = await sentMessageId(await sendText());

				expect(await fixture.services.repositories.messages.findById(id)).toMatchObject({
					bizOpaqueCallbackData: null,
				});
			});

			it("is not echoed on the send response — Meta only gives it back on the statuses", async () => {
				const response = await sendText({ biz_opaque_callback_data: "order-42" });

				expect(await response.json()).not.toHaveProperty("biz_opaque_callback_data");
			});

			it("accepts Meta's 512-character maximum", async () => {
				const response = await sendText({ biz_opaque_callback_data: "x".repeat(512) });

				expect(response.status).toBe(200);
			});

			it("refuses one character more, with the Meta envelope", async () => {
				const response = await sendText({ biz_opaque_callback_data: "x".repeat(513) });

				expect(response.status).toBe(400);
				expect(await readJson<{ error: { code: number; error_data: { details: string } } }>(response)).toMatchObject({
					error: { code: 100, error_data: { details: stringContaining("at most 512 characters") } },
				});
			});
		});
	});

	describe("every send type", () => {
		it.each(Object.keys(SEND_BODIES))("accepts and stores a %s message", async type => {
			const response = await send({ messaging_product: "whatsapp", to: RECIPIENT, ...SEND_BODIES[type] });

			expect(response.status).toBe(200);

			const stored = await fixture.services.repositories.messages.findById(await sentMessageId(response));

			expect(stored?.type).toBe(type);
			expect(stored?.payload).toHaveProperty(type);
		});

		it("accepts a template message against an approved template", async () => {
			await createApprovedTemplate();

			const response = await send({
				messaging_product: "whatsapp",
				to: RECIPIENT,
				type: "template",
				template: {
					name: "order_update",
					language: { code: "en_US" },
					components: [
						{
							type: "body",
							parameters: [
								{ type: "text", text: "A-1" },
								{ type: "text", text: "Friday" },
							],
						},
					],
				},
			});

			expect(response.status).toBe(200);
		});

		it("defaults a body without a type to text, the way Meta does", async () => {
			const response = await send({ messaging_product: "whatsapp", to: RECIPIENT, text: { body: "Implicit" } });

			expect(response.status).toBe(200);

			const stored = await fixture.services.repositories.messages.findById(await sentMessageId(response));

			expect(stored?.type).toBe("text");
		});
	});

	describe("envelope validation", () => {
		it("rejects a wrong messaging_product with Meta's wording", async () => {
			const response = await send({ messaging_product: "sms", to: RECIPIENT, ...TEXT_BODY });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: {
					message: "(#100) Invalid parameter",
					type: "OAuthException",
					code: 100,
					error_subcode: 2_494_010,
					error_data: { messaging_product: "whatsapp", details: "Param messaging_product must be whatsapp" },
				},
			});
		});

		it("rejects a send with neither to nor recipient", async () => {
			const response = await send({ messaging_product: "whatsapp", ...TEXT_BODY });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { error_data: { details: stringContaining("Param to is required") } },
			});
		});

		it("names the types it knows when the discriminator is wrong", async () => {
			const response = await send({ messaging_product: "whatsapp", to: RECIPIENT, type: "carrier_pigeon" });

			expect(await response.json()).toMatchObject({
				error: { error_data: { details: stringContaining("Param type must be one of text, template") } },
			});
		});

		it("rejects a media node with neither id nor link", async () => {
			const response = await send({
				messaging_product: "whatsapp",
				to: RECIPIENT,
				type: "image",
				image: { caption: "no source" },
			});

			expect(response.status).toBe(400);
		});

		it("rejects a malformed JSON body", async () => {
			const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: "{ not json",
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { error_data: { details: "Invalid JSON in request body" } },
			});
		});

		it("reports an unknown phone number as a missing object", async () => {
			const response = await send({ messaging_product: "whatsapp", to: RECIPIENT, ...TEXT_BODY }, "888888888888888");

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});

	describe("template send validation (SPEC §2)", () => {
		function sendTemplate(template: Record<string, unknown>) {
			return send({ messaging_product: "whatsapp", to: RECIPIENT, type: "template", template });
		}

		it("rejects an unknown template name with 132001", async () => {
			const response = await sendTemplate({ name: "never_created", language: { code: "en_US" } });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: {
					message: "(#132001) Template name does not exist in the translation",
					code: 132_001,
					error_data: { details: "template name (never_created) does not exist in en_US" },
				},
			});
		});

		it("rejects a template that exists in another language with 132001", async () => {
			await createApprovedTemplate();

			const response = await sendTemplate({
				name: "order_update",
				language: { code: "pt_BR" },
				components: [
					{
						type: "body",
						parameters: [
							{ type: "text", text: "A-1" },
							{ type: "text", text: "Sexta" },
						],
					},
				],
			});

			expect(await response.json()).toMatchObject({
				error: { code: 132_001, error_data: { details: "template name (order_update) does not exist in pt_BR" } },
			});
		});

		it("rejects a template that is still PENDING with 132001", async () => {
			await createTemplate({ name: "unapproved", components: [{ type: "BODY", text: "Hi" }] });

			const response = await sendTemplate({ name: "unapproved", language: { code: "en_US" } });

			expect(await response.json()).toMatchObject({
				error: { code: 132_001, error_data: { details: "template name (unapproved) is not approved in en_US" } },
			});
		});

		it("rejects a positional parameter count mismatch with the captured 132000 envelope", async () => {
			await createApprovedTemplate({ components: [{ type: "BODY", text: "{{1}} {{2}} {{3}}" }] });

			const response = await sendTemplate({
				name: "order_update",
				language: { code: "en_US" },
				components: [{ type: "body", parameters: [{ type: "text", text: "only one" }] }],
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: {
					message: "(#132000) Number of parameters does not match the expected number of params",
					code: 132_000,
					type: "OAuthException",
					error_data: {
						messaging_product: "whatsapp",
						details: "body: number of localizable_params (1) does not match the expected number of params (3)",
					},
					fbtrace_id: anyString(),
				},
			});
		});

		it("rejects a NAMED template whose parameter_name does not match", async () => {
			await createApprovedTemplate({
				name: "named_update",
				parameter_format: "NAMED",
				components: [{ type: "BODY", text: "Hi {{customer_name}}" }],
			});

			const response = await sendTemplate({
				name: "named_update",
				language: { code: "en_US" },
				components: [{ type: "body", parameters: [{ type: "text", parameter_name: "client", text: "Ana" }] }],
			});

			expect(await response.json()).toMatchObject({
				error: {
					code: 132_000,
					error_data: { details: "body: parameter_name (client) does not exist in the template" },
				},
			});
		});

		it("accepts a NAMED template whose parameter names all match", async () => {
			await createApprovedTemplate({
				name: "named_update",
				parameter_format: "NAMED",
				components: [{ type: "BODY", text: "Hi {{customer_name}}" }],
			});

			const response = await sendTemplate({
				name: "named_update",
				language: { code: "en_US" },
				components: [{ type: "body", parameters: [{ type: "text", parameter_name: "customer_name", text: "Ana" }] }],
			});

			expect(response.status).toBe(200);
		});

		it("does not store a message a template check rejected", async () => {
			await sendTemplate({ name: "never_created", language: { code: "en_US" } });

			const conversation = await fixture.services.repositories.messages.listConversation({
				phoneNumberId: fixture.phoneNumberId,
				contactWaId: RECIPIENT,
			});

			expect(conversation).toEqual([]);
		});
	});

	/**
	 * The point of seeding a template (SPEC §7): a cold whaloc can answer a `type: "template"`
	 * send without the consumer creating one and waiting for it to be approved first.
	 */
	describe("the seeded template", () => {
		it("accepts a send that carries nothing but its name and language", async () => {
			const response = await send({
				messaging_product: "whatsapp",
				to: RECIPIENT,
				type: "template",
				template: { name: "hello_whaloc", language: { code: "en" } },
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				messages: [{ id: stringMatching(WAMID_PATTERN), message_status: "accepted" }],
			});
		});

		it("is APPROVED with no review pending behind it", async () => {
			const template = await fixture.services.repositories.templates.findByNameAndLanguage(
				fixture.wabaId,
				"hello_whaloc",
				"en",
			);

			expect(template).toMatchObject({ status: "APPROVED" });
			// Nothing was scheduled: `WHALOC_TEMPLATE_AUTO_APPROVE` has nothing to approve.
			expect(fixture.services.domain.templateLifecycle.pendingCount).toBe(0);
		});

		it("announced nothing at boot", async () => {
			await fixture.services.domain.tasks.whenIdle();

			const deliveries = await fixture.services.repositories.webhookDeliveries.list();

			expect(deliveries.filter(delivery => delivery.eventType === WEBHOOK_FIELDS.templateStatus)).toEqual([]);
		});
	});

	/**
	 * The same path, the other body (SPEC §2.18). This is the direction the status ladder does
	 * not cover: the app under test telling whaloc it has read what the user wrote.
	 */
	describe("read receipts and typing indicators (SPEC §2.18)", () => {
		/** A user message, through the control plane — the way one really arrives. */
		async function receiveInbound(body = "Is my order ready?"): Promise<string> {
			const response = await fixture.app.request("/api/inbound", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					phoneNumberId: fixture.phoneNumberId,
					from: RECIPIENT,
					type: "text",
					text: { body },
				}),
			});
			const received = await readJson<{ data: { id: string } }>(response);

			return received.data.id;
		}

		function markRead(overrides: Record<string, unknown> = {}, phoneNumberId = fixture.phoneNumberId) {
			return send(
				{ messaging_product: "whatsapp", status: "read", message_id: "wamid.MISSING", ...overrides },
				phoneNumberId,
			);
		}

		async function typingIndicators(): Promise<{ contactWaId: string; expiresAt: string | null }[]> {
			const response = await fixture.app.request(`/api/typing?phoneNumberId=${fixture.phoneNumberId}`);
			const listed = await readJson<{ data: { contactWaId: string; expiresAt: string | null }[] }>(response);

			return listed.data;
		}

		it("answers {success:true} and moves the inbound message to read", async () => {
			const messageId = await receiveInbound();
			const response = await markRead({ message_id: messageId });

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			expect(await fixture.services.repositories.messages.findById(messageId)).toMatchObject({
				direction: "inbound",
				status: "read",
			});
		});

		it("is idempotent — reading twice is still a success", async () => {
			const messageId = await receiveInbound();

			await markRead({ message_id: messageId });

			const response = await markRead({ message_id: messageId });

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
		});

		/** Meta reports statuses for outbound messages only; a read receipt is not a callback. */
		it("emits no webhook", async () => {
			const messageId = await receiveInbound();

			await fixture.services.domain.tasks.whenIdle();

			const before = await fixture.services.repositories.webhookDeliveries.list();

			await markRead({ message_id: messageId });
			await fixture.services.domain.tasks.whenIdle();

			expect(await fixture.services.repositories.webhookDeliveries.list()).toHaveLength(before.length);
		});

		it("reports an unknown wamid as a missing object (SPEC §1.4)", async () => {
			const response = await markRead();

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});

		it("reports a wamid belonging to another phone number as missing", async () => {
			const messageId = await receiveInbound();
			const other = await fixture.services.repositories.phoneNumbers.insert({
				id: "111222333444555",
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+55 11 90000-0000",
				verifiedName: "Another number",
			});
			const response = await markRead({ message_id: messageId }, other.id);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});

		it("explains an outbound wamid instead of calling it missing", async () => {
			const outbound = await sentMessageId(await sendText());
			const response = await markRead({ message_id: outbound });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: {
					code: 100,
					error_data: { details: stringContaining("Param message_id must be the id of a message received") },
				},
			});
		});

		it("rejects a receipt whose messaging_product is wrong", async () => {
			const messageId = await receiveInbound();
			const response = await send({ messaging_product: "sms", status: "read", message_id: messageId });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { error_data: { details: "Param messaging_product must be whatsapp" } },
			});
		});

		it("rejects a receipt with no message_id", async () => {
			const response = await send({ messaging_product: "whatsapp", status: "read" });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100 } });
		});

		it("answers 133010 from a number that is not registered (SPEC §4)", async () => {
			const messageId = await receiveInbound();

			await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/deregister`, {
				method: "POST",
				headers: TEST_AUTH_HEADERS,
			});

			const response = await markRead({ message_id: messageId });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 133_010 } });
		});

		describe("with a typing_indicator", () => {
			it("raises the indicator and marks the message read", async () => {
				const messageId = await receiveInbound();
				const response = await markRead({ message_id: messageId, typing_indicator: { type: "text" } });

				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ success: true });
				expect(await fixture.services.repositories.messages.findById(messageId)).toMatchObject({ status: "read" });
				expect(await typingIndicators()).toEqual([
					{ phoneNumberId: fixture.phoneNumberId, contactWaId: RECIPIENT, expiresAt: anyString() },
				]);
			});

			it("rejects a typing_indicator type Meta does not define", async () => {
				const messageId = await receiveInbound();
				const response = await markRead({ message_id: messageId, typing_indicator: { type: "voice" } });

				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({
					error: { error_data: { details: "Param typing_indicator.type must be text" } },
				});
			});

			it("comes down when the business sends its next message", async () => {
				const messageId = await receiveInbound();

				await markRead({ message_id: messageId, typing_indicator: { type: "text" } });
				expect(await typingIndicators()).toHaveLength(1);

				await sendText();

				expect(await typingIndicators()).toEqual([]);
			});

			it("survives a message sent to somebody else", async () => {
				const messageId = await receiveInbound();

				await markRead({ message_id: messageId, typing_indicator: { type: "text" } });
				await sendText({ to: "5571990000002" });

				expect(await typingIndicators()).toHaveLength(1);
			});
		});
	});
});
