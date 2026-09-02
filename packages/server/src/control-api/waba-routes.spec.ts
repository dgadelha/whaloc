import {
	phoneNumberListResponseSchema,
	phoneNumberResponseSchema,
	stateResponseSchema,
	wabaListResponseSchema,
	wabaResponseSchema,
	wsEventSchema,
	type ControlError,
	type WsEvent,
} from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { output, ZodType } from "zod";
import { readJson } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * Runtime management of WABAs and phone numbers (SPEC §5).
 *
 * Two things are worth asserting beyond the CRUD: the **cascade** (deleting a WABA has to take
 * its numbers, their conversations and its templates with it, or the UI is left rendering rows
 * whose parent is gone) and the **events** (the UI is a pure WS client, so a change nobody
 * announced is a change nobody sees).
 */
describe("control plane: WABAs and phone numbers", () => {
	let fixture: TestApp;
	let events: WsEvent[];

	beforeEach(async () => {
		fixture = await createTestApp();
		events = [];
		fixture.services.domain.events.subscribe(event => {
			// Parsed on the way in: an event whose payload drifted from the shared union would
			// reach the UI as an unparseable frame, and the WS hub does not validate.
			events.push(wsEventSchema.parse(event));
		});
	});

	afterEach(async () => {
		await fixture.close();
	});

	async function parseBody<TSchema extends ZodType>(schema: TSchema, response: Response): Promise<output<TSchema>> {
		const body: unknown = await response.json();

		return schema.parse(body);
	}

	async function get<TSchema extends ZodType>(schema: TSchema, path: string): Promise<output<TSchema>> {
		return parseBody(schema, await fixture.app.request(path));
	}

	async function send(method: string, path: string, body?: unknown): Promise<Response> {
		return fixture.app.request(path, {
			method,
			...(body !== undefined && { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
		});
	}

	function eventTypes(): string[] {
		return events.map(event => event.type);
	}

	describe("WABAs", () => {
		it("lists the seeded one", async () => {
			const body = await get(wabaListResponseSchema, "/api/wabas");

			expect(body.data).toEqual([
				{
					id: fixture.wabaId,
					name: "whaloc Test Business",
					// Seeding describes accounts, not subscriptions (SPEC §2.20).
					subscribedAt: null,
					createdAt: expect.any(String) as string,
				},
			]);
		});

		it("creates one and announces it", async () => {
			const response = await send("POST", "/api/wabas", { name: "Second Business" });

			expect(response.status).toBe(201);
			const body = await parseBody(wabaResponseSchema, response);

			expect(body.data).toMatchObject({ name: "Second Business", id: expect.stringMatching(/^\d{15}$/) as string });
			expect(events).toEqual([{ type: "waba.changed", payload: { waba: body.data, event: "created" } }]);
		});

		it("honors an explicit id, and refuses one that is taken", async () => {
			const created = await send("POST", "/api/wabas", { id: "102290129340398", name: "Fixed" });

			expect(created.status).toBe(201);

			const duplicate = await send("POST", "/api/wabas", { id: "102290129340398", name: "Again" });

			expect(duplicate.status).toBe(409);
			const error = await readJson<ControlError>(duplicate);

			expect(error.error.code).toBe("duplicate_waba");
		});

		it("refuses an id another kind of object already holds", async () => {
			// `GET /{id}` dispatches by whichever store holds the id (SPEC §2), so a WABA sharing
			// one with a phone number would be permanently shadowed by it.
			const response = await send("POST", "/api/wabas", { id: fixture.phoneNumberId, name: "Shadow" });

			expect(response.status).toBe(409);
			const error = await readJson<ControlError>(response);

			expect(error.error.code).toBe("duplicate_waba");
			// The dialog that asked for the id shows this, so it has to name what holds it.
			expect(error.error.message).toContain("phone number");
		});

		it("rejects an explicit id that is not Meta-shaped", async () => {
			const letters = await send("POST", "/api/wabas", { id: "not-digits", name: "Nope" });
			const tooLong = await send("POST", "/api/wabas", { id: "1".repeat(33), name: "Nope" });

			expect([letters.status, tooLong.status]).toEqual([400, 400]);
		});

		it("renames one", async () => {
			const response = await send("PATCH", `/api/wabas/${fixture.wabaId}`, { name: "Renamed" });
			const body = await parseBody(wabaResponseSchema, response);

			expect(body.data.name).toBe("Renamed");
			expect(events).toEqual([{ type: "waba.changed", payload: { waba: body.data, event: "updated" } }]);

			const state = await get(stateResponseSchema, "/api/state");

			expect(state.wabas[0]?.name).toBe("Renamed");
		});

		it("reports an unknown id", async () => {
			const renamed = await send("PATCH", "/api/wabas/404404404404404", { name: "Nope" });
			const deleted = await send("DELETE", "/api/wabas/404404404404404");

			expect([renamed.status, deleted.status]).toEqual([404, 404]);
		});

		it("rejects a nameless create", async () => {
			const response = await send("POST", "/api/wabas", { name: "" });

			expect(response.status).toBe(400);
		});
	});

	describe("phone numbers", () => {
		it("creates one, ready to send", async () => {
			const response = await send("POST", "/api/phone-numbers", {
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+1 631-555-5555",
				verifiedName: "Jasper's Market",
			});

			expect(response.status).toBe(201);
			const body = await parseBody(phoneNumberResponseSchema, response);

			expect(body.data).toMatchObject({
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+1 631-555-5555",
				verifiedName: "Jasper's Market",
				status: "CONNECTED",
				codeVerificationStatus: "VERIFIED",
				nameStatus: "APPROVED",
				pendingVerification: null,
			});
			expect(events).toEqual([{ type: "phone_number.changed", payload: { phoneNumber: body.data, event: "created" } }]);

			const sent = await fixture.app.request(`/v25.0/${body.data.id}/messages`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({
					messaging_product: "whatsapp",
					to: "5571990000001",
					type: "text",
					text: { body: "hi" },
				}),
			});

			expect(sent.status).toBe(200);
		});

		/**
		 * The other half of the "match my production configuration" story (SPEC §5): an app whose
		 * `.env` already names a phone number id can be pointed at whaloc without editing it.
		 */
		it("honors an explicit id, and serves it on the Graph surface", async () => {
			const response = await send("POST", "/api/phone-numbers", {
				id: "150123456789012",
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+1 631-555-5555",
				verifiedName: "Jasper's Market",
			});

			expect(response.status).toBe(201);
			const body = await parseBody(phoneNumberResponseSchema, response);

			expect(body.data.id).toBe("150123456789012");

			const node = await fixture.app.request("/v25.0/150123456789012", { headers: TEST_AUTH_HEADERS });

			expect(node.status).toBe(200);
			expect(await node.json()).toMatchObject({ id: "150123456789012" });
		});

		it("refuses an explicit id another phone number already holds", async () => {
			const response = await send("POST", "/api/phone-numbers", {
				id: fixture.phoneNumberId,
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+1 631-555-5555",
				verifiedName: "Twin",
			});

			expect(response.status).toBe(409);
			const error = await readJson<ControlError>(response);

			expect(error.error.code).toBe("duplicate_phone_number");
			expect(error.error.message).toContain("already taken");
		});

		// Ids are one namespace across every store (SPEC §2), so a WABA's id is not free either.
		it("refuses an explicit id a WABA already holds", async () => {
			const response = await send("POST", "/api/phone-numbers", {
				id: fixture.wabaId,
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+1 631-555-5555",
				verifiedName: "Shadow",
			});

			expect(response.status).toBe(409);
			const error = await readJson<ControlError>(response);

			expect(error.error.message).toContain("WABA");
		});

		it("rejects an explicit id that is not Meta-shaped", async () => {
			const response = await send("POST", "/api/phone-numbers", {
				id: "abc",
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+1 631-555-5555",
				verifiedName: "Nope",
			});

			expect(response.status).toBe(400);
		});

		it("refuses a duplicate MSISDN, however it is written", async () => {
			const response = await send("POST", "/api/phone-numbers", {
				wabaId: fixture.wabaId,
				displayPhoneNumber: "5511912345678",
				verifiedName: "Copy Cat",
			});

			expect(response.status).toBe(409);
			const error = await readJson<ControlError>(response);

			expect(error.error.code).toBe("duplicate_phone_number");
		});

		it("refuses a display number with no digits, and an unknown WABA", async () => {
			const noDigits = await send("POST", "/api/phone-numbers", {
				wabaId: fixture.wabaId,
				displayPhoneNumber: "no digits here",
				verifiedName: "Nope",
			});
			const unknownWaba = await send("POST", "/api/phone-numbers", {
				wabaId: "404404404404404",
				displayPhoneNumber: "+1 631-555-0000",
				verifiedName: "Nope",
			});

			expect([noDigits.status, unknownWaba.status]).toEqual([400, 404]);
		});

		it("edits the display number and the verified name", async () => {
			const response = await send("PATCH", `/api/phone-numbers/${fixture.phoneNumberId}`, {
				displayPhoneNumber: "+55 11 90000-0000",
				verifiedName: "Renamed Business",
			});
			const body = await parseBody(phoneNumberResponseSchema, response);

			expect(body.data).toMatchObject({
				displayPhoneNumber: "+55 11 90000-0000",
				verifiedName: "Renamed Business",
			});
			expect(eventTypes()).toEqual(["phone_number.changed"]);
		});

		it("lets an edit keep its own number, and still refuses someone else's", async () => {
			const created = await send("POST", "/api/phone-numbers", {
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+1 631-555-5555",
				verifiedName: "Jasper's Market",
			});
			const body = await parseBody(phoneNumberResponseSchema, created);
			const same = await send("PATCH", `/api/phone-numbers/${body.data.id}`, {
				displayPhoneNumber: "16315555555",
			});
			const taken = await send("PATCH", `/api/phone-numbers/${body.data.id}`, {
				displayPhoneNumber: "+55 11 91234-5678",
			});

			expect(same.status).toBe(200);
			expect(taken.status).toBe(409);
		});

		it("rejects an edit that changes nothing", async () => {
			const response = await send("PATCH", `/api/phone-numbers/${fixture.phoneNumberId}`, {});

			expect(response.status).toBe(400);
		});

		it("serves the pending verification code a Graph request_code generated", async () => {
			await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/request_code`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({ code_method: "SMS", language: "en_US" }),
			});

			const state = await get(stateResponseSchema, "/api/state");

			expect(state.wabas[0]?.phoneNumbers[0]?.pendingVerification).toEqual({
				code: expect.stringMatching(/^\d{6}$/) as string,
				method: "SMS",
				language: "en_US",
			});
			// The ladder announces itself too, so Settings shows the code without a reload.
			expect(eventTypes()).toEqual(["phone_number.changed"]);
		});

		it("deletes one with its conversations, and reports it gone afterwards", async () => {
			await fixture.app.request("/api/inbound", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					phoneNumberId: fixture.phoneNumberId,
					from: "16505551234",
					type: "text",
					text: { body: "before the delete" },
				}),
			});
			await fixture.services.domain.tasks.whenIdle();

			const response = await send("DELETE", `/api/phone-numbers/${fixture.phoneNumberId}`);

			expect(response.status).toBe(200);
			const body = await parseBody(phoneNumberResponseSchema, response);

			expect(body.data.id).toBe(fixture.phoneNumberId);
			expect(events.at(-1)).toEqual({
				type: "phone_number.changed",
				payload: { phoneNumber: body.data, event: "deleted" },
			});

			const numbers = await get(phoneNumberListResponseSchema, "/api/phone-numbers");
			const orphans = await fixture.services.repositories.messages.listConversation({
				phoneNumberId: fixture.phoneNumberId,
				contactWaId: "16505551234",
			});

			expect(numbers.data).toEqual([]);
			expect(orphans).toEqual([]);

			// The Graph surface stops knowing the id, with the envelope consumers key on.
			const node = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}`, { headers: TEST_AUTH_HEADERS });

			expect(node.status).toBe(400);
			expect(await node.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});

	/**
	 * The business profile, from Settings rather than from the Graph surface (SPEC §2.19, §5).
	 * Same service behind both, so this asserts the camelCase contract the UI's form posts and
	 * that the two ways in end up in the same place.
	 */
	describe("the business profile", () => {
		function update(body: unknown, phoneNumberId = fixture.phoneNumberId): Promise<Response> {
			return send("POST", `/api/phone-numbers/${phoneNumberId}/business-profile`, body);
		}

		it("starts empty and comes back on the phone number", async () => {
			const before = await get(phoneNumberListResponseSchema, "/api/phone-numbers");

			expect(before.data[0]?.businessProfile).toEqual({});

			const response = await update({ about: "Fresh groceries.", vertical: "GROCERY" });
			const body = await parseBody(phoneNumberResponseSchema, response);

			expect(response.status).toBe(200);
			expect(body.data.businessProfile).toEqual({ about: "Fresh groceries.", vertical: "GROCERY" });
			expect(eventTypes()).toEqual(["phone_number.changed"]);
		});

		it("clears a field the form left blank", async () => {
			await update({ about: "Fresh groceries.", email: "hello@example.test" });

			const response = await update({ about: "", email: "hello@example.test", vertical: "" });
			const body = await parseBody(phoneNumberResponseSchema, response);

			expect(body.data.businessProfile).toEqual({ email: "hello@example.test" });
		});

		it("is the same profile the Graph surface serves", async () => {
			await update({ description: "A whaloc test business." });

			const graph = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/whatsapp_business_profile`, {
				headers: TEST_AUTH_HEADERS,
			});

			expect(await graph.json()).toEqual({
				data: [{ messaging_product: "whatsapp", description: "A whaloc test business." }],
			});
		});

		it("rejects a field over Meta's limit with the control plane's error shape", async () => {
			const response = await update({ about: "x".repeat(140) });

			expect(response.status).toBe(400);
			expect(await readJson<ControlError>(response)).toMatchObject({ error: { code: "invalid_request" } });
		});

		it("reports an unknown phone number", async () => {
			const response = await update({ about: "Hi" }, "888888888888888");

			expect(response.status).toBe(400);
			expect(await readJson<ControlError>(response)).toMatchObject({ error: { code: "100" } });
		});
	});

	describe("deleting a WABA", () => {
		it("cascades to its numbers, messages and templates, announcing each", async () => {
			const template = await fixture.app.request(`/v25.0/${fixture.wabaId}/message_templates`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({
					name: "order_update",
					language: "en_US",
					category: "UTILITY",
					components: [{ type: "BODY", text: "Hello" }],
				}),
			});

			expect(template.status).toBe(200);
			events = [];

			const response = await send("DELETE", `/api/wabas/${fixture.wabaId}`);

			expect(response.status).toBe(200);
			expect(eventTypes()).toEqual(["phone_number.changed", "waba.changed"]);

			const state = await get(stateResponseSchema, "/api/state");

			expect(state.wabas).toEqual([]);
			expect(await fixture.services.repositories.phoneNumbers.list()).toEqual([]);
			expect(await fixture.services.repositories.templates.listAll()).toEqual([]);
		});

		it("allows the last one to go: an empty whaloc is a legal state", async () => {
			const response = await send("DELETE", `/api/wabas/${fixture.wabaId}`);
			const state = await get(stateResponseSchema, "/api/state");

			expect(response.status).toBe(200);
			expect(state.wabas).toEqual([]);
		});

		it("leaves the seed to bring everything back on reset", async () => {
			await send("DELETE", `/api/wabas/${fixture.wabaId}`);
			await fixture.app.request("/api/reset", { method: "POST" });

			const state = await get(stateResponseSchema, "/api/state");

			expect(state.wabas[0]).toMatchObject({
				id: fixture.wabaId,
				phoneNumbers: [{ id: fixture.phoneNumberId, status: "CONNECTED" }],
			});
		});
	});
});
