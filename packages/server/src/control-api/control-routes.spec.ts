import {
	contactListResponseSchema,
	contactResponseSchema,
	conversationListResponseSchema,
	conversationMessagesResponseSchema,
	handshakeResponseSchema,
	inboundMediaResponseSchema,
	inboundResponseSchema,
	mediaResponseSchema,
	messageErrorPresetListResponseSchema,
	messageResponseSchema,
	MESSAGE_ERROR_CODES,
	resetResponseSchema,
	stateResponseSchema,
	templateListResponseSchema,
	templateResponseSchema,
	wabaResponseSchema,
	webhookDeliveryAttemptsResponseSchema,
	webhookDeliveryListResponseSchema,
	type ControlError,
	type InboundRequest,
} from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { output, ZodType } from "zod";
import { startCaptureServer, type CaptureServer } from "../testing/capture-server.ts";
import { anyString, readJson, stringContaining, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * The control plane through `app.request()` (SPEC §5).
 *
 * The fixture is the real composed app on an in-memory database, with `WHALOC_WEBHOOK_URL`
 * pointing at a throwaway capture server — so a route that is supposed to emit a webhook is
 * asserted on the request the app under test would have received, not on a mock.
 */
const APP_SECRET = "dev-meta-app-secret";

describe("control-plane API", () => {
	let fixture: TestApp;
	let capture: CaptureServer;

	beforeEach(async () => {
		capture = await startCaptureServer(request => ({ status: 200, body: request.query.get("hub.challenge") ?? "ok" }));
		fixture = await createTestApp({
			WHALOC_WEBHOOK_URL: capture.url,
			WHALOC_APP_SECRET: APP_SECRET,
			WHALOC_WEBHOOK_VERIFY_TOKEN: "dev-verify-token",
			// Reviews and read receipts are triggered by the tests themselves.
			WHALOC_TEMPLATE_AUTO_APPROVE: "off",
			WHALOC_STATUS_DELAYS: "sent:0,delivered:800",
		});
	});

	afterEach(async () => {
		await fixture.close();
		await capture.close();
	});

	/** Runs a request and parses its body with the schema the UI would use. */
	async function parseBody<TSchema extends ZodType>(schema: TSchema, response: Response): Promise<output<TSchema>> {
		const body: unknown = await response.json();

		return schema.parse(body);
	}

	/** `GET`s a path and parses the answer. */
	async function get<TSchema extends ZodType>(schema: TSchema, path: string): Promise<output<TSchema>> {
		return parseBody(schema, await fixture.app.request(path));
	}

	/** Waits for the webhook deliveries the last action started. */
	async function settle(): Promise<void> {
		await fixture.services.domain.tasks.whenIdle();
	}

	async function post(path: string, body?: unknown): Promise<Response> {
		return fixture.app.request(path, {
			method: "POST",
			...(body !== undefined && { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
		});
	}

	async function simulateInbound(request: Record<string, unknown> & { type: InboundRequest["type"] }) {
		return post("/api/inbound", { phoneNumberId: fixture.phoneNumberId, from: "16505551234", ...request });
	}

	/** The `value` of the last webhook the capture server received. */
	function lastWebhookValue(): Record<string, unknown> {
		const body = JSON.parse(capture.requests.at(-1)!.body) as {
			entry: [{ changes: [{ value: Record<string, unknown> }] }];
		};

		return body.entry[0].changes[0].value;
	}

	describe("GET /api/state", () => {
		it("describes the emulated world and the webhook target", async () => {
			const response = await fixture.app.request("/api/state");
			const state = await parseBody(stateResponseSchema, response);

			expect(response.status).toBe(200);
			expect(state.wabas[0]).toMatchObject({
				id: fixture.wabaId,
				phoneNumbers: [{ id: fixture.phoneNumberId, qualityRating: "GREEN", throughputLevel: "STANDARD" }],
			});
			expect(state.behavior).toEqual({
				statusDelays: { sent: 0, delivered: 800, read: null },
				templateAutoApproveMs: null,
				// Both error-simulation knobs are off unless their variable is set (SPEC §7).
				strictTokens: false,
				mediaTtlSeconds: null,
			});
			expect(state.webhook).toMatchObject({
				url: capture.url,
				appSecretConfigured: true,
				verifyTokenConfigured: true,
				verifyOnStart: false,
				lastHandshake: null,
			});
		});

		it("never serves the secrets themselves", async () => {
			const state = await fixture.app.request("/api/state");
			const body = await state.text();

			expect(body).not.toContain(APP_SECRET);
			expect(body).not.toContain("dev-verify-token");
		});
	});

	describe("contacts", () => {
		it("lists the seeded contacts", async () => {
			const body = await get(contactListResponseSchema, "/api/contacts");

			expect(body.data.map(contact => contact.profileName)).toEqual(["Ana Souza", "Bruno Lima"]);
		});

		it("creates one", async () => {
			const response = await post("/api/contacts", { waId: "16505551234", profileName: "Sheena Nelson" });

			expect(response.status).toBe(201);
			const body = await parseBody(contactResponseSchema, response);

			expect(body.data).toMatchObject({ waId: "16505551234", profileName: "Sheena Nelson" });
		});

		it("refuses a duplicate", async () => {
			await post("/api/contacts", { waId: "16505551234", profileName: "Sheena" });

			const response = await post("/api/contacts", { waId: "16505551234", profileName: "Sheena" });

			expect(response.status).toBe(409);
			expect(await readJson<ControlError>(response)).toEqual({
				error: { message: stringContaining("already exists"), code: "contact_exists" },
			});
		});

		it("renames one", async () => {
			const response = await fixture.app.request("/api/contacts/5571990000001", {
				method: "PATCH",
				body: JSON.stringify({ profileName: "Ana S." }),
				headers: { "content-type": "application/json" },
			});

			const body = await parseBody(contactResponseSchema, response);

			expect(body.data.profileName).toBe("Ana S.");
		});

		it("reports an unknown contact", async () => {
			const response = await fixture.app.request("/api/contacts/999", {
				method: "PATCH",
				body: JSON.stringify({ profileName: "Nobody" }),
				headers: { "content-type": "application/json" },
			});

			expect(response.status).toBe(404);
			const body = await readJson<ControlError>(response);

			expect(body.error.code).toBe("unknown_contact");
		});

		it("rejects an invalid body with the control plane's error shape", async () => {
			const response = await post("/api/contacts", { waId: "16505551234" });

			expect(response.status).toBe(400);
			const body = await readJson<ControlError>(response);

			expect(body.error).toMatchObject({ message: stringContaining("profileName"), code: "invalid_request" });
		});

		/** The BSUID a contact may also be known by (SPEC §1.15) — editable, never seeded. */
		describe("business-scoped user ids", () => {
			async function patchContact(waId: string, body: unknown): Promise<Response> {
				return fixture.app.request(`/api/contacts/${waId}`, {
					method: "PATCH",
					body: JSON.stringify(body),
					headers: { "content-type": "application/json" },
				});
			}

			it("creates a contact with one", async () => {
				const response = await post("/api/contacts", {
					waId: "16505551234",
					profileName: "Sheena Nelson",
					userId: "US.13491208655302741918",
				});

				expect(response.status).toBe(201);

				const body = await parseBody(contactResponseSchema, response);

				expect(body.data.userId).toBe("US.13491208655302741918");
			});

			it("seeds the default contacts with one of each BSUID shape", async () => {
				const body = await get(contactListResponseSchema, "/api/contacts");

				expect(body.data.map(contact => contact.userId)).toEqual(["BR.ENT.AnaSouza01", "BR.BrunoLima01"]);
			});

			it("sets and clears one on an existing contact", async () => {
				const set = await parseBody(
					contactResponseSchema,
					await patchContact("5571990000001", { userId: "BR.ENT.4KgQ2wJ8" }),
				);

				expect(set.data).toMatchObject({ profileName: "Ana Souza", userId: "BR.ENT.4KgQ2wJ8" });

				const cleared = await parseBody(contactResponseSchema, await patchContact("5571990000001", { userId: null }));

				expect(cleared.data.userId).toBeNull();
			});

			it("rejects one that is not BSUID-shaped", async () => {
				const response = await patchContact("5571990000001", { userId: "not a bsuid" });

				expect(response.status).toBe(400);

				const body = await readJson<ControlError>(response);

				expect(body.error).toMatchObject({
					message: stringContaining("business-scoped user id"),
					code: "invalid_request",
				});
			});

			it("refuses to give two contacts the same one", async () => {
				await patchContact("5571990000001", { userId: "BR.ENT.4KgQ2wJ8" });

				const response = await patchContact("5571990000002", { userId: "BR.ENT.4KgQ2wJ8" });

				expect(response.status).toBe(409);

				const body = await readJson<ControlError>(response);

				expect(body.error).toMatchObject({ code: "user_id_taken" });
			});

			it("reports an unknown contact before complaining about a taken BSUID", async () => {
				await patchContact("5571990000001", { userId: "BR.ENT.4KgQ2wJ8" });

				const response = await patchContact("999", { userId: "BR.ENT.4KgQ2wJ8" });

				expect(response.status).toBe(404);

				const body = await readJson<ControlError>(response);

				expect(body.error.code).toBe("unknown_contact");
			});

			it("lets a contact keep the one it already has", async () => {
				await patchContact("5571990000001", { userId: "BR.ENT.4KgQ2wJ8" });

				const response = await patchContact("5571990000001", { userId: "BR.ENT.4KgQ2wJ8" });

				expect(response.status).toBe(200);
			});

			it("carries the identity into the inbound webhook", async () => {
				await post("/api/contacts", {
					waId: "16505551234",
					profileName: "Sheena Nelson",
					userId: "US.13491208655302741918",
				});
				await simulateInbound({ type: "text", text: { body: "Hello" } });
				await settle();

				expect(lastWebhookValue()).toMatchObject({
					contacts: [{ wa_id: "16505551234", user_id: "US.13491208655302741918" }],
					messages: [{ from: "16505551234", from_user_id: "US.13491208655302741918" }],
				});
			});

			it("resolves a send addressed by `recipient` to the contact that owns it", async () => {
				await post("/api/contacts", {
					waId: "5511912345678",
					profileName: "Ana",
					userId: "BR.ENT.4KgQ2wJ8",
				});

				const send = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
					method: "POST",
					headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
					body: JSON.stringify({
						messaging_product: "whatsapp",
						recipient: "BR.ENT.4KgQ2wJ8",
						type: "text",
						text: { body: "Hi" },
					}),
				});

				expect(send.status).toBe(200);

				const body = await readJson<{ contacts: { input: string; wa_id: string }[] }>(send);

				expect(body).toMatchObject({ contacts: [{ input: "BR.ENT.4KgQ2wJ8", wa_id: "5511912345678" }] });
			});
		});

		/** Meta's `user_changed_number` system event (SPEC §5). */
		describe("POST /api/contacts/:waId/change-number", () => {
			async function messageFrom(waId: string): Promise<void> {
				await post("/api/inbound", {
					phoneNumberId: fixture.phoneNumberId,
					from: waId,
					type: "text",
					text: { body: "Hello" },
				});
				await settle();
			}

			it("moves the contact, takes its messages along and emits the system webhook", async () => {
				await messageFrom("5571990000001");

				const response = await post("/api/contacts/5571990000001/change-number", { waId: "5571990009999" });

				expect(response.status).toBe(200);

				const body = await parseBody(contactResponseSchema, response);

				expect(body.data).toMatchObject({ waId: "5571990009999", profileName: "Ana Souza" });
				await settle();

				expect(lastWebhookValue()).not.toHaveProperty("contacts");
				expect(lastWebhookValue()).toMatchObject({
					messages: [
						{
							from: "5571990000001",
							type: "system",
							system: {
								body: "User Ana Souza changed from 5571990000001 to 5571990009999",
								wa_id: "5571990009999",
								new_wa_id: "5571990009999",
								type: "user_changed_number",
							},
						},
					],
				});

				// The conversation followed the contact: same messages, new derived id.
				const conversations = await get(
					conversationListResponseSchema,
					`/api/conversations?phoneNumberId=${fixture.phoneNumberId}`,
				);

				expect(conversations.data).toHaveLength(1);
				expect(conversations.data[0]).toMatchObject({
					id: `${fixture.phoneNumberId}:5571990009999`,
					contactWaId: "5571990009999",
					messageCount: 1,
				});
			});

			it("says nothing to a number the contact never talked to", async () => {
				await post("/api/contacts/5571990000001/change-number", { waId: "5571990009999" });
				await settle();

				expect(capture.requests).toHaveLength(0);
			});

			it("announces it to one named number only", async () => {
				await messageFrom("5571990000001");
				await post("/api/contacts/5571990000001/change-number", {
					waId: "5571990009999",
					phoneNumberId: fixture.phoneNumberId,
				});
				await settle();

				expect(lastWebhookValue()).toMatchObject({
					metadata: { phone_number_id: fixture.phoneNumberId },
					messages: [{ system: { type: "user_changed_number" } }],
				});
			});

			it("refuses a number another contact already has", async () => {
				const response = await post("/api/contacts/5571990000001/change-number", { waId: "5571990000002" });

				expect(response.status).toBe(409);

				const body = await readJson<ControlError>(response);

				expect(body.error).toMatchObject({ code: "contact_exists" });
				expect(await fixture.services.repositories.contacts.findByWaId("5571990000001")).not.toBeNull();
			});

			it("refuses the number the contact is already on", async () => {
				const response = await post("/api/contacts/5571990000001/change-number", { waId: "5571990000001" });

				expect(response.status).toBe(400);

				const body = await readJson<ControlError>(response);

				expect(body.error).toMatchObject({ code: "unchanged_number" });
			});

			it("reports an unknown contact and an unknown phone number", async () => {
				const unknownContact = await post("/api/contacts/999/change-number", { waId: "5571990009999" });
				const unknownNumber = await post("/api/contacts/5571990000001/change-number", {
					waId: "5571990009999",
					phoneNumberId: "1234567890",
				});

				const contactError = await readJson<ControlError>(unknownContact);
				const numberError = await readJson<ControlError>(unknownNumber);

				expect(unknownContact.status).toBe(404);
				expect(contactError.error.code).toBe("unknown_contact");
				expect(unknownNumber.status).toBe(404);
				expect(numberError.error.code).toBe("unknown_phone_number");
			});

			it("keeps a reaction to a message sent before the move working", async () => {
				await messageFrom("5571990000001");

				const before = await get(
					conversationMessagesResponseSchema,
					`/api/conversations/${fixture.phoneNumberId}:5571990000001/messages`,
				);
				const wamid = before.data[0]!.id;

				await post("/api/contacts/5571990000001/change-number", { waId: "5571990009999" });
				await settle();

				const reaction = await post("/api/inbound", {
					phoneNumberId: fixture.phoneNumberId,
					from: "5571990009999",
					type: "reaction",
					reaction: { message_id: wamid, emoji: "\u{1F44D}" },
				});

				expect(reaction.status).toBe(201);
				expect(await fixture.services.repositories.messages.findById(wamid)).toMatchObject({
					contactWaId: "5571990009999",
				});
			});

			it("takes the BSUID along, so the identity survives the move", async () => {
				await fixture.app.request("/api/contacts/5571990000001", {
					method: "PATCH",
					body: JSON.stringify({ userId: "BR.ENT.4KgQ2wJ8" }),
					headers: { "content-type": "application/json" },
				});
				await messageFrom("5571990000001");
				await post("/api/contacts/5571990000001/change-number", { waId: "5571990009999" });
				await settle();

				// No `contacts[]` on a system event, so `from_user_id` is what carries the identity.
				expect(lastWebhookValue()).toMatchObject({
					messages: [{ from: "5571990000001", from_user_id: "BR.ENT.4KgQ2wJ8" }],
				});
				expect(lastWebhookValue()).not.toHaveProperty("contacts");
				expect(await fixture.services.repositories.contacts.findByUserId("BR.ENT.4KgQ2wJ8")).toMatchObject({
					waId: "5571990009999",
				});
			});
		});
	});

	describe("POST /api/inbound", () => {
		it("persists the message, answers with it and delivers the webhook", async () => {
			const response = await simulateInbound({ type: "text", text: { body: "Does it come in blue?" } });

			expect(response.status).toBe(201);

			const { data } = await parseBody(inboundResponseSchema, response);

			expect(data).toMatchObject({ direction: "inbound", type: "text", contactWaId: "16505551234" });

			await settle();

			expect(capture.requests).toHaveLength(1);
			expect(lastWebhookValue()).toMatchObject({
				messaging_product: "whatsapp",
				metadata: { phone_number_id: fixture.phoneNumberId },
				contacts: [{ wa_id: "16505551234" }],
				messages: [{ id: data.id, type: "text", text: { body: "Does it come in blue?" } }],
			});
			expect(capture.requests[0]!.headers["x-hub-signature-256"]).toMatch(/^sha256=[\da-f]{64}$/);
		});

		it.each([
			["interactive", { interactive: { type: "button_reply", button_reply: { id: "yes", title: "Yes" } } }],
			["button", { button: { payload: "STOP", text: "Stop" } }],
			["location", { location: { latitude: -12.97, longitude: -38.5 } }],
			["contacts", { contacts: [{ name: { formatted_name: "Ana" } }] }],
			["reaction", { reaction: { message_id: "wamid.OUT", emoji: "👍" } }],
		] as [InboundRequest["type"], Record<string, unknown>][])("accepts an inbound %s", async (type, payload) => {
			const response = await post("/api/inbound", {
				phoneNumberId: fixture.phoneNumberId,
				from: "16505551234",
				type,
				...payload,
			});

			expect(response.status).toBe(201);
			const body = await parseBody(inboundResponseSchema, response);

			expect(body.data.payload).toEqual(payload);
		});

		it("round-trips an uploaded media file into an inbound image", async () => {
			const form = new FormData();

			form.set("phoneNumberId", fixture.phoneNumberId);
			form.set("type", "image/png");
			form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "photo.png", { type: "image/png" }));

			const upload = await fixture.app.request("/api/inbound-media", { method: "POST", body: form });

			expect(upload.status).toBe(201);

			const { data: media } = await parseBody(inboundMediaResponseSchema, upload);

			expect(media).toMatchObject({ mimeType: "image/png", fileSize: 4, id: stringMatching(/^\d{1,32}$/) });

			const inbound = await simulateInbound({ type: "image", media: { id: media.id, caption: "Look" } });

			expect(inbound.status).toBe(201);
			await settle();
			expect(lastWebhookValue()).toMatchObject({
				messages: [{ type: "image", image: { id: media.id, mime_type: "image/png", sha256: media.sha256 } }],
			});

			// The media id the webhook carries resolves through the Graph API the app uses.
			const download = await fixture.app.request(`/v25.0/${media.id}?phone_number_id=${fixture.phoneNumberId}`, {
				headers: TEST_AUTH_HEADERS,
			});

			expect(download.status).toBe(200);
			expect(await readJson<{ mime_type: string }>(download)).toMatchObject({ mime_type: "image/png" });
		});

		it("reports a media id that resolves to nothing", async () => {
			const response = await simulateInbound({ type: "image", media: { id: "404" } });
			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(404);
			expect(body.error.code).toBe("unknown_media");
		});
	});

	describe("GET /api/media/:id", () => {
		it("describes an uploaded object so the UI can render it inline", async () => {
			const form = new FormData();

			form.set("phoneNumberId", fixture.phoneNumberId);
			form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "photo.png", { type: "image/png" }));

			const { data: uploaded } = await parseBody(
				inboundMediaResponseSchema,
				await fixture.app.request("/api/inbound-media", { method: "POST", body: form }),
			);
			const response = await fixture.app.request(`/api/media/${uploaded.id}`);

			expect(response.status).toBe(200);

			const { data: media } = await parseBody(mediaResponseSchema, response);

			expect(media).toEqual({
				id: uploaded.id,
				url: stringMatching(/^http:\/\/localhost:9999\/whaloc-media\/[\w-]+$/),
				mimeType: "image/png",
				sha256: uploaded.sha256,
				fileSize: 4,
			});

			// The URL it hands out is the one the browser (and the app under test) can fetch.
			const mediaUrl = new URL(media.url);
			const bytes = await fixture.app.request(mediaUrl.pathname);

			expect(bytes.status).toBe(200);
			expect(bytes.headers.get("content-type")).toBe("image/png");
		});

		it("reports an unknown media id", async () => {
			const response = await fixture.app.request("/api/media/404");
			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(404);
			expect(body.error.code).toBe("unknown_media");
		});
	});

	describe("conversations", () => {
		it("lists them newest first, with the last message", async () => {
			await simulateInbound({ type: "text", text: { body: "one" } });
			await simulateInbound({ type: "text", text: { body: "two" } });

			const body = await get(
				conversationListResponseSchema,
				`/api/conversations?phoneNumberId=${fixture.phoneNumberId}`,
			);

			expect(body.data).toHaveLength(1);
			expect(body.data[0]).toMatchObject({
				id: `${fixture.phoneNumberId}:16505551234`,
				messageCount: 2,
				lastMessage: { payload: { text: { body: "two" } } },
			});
		});

		it("pages the history newest last", async () => {
			for (const [index, body] of ["one", "two", "three"].entries()) {
				await simulateInbound({
					type: "text",
					text: { body },
					timestamp: `2026-06-12T12:00:0${String(index)}.000Z`,
				});
			}

			const first = await fixture.app.request(
				`/api/conversations/${fixture.phoneNumberId}:16505551234/messages?limit=2`,
			);
			const page = await parseBody(conversationMessagesResponseSchema, first);

			expect(page.data.map(message => message.payload["text"])).toEqual([{ body: "two" }, { body: "three" }]);
			expect(page.paging.before).toBe(page.data[0]!.timestamp);

			const older = await fixture.app.request(
				`/api/conversations/${fixture.phoneNumberId}:16505551234/messages?limit=2&before=${encodeURIComponent(page.paging.before!)}`,
			);

			const olderPage = await parseBody(conversationMessagesResponseSchema, older);

			expect(olderPage.data).toHaveLength(1);
		});

		it("rejects an id that is not a conversation", async () => {
			const response = await fixture.app.request("/api/conversations/nonsense/messages");
			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(400);
			expect(body.error.code).toBe("invalid_conversation");
		});
	});

	describe("POST /api/messages/:id/status", () => {
		async function sendOutbound(): Promise<string> {
			const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({
					messaging_product: "whatsapp",
					to: "16505551234",
					type: "text",
					text: { body: "Hi" },
				}),
			});
			const body = await readJson<{ messages: [{ id: string }] }>(response);

			await settle();

			return body.messages[0].id;
		}

		it("marks a message read", async () => {
			const id = await sendOutbound();
			const response = await post(`/api/messages/${encodeURIComponent(id)}/status`, { status: "read" });

			expect(response.status).toBe(200);
			const body = await parseBody(messageResponseSchema, response);

			expect(body.data.status).toBe("read");

			await settle();

			expect(lastWebhookValue()).toMatchObject({ statuses: [{ id, status: "read" }] });
		});

		it("fails a message with the preset the caller picked", async () => {
			const id = await sendOutbound();
			const response = await post(`/api/messages/${encodeURIComponent(id)}/status`, {
				status: "failed",
				errorCode: 131_047,
			});

			const body = await parseBody(messageResponseSchema, response);

			expect(body.data.error).toMatchObject({ code: 131_047 });

			await settle();

			expect(lastWebhookValue()).toMatchObject({
				statuses: [{ status: "failed", errors: [{ code: 131_047, href: anyString() }] }],
			});
		});

		it("refuses a transition that would move a message backwards", async () => {
			const id = await sendOutbound();

			await post(`/api/messages/${encodeURIComponent(id)}/status`, { status: "read" });

			const response = await post(`/api/messages/${encodeURIComponent(id)}/status`, { status: "delivered" });

			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(409);
			expect(body.error.code).toBe("invalid_transition");
		});

		it("rejects an unknown error code", async () => {
			const id = await sendOutbound();
			const response = await post(`/api/messages/${encodeURIComponent(id)}/status`, {
				status: "failed",
				errorCode: 999,
			});

			expect(response.status).toBe(400);
		});
	});

	describe("GET /api/message-error-presets", () => {
		it("serves the presets the fail action accepts", async () => {
			const response = await fixture.app.request("/api/message-error-presets");

			expect(response.status).toBe(200);

			const { data } = await parseBody(messageErrorPresetListResponseSchema, response);

			expect(data.map(preset => preset.code)).toEqual([...MESSAGE_ERROR_CODES]);
			expect(data[0]).toMatchObject({ code: 131_049, title: anyString(), details: anyString() });
		});
	});

	describe("templates", () => {
		async function createTemplate(name = "order_update"): Promise<string> {
			const response = await fixture.app.request(`/v25.0/${fixture.wabaId}/message_templates`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({
					name,
					language: "en_US",
					category: "UTILITY",
					components: [{ type: "BODY", text: "Hi" }],
				}),
			});

			const created = await readJson<{ id: string }>(response);

			return created.id;
		}

		it("lists them, the seeded one included", async () => {
			await createTemplate();

			const body = await get(templateListResponseSchema, `/api/templates?wabaId=${fixture.wabaId}`);

			expect(body.data).toHaveLength(2);
			expect(body.data.find(template => template.name === "order_update")).toMatchObject({ status: "PENDING" });
		});

		it("filters by status", async () => {
			await createTemplate();

			const body = await get(templateListResponseSchema, "/api/templates?status=APPROVED");

			// A created template is `PENDING`; the seeded one is `APPROVED` from boot (SPEC §7).
			expect(body.data.map(template => template.name)).toEqual(["hello_whaloc"]);
		});

		/**
		 * The filter bar's parameters (SPEC §2.8): the same narrowing the Graph listing does, so
		 * the UI never has to filter a page the server already answered.
		 */
		it("filters by category, language and a name-or-content search", async () => {
			await createTemplate("payment_reminder");

			// Sorted: two templates created in the same millisecond fall back to their (random) id.
			async function names(query: string): Promise<string[]> {
				const body = await get(templateListResponseSchema, `/api/templates${query}`);

				return body.data.map(template => template.name).toSorted((a, b) => a.localeCompare(b));
			}

			expect(await names("?category=UTILITY")).toEqual(["hello_whaloc", "payment_reminder"]);
			expect(await names("?category=MARKETING")).toEqual([]);
			expect(await names("?language=en_US")).toEqual(["payment_reminder"]);
			expect(await names("?search=payment")).toEqual(["payment_reminder"]);
			// The seeded template's body says "Hello from whaloc!", so content matches too.
			expect(await names("?search=Hello%20from")).toEqual(["hello_whaloc"]);
			expect(await names("?name=payment_reminder&status=PENDING")).toEqual(["payment_reminder"]);
		});

		it("rejects a filter value it does not know", async () => {
			const response = await fixture.app.request("/api/templates?status=NOT_A_STATUS");

			expect(response.status).toBe(400);
			expect(await readJson<ControlError>(response)).toMatchObject({ error: { code: "invalid_request" } });
		});

		it("approves one and emits the status update", async () => {
			const id = await createTemplate();
			const response = await post(`/api/templates/${id}/approve`);

			const body = await parseBody(templateResponseSchema, response);

			expect(body.data.status).toBe("APPROVED");

			await settle();

			expect(lastWebhookValue()).toMatchObject({ event: "APPROVED", message_template_id: Number(id) });
			expect(capture.requests.at(-1)!.body).toContain(`"message_template_id":${id}`);
		});

		it("rejects one with rejection_info", async () => {
			const id = await createTemplate();
			const response = await post(`/api/templates/${id}/reject`, {
				reason: "INVALID_FORMAT",
				rejectionInfo: { reason: "Adjacent parameters.", recommendation: "Separate them." },
			});

			const body = await parseBody(templateResponseSchema, response);

			expect(body.data).toMatchObject({ status: "REJECTED", rejectedReason: "INVALID_FORMAT" });

			await settle();

			expect(lastWebhookValue()).toMatchObject({
				event: "REJECTED",
				rejection_info: { reason: "Adjacent parameters.", recommendation: "Separate them." },
			});
		});

		it("rejects one with the defaults when the body is left out", async () => {
			const id = await createTemplate();
			const response = await fixture.app.request(`/api/templates/${id}/reject`, { method: "POST" });

			const body = await parseBody(templateResponseSchema, response);

			expect(response.status).toBe(200);
			expect(body.data.rejectedReason).toBe("INVALID_FORMAT");
		});

		it("pauses one", async () => {
			const id = await createTemplate();

			const body = await parseBody(templateResponseSchema, await post(`/api/templates/${id}/pause`));

			expect(body.data.status).toBe("PAUSED");
		});

		it("updates the quality score and emits the quality update", async () => {
			const id = await createTemplate();
			const response = await post(`/api/templates/${id}/quality`, { qualityScore: "YELLOW" });

			const body = await parseBody(templateResponseSchema, response);

			expect(body.data.qualityScore).toBe("YELLOW");

			await settle();

			expect(lastWebhookValue()).toMatchObject({
				previous_quality_score: "UNKNOWN",
				new_quality_score: "YELLOW",
				message_template_id: Number(id),
			});
		});

		it("reports an unknown template", async () => {
			const response = await post("/api/templates/404/approve");
			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(404);
			expect(body.error.code).toBe("unknown_template");
		});
	});

	describe("webhook deliveries", () => {
		it("lists them newest first and pages backwards", async () => {
			await simulateInbound({ type: "text", text: { body: "one" } });
			await simulateInbound({ type: "text", text: { body: "two" } });
			await settle();

			const page = await get(webhookDeliveryListResponseSchema, "/api/webhook-deliveries?limit=1");

			expect(page.data).toHaveLength(1);
			expect(page.data[0]).toMatchObject({ eventType: "messages", url: capture.url, responseStatus: 200 });
			expect(page.data[0]!.requestBody).toContain("two");
			expect(page.paging.before).toBe(page.data[0]!.createdAt);
		});

		it("redelivers a stored payload as a new attempt", async () => {
			await simulateInbound({ type: "text", text: { body: "one" } });
			await settle();

			const listed = await get(webhookDeliveryListResponseSchema, "/api/webhook-deliveries");
			const [delivery] = listed.data;
			const response = await post(`/api/webhook-deliveries/${delivery!.id}/redeliver`);

			expect(response.status).toBe(201);

			const { data: attempts } = await parseBody(webhookDeliveryAttemptsResponseSchema, response);

			expect(attempts).toHaveLength(1);
			expect(attempts[0]!.requestBody).toBe(delivery!.requestBody);
			expect(capture.requests).toHaveLength(2);
			expect(capture.requests[1]!.body).toBe(capture.requests[0]!.body);
		});

		it("reports an unknown delivery", async () => {
			const response = await post("/api/webhook-deliveries/404/redeliver");
			const body = await readJson<ControlError>(response);

			expect(response.status).toBe(404);
			expect(body.error.code).toBe("unknown_delivery");
		});

		it("sends a raw payload, signed like a real event", async () => {
			const response = await post("/api/webhook/raw", { object: "whatsapp_business_account", entry: [] });

			expect(response.status).toBe(201);

			const { data: attempts } = await parseBody(webhookDeliveryAttemptsResponseSchema, response);

			expect(attempts[0]).toMatchObject({ eventType: "raw", responseStatus: 200 });
			expect(capture.requests[0]!.headers["x-hub-signature-256"]).toMatch(/^sha256=/);
			expect(JSON.parse(capture.requests[0]!.body)).toEqual({ object: "whatsapp_business_account", entry: [] });
		});

		it("runs the handshake and remembers the result", async () => {
			const response = await post("/api/webhook/handshake");
			const { data } = await parseBody(handshakeResponseSchema, response);

			expect(data).toMatchObject({ ok: true, status: 200, url: capture.url });
			expect(capture.requests[0]!.query.get("hub.verify_token")).toBe("dev-verify-token");

			const state = await get(stateResponseSchema, "/api/state");

			expect(state.webhook.lastHandshake).toMatchObject({ ok: true });
		});
	});

	/**
	 * The account-level notices (SPEC §3, §5). They are emissions only, so every assertion here
	 * is about the payload that reached the receiver — and about whaloc's state *not* moving.
	 */
	describe("account-level webhooks", () => {
		/** The `value` of the change entry the capture server received. */
		function receivedValue(index = 0): Record<string, unknown> {
			const body = JSON.parse(capture.requests[index]!.body) as {
				entry: [{ id: string; time: number; changes: [{ value: Record<string, unknown>; field: string }] }];
			};

			return body.entry[0].changes[0].value;
		}

		function receivedField(index = 0): { wabaId: string; field: string } {
			const body = JSON.parse(capture.requests[index]!.body) as {
				entry: [{ id: string; changes: [{ field: string }] }];
			};

			return { wabaId: body.entry[0].id, field: body.entry[0].changes[0].field };
		}

		it("emits account_update for the chosen WABA", async () => {
			const response = await post("/api/webhook/account-update", {
				wabaId: fixture.wabaId,
				event: "VERIFIED_ACCOUNT",
				phoneNumberId: fixture.phoneNumberId,
			});

			expect(response.status).toBe(201);

			const { data: attempts } = await parseBody(webhookDeliveryAttemptsResponseSchema, response);

			expect(attempts[0]).toMatchObject({ eventType: "account_update", responseStatus: 200 });
			expect(receivedField()).toEqual({ wabaId: fixture.wabaId, field: "account_update" });
			expect(receivedValue()).toEqual({ phone_number: "5511912345678", event: "VERIFIED_ACCOUNT" });
		});

		it("leaves phone_number off when no number was named", async () => {
			await post("/api/webhook/account-update", { wabaId: fixture.wabaId, event: "ACCOUNT_DELETED" });

			expect(receivedValue()).toEqual({ event: "ACCOUNT_DELETED" });
		});

		it("carries restriction_info on an ACCOUNT_RESTRICTION", async () => {
			await post("/api/webhook/account-update", {
				wabaId: fixture.wabaId,
				event: "ACCOUNT_RESTRICTION",
				restrictionInfo: [{ restrictionType: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: "1748540794" }],
			});

			expect(receivedValue()).toEqual({
				event: "ACCOUNT_RESTRICTION",
				restriction_info: [{ restriction_type: "RESTRICTED_BIZ_INITIATED_MESSAGING", expiration: "1748540794" }],
			});
		});

		it("changes nothing about the account it describes", async () => {
			const before = await get(stateResponseSchema, "/api/state");

			await post("/api/webhook/account-update", { wabaId: fixture.wabaId, event: "ACCOUNT_VIOLATION" });

			expect(await get(stateResponseSchema, "/api/state")).toEqual(before);
		});

		it("emits business_capability_update with the limits as JSON numbers", async () => {
			const response = await post("/api/webhook/business-capability-update", {
				wabaId: fixture.wabaId,
				maxDailyConversationPerPhone: 1000,
				maxPhoneNumbersPerBusiness: 25,
			});

			expect(response.status).toBe(201);
			expect(receivedField()).toEqual({ wabaId: fixture.wabaId, field: "business_capability_update" });
			expect(receivedValue()).toEqual({
				max_daily_conversation_per_phone: 1000,
				max_phone_numbers_per_business: 25,
			});
		});

		it("refuses an unknown WABA, and a number belonging to another one", async () => {
			const unknownWaba = await post("/api/webhook/account-update", {
				wabaId: "999999999999999",
				event: "VERIFIED_ACCOUNT",
			});

			const unknownWabaBody = await readJson<ControlError>(unknownWaba);

			expect(unknownWaba.status).toBe(404);
			expect(unknownWabaBody.error.code).toBe("unknown_waba");

			const otherWaba = await parseBody(wabaResponseSchema, await post("/api/wabas", { name: "Another business" }));
			const mismatched = await post("/api/webhook/account-update", {
				wabaId: otherWaba.data.id,
				event: "VERIFIED_ACCOUNT",
				phoneNumberId: fixture.phoneNumberId,
			});

			const mismatchedBody = await readJson<ControlError>(mismatched);

			expect(mismatched.status).toBe(400);
			expect(mismatchedBody.error.code).toBe("phone_number_waba_mismatch");
		});
	});

	describe("POST /api/phone-numbers/:id/quality", () => {
		it("updates the rating without announcing it by default", async () => {
			const response = await post(`/api/phone-numbers/${fixture.phoneNumberId}/quality`, { qualityRating: "RED" });

			expect(response.status).toBe(200);
			await settle();
			expect(capture.requests).toHaveLength(0);

			const state = await get(stateResponseSchema, "/api/state");

			expect(state.wabas[0]!.phoneNumbers[0]!.qualityRating).toBe("RED");
		});

		it("emits phone_number_quality_update when asked", async () => {
			await post(`/api/phone-numbers/${fixture.phoneNumberId}/quality`, {
				throughputLevel: "HIGH",
				emitWebhook: true,
			});
			await settle();

			// The tier moved (STANDARD → HIGH), so `old_limit` rides along; and Meta replaces
			// `current_limit` with `max_daily_conversations_per_business` in February 2026, so
			// both spellings go out carrying the same tier.
			expect(lastWebhookValue()).toEqual({
				display_phone_number: "5511912345678",
				event: "THROUGHPUT_UPGRADE",
				old_limit: "TIER_1K",
				current_limit: "TIER_UNLIMITED",
				max_daily_conversations_per_business: "TIER_UNLIMITED",
			});
		});

		it("leaves old_limit off when the tier did not move", async () => {
			await post(`/api/phone-numbers/${fixture.phoneNumberId}/quality`, {
				qualityRating: "YELLOW",
				emitWebhook: true,
			});
			await settle();

			const value = lastWebhookValue();

			expect(value).not.toHaveProperty("old_limit");
			expect(value).toMatchObject({ current_limit: "TIER_1K", max_daily_conversations_per_business: "TIER_1K" });
		});

		it("honors an explicit event and limit", async () => {
			await post(`/api/phone-numbers/${fixture.phoneNumberId}/quality`, {
				qualityRating: "YELLOW",
				emitWebhook: true,
				event: "FLAGGED",
				currentLimit: "TIER_250",
			});
			await settle();

			expect(lastWebhookValue()).toMatchObject({ event: "FLAGGED", current_limit: "TIER_250" });
		});

		it("reports an unknown phone number", async () => {
			const response = await post("/api/phone-numbers/404/quality", { qualityRating: "RED" });

			expect(response.status).toBe(404);
		});
	});

	describe("POST /api/reset", () => {
		it("wipes everything and seeds it again", async () => {
			await simulateInbound({ type: "text", text: { body: "one" } });
			await settle();

			const response = await post("/api/reset");

			expect(response.status).toBe(200);

			const { data } = await parseBody(resetResponseSchema, response);

			// The ids are derived from the seed, so they survive the wipe (SPEC §7).
			expect(data.wabas[0]).toMatchObject({ id: fixture.wabaId, phoneNumbers: [{ id: fixture.phoneNumberId }] });

			const conversations = await get(conversationListResponseSchema, "/api/conversations");
			const deliveries = await get(webhookDeliveryListResponseSchema, "/api/webhook-deliveries");
			const contacts = await get(contactListResponseSchema, "/api/contacts");

			expect(conversations.data).toEqual([]);
			expect(deliveries.data).toEqual([]);
			expect(contacts.data.map(contact => contact.waId)).toEqual(["5571990000001", "5571990000002"]);
		});

		it("cancels the ladders that were still running", async () => {
			await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({ messaging_product: "whatsapp", to: "16505551234", type: "text", text: { body: "Hi" } }),
			});
			await settle();

			expect(fixture.services.domain.statusLadder.pendingCount).toBe(1);

			await post("/api/reset");

			expect(fixture.services.domain.statusLadder.pendingCount).toBe(0);
		});
	});

	it("answers a bad JSON body with the control plane's error shape", async () => {
		const response = await fixture.app.request("/api/inbound", {
			method: "POST",
			body: "{not json",
			headers: { "content-type": "application/json" },
		});

		const body = await readJson<ControlError>(response);

		expect(response.status).toBe(400);
		expect(body.error.code).toBe("invalid_json");
	});

	it("has no bearer authentication in front of it", async () => {
		// Unlike the Graph surface (SPEC §1.9), the control plane is whaloc's own API and the
		// browser UI has no token to present.
		const response = await fixture.app.request("/api/state");

		expect(response.status).toBe(200);
	});
});
