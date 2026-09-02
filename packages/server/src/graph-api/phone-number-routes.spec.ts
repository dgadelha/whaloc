import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveVerificationCode, FBTRACE_ID_PATTERN, META_ID_PATTERN } from "../domain/index.ts";
import { readJson, stringContaining, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

interface ErrorEnvelope {
	error: {
		message: string;
		type: string;
		code: number;
		error_subcode?: number;
		error_data?: { messaging_product: string; details: string };
		fbtrace_id: string;
	};
}

interface PhoneNumberNode {
	id: string;
	display_phone_number: string;
	verified_name: string;
	quality_rating: string;
	status: string;
	code_verification_status: string;
	name_status: string;
}

/**
 * Phone number management end to end (SPEC §2.13–§2.17, §4).
 *
 * The fixture is the real composed app, so a number created here is one the send route and the
 * control plane see too — which is the whole point of the ladder: it is the send gate that
 * proves a number is registered, not a field in a response.
 */
describe("phone number management", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	function get(path: string) {
		return fixture.app.request(path, { headers: TEST_AUTH_HEADERS });
	}

	function post(path: string, body?: unknown) {
		return fixture.app.request(path, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			...(body !== undefined && { body: JSON.stringify(body) }),
		});
	}

	/** Adds a number to the seeded WABA and hands back its id. */
	async function addNumber(body: Record<string, unknown>): Promise<string> {
		const response = await post(`/v25.0/${fixture.wabaId}/phone_numbers`, {
			phone_number: "16315551000",
			verified_name: "Jasper's Market",
			...body,
		});

		expect(response.status).toBe(200);

		const created = await readJson<{ id: string }>(response);

		return created.id;
	}

	function sendText(phoneNumberId: string) {
		return post(`/v25.0/${phoneNumberId}/messages`, {
			messaging_product: "whatsapp",
			to: "5571990000001",
			type: "text",
			text: { body: "olá" },
		});
	}

	async function nodeOf(phoneNumberId: string): Promise<PhoneNumberNode> {
		return readJson<PhoneNumberNode>(await get(`/v25.0/${phoneNumberId}`));
	}

	describe("POST /:wabaId/phone_numbers (SPEC §2.13)", () => {
		it("answers with the digit-only id of a number that starts unverified", async () => {
			const response = await post(`/v25.0/${fixture.wabaId}/phone_numbers`, {
				phone_number: "16315551000",
				verified_name: "Jasper's Market",
				cc: "1",
			});

			expect(response.status).toBe(200);
			const body = await readJson<{ id: string }>(response);

			expect(body).toEqual({ id: stringMatching(META_ID_PATTERN) });
			expect(await nodeOf(body.id)).toMatchObject({
				display_phone_number: "+16315551000",
				verified_name: "Jasper's Market",
				quality_rating: "UNKNOWN",
				status: "UNVERIFIED",
				code_verification_status: "NOT_VERIFIED",
				name_status: "PENDING_REVIEW",
			});
		});

		it("shows up in the WABA's listing", async () => {
			const id = await addNumber({});
			const body = await readJson<{ data: PhoneNumberNode[] }>(await get(`/v25.0/${fixture.wabaId}/phone_numbers`));

			expect(body.data.map(node => node.id)).toEqual([fixture.phoneNumberId, id]);
		});

		it("prepends cc only when the number does not already carry it", async () => {
			const id = await addNumber({ phone_number: "6315551001", cc: "1" });

			expect(await nodeOf(id)).toMatchObject({ display_phone_number: "+16315551001" });
		});

		it.each(["+16315551000", "0631555100", "163", "not-a-number", "1631555100012345"])(
			"rejects the malformed phone_number %o with Meta's own sentence",
			async phoneNumber => {
				const response = await post(`/v25.0/${fixture.wabaId}/phone_numbers`, {
					phone_number: phoneNumber,
					verified_name: "Jasper's Market",
				});

				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({
					error: {
						message: "Invalid parameter: phone_number must be in E.164 format",
						type: "OAuthException",
						code: 100,
						fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
					},
				});
			},
		);

		it.each([
			["a verified_name that is too short", { verified_name: "x" }],
			["a missing verified_name", { verified_name: undefined }],
			["a cc that is not a dial code", { cc: "abc" }],
		])("rejects %s as an invalid parameter", async (_name, body) => {
			const response = await post(`/v25.0/${fixture.wabaId}/phone_numbers`, {
				phone_number: "16315551000",
				verified_name: "Jasper's Market",
				...body,
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { message: "(#100) Invalid parameter", code: 100 } });
		});

		it("answers 409 for a number already registered under another WABA", async () => {
			await addNumber({});

			// The rule spans every account: one MSISDN is one WhatsApp number, wherever it sits.
			const other = await fixture.services.repositories.wabas.insert({ id: "102290129340398", name: "Other" });
			const duplicate = await post(`/v25.0/${other.id}/phone_numbers`, {
				phone_number: "16315551000",
				verified_name: "Someone Else",
			});

			expect(duplicate.status).toBe(409);
			expect(await duplicate.json()).toEqual({
				error: {
					message: "Phone number is already registered with WhatsApp Business",
					type: "GraphMethodException",
					code: 100,
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
		});

		it("compares by digits, so the seeded number's own MSISDN is a duplicate too", async () => {
			const duplicate = await post(`/v25.0/${fixture.wabaId}/phone_numbers`, {
				phone_number: "5511912345678",
				verified_name: "Copy Cat",
			});

			expect(duplicate.status).toBe(409);
		});

		it("reports an unknown WABA as whaloc's uniform missing object, not the spec's 404", async () => {
			const response = await post("/v25.0/404404404404404/phone_numbers", {
				phone_number: "16315551000",
				verified_name: "Jasper's Market",
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});

		it("takes a pre-verified number straight to PENDING/VERIFIED", async () => {
			const id = await addNumber({ phone_number: "16315551002", preverified_id: "preverified_12345" });

			expect(await nodeOf(id)).toMatchObject({ status: "PENDING", code_verification_status: "VERIFIED" });
		});

		it("accepts migrate_phone_number without changing the ladder", async () => {
			const id = await addNumber({ phone_number: "16315551003", migrate_phone_number: true });

			expect(await nodeOf(id)).toMatchObject({ status: "UNVERIFIED" });
		});
	});

	describe("the registration ladder (SPEC §4)", () => {
		it("walks request_code → verify_code → register, and only then sends", async () => {
			const id = await addNumber({});

			const blocked = await sendText(id);

			expect(blocked.status).toBe(400);
			const envelope = await readJson<ErrorEnvelope>(blocked);

			expect(envelope.error).toMatchObject({
				message: "(#133010) Phone number not registered",
				code: 133_010,
				error_data: { details: stringContaining("is not registered on the WhatsApp Business Platform") },
			});

			const requested = await post(`/v25.0/${id}/request_code`, { code_method: "SMS", language: "en_US" });

			expect(requested.status).toBe(200);

			// The code is never in a Graph response: whaloc is the phone, so it is read through
			// the control plane (SPEC §5).
			const requestedBody = await requested.text();

			expect(JSON.parse(requestedBody)).toEqual({ success: true });
			expect(requestedBody).not.toContain(deriveVerificationCode(id));

			const wrong = await post(`/v25.0/${id}/verify_code`, { code: "000000" });

			expect(wrong.status).toBe(400);
			expect(await wrong.json()).toMatchObject({
				error: {
					message: "(#100) Invalid parameter",
					code: 100,
					error_data: { details: stringContaining("not the verification code") },
				},
			});

			const unverified = await post(`/v25.0/${id}/register`, { messaging_product: "whatsapp" });

			expect(unverified.status).toBe(400);
			expect(await unverified.json()).toMatchObject({
				error: { message: "(#133006) Phone number re-verification needed", code: 133_006 },
			});

			const verified = await post(`/v25.0/${id}/verify_code`, { code: deriveVerificationCode(id) });

			expect(verified.status).toBe(200);
			expect(await nodeOf(id)).toMatchObject({ status: "PENDING", code_verification_status: "VERIFIED" });

			const registered = await post(`/v25.0/${id}/register`, { messaging_product: "whatsapp", pin: "123456" });

			expect(registered.status).toBe(200);
			expect(await registered.json()).toEqual({ success: true });
			expect(await nodeOf(id)).toMatchObject({ status: "CONNECTED", name_status: "APPROVED" });

			const sent = await sendText(id);

			expect(sent.status).toBe(200);
			expect(await sent.json()).toMatchObject({ messages: [{ message_status: "accepted" }] });
		});

		it("hands out the same six digits every time it is asked", async () => {
			const id = await addNumber({});

			await post(`/v25.0/${id}/request_code`, { code_method: "SMS", language: "en_US" });
			await post(`/v25.0/${id}/request_code`, { code_method: "VOICE", language: "pt_BR" });

			const verified = await post(`/v25.0/${id}/verify_code`, { code: deriveVerificationCode(id) });

			expect(deriveVerificationCode(id)).toMatch(/^\d{6}$/);
			expect(verified.status).toBe(200);
		});

		it("refuses verify_code when nothing was requested", async () => {
			const id = await addNumber({});
			const response = await post(`/v25.0/${id}/verify_code`, { code: deriveVerificationCode(id) });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { error_data: { details: stringContaining("has no verification to confirm") } },
			});
		});

		it("clears the pending code once it is confirmed", async () => {
			const id = await addNumber({});

			await post(`/v25.0/${id}/request_code`, { code_method: "SMS", language: "en_US" });
			await post(`/v25.0/${id}/verify_code`, { code: deriveVerificationCode(id) });

			const again = await post(`/v25.0/${id}/verify_code`, { code: deriveVerificationCode(id) });

			expect(again.status).toBe(400);
			expect(await again.json()).toMatchObject({
				error: { error_data: { details: stringContaining("has no verification to confirm") } },
			});
		});

		it("rejects a register without messaging_product", async () => {
			const id = await addNumber({ preverified_id: "preverified_12345" });
			const response = await post(`/v25.0/${id}/register`, {});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { error_data: { details: stringContaining("messaging_product must be whatsapp") } },
			});
		});

		it("deregisters a seeded number, which stops its sends with 133010", async () => {
			const before = await sendText(fixture.phoneNumberId);

			expect(before.status).toBe(200);

			const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/deregister`, {
				method: "POST",
				headers: TEST_AUTH_HEADERS,
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			expect(await nodeOf(fixture.phoneNumberId)).toMatchObject({
				status: "DISCONNECTED",
				// Deregistering does not un-verify the number: registering again is one call.
				code_verification_status: "VERIFIED",
			});

			const after = await sendText(fixture.phoneNumberId);

			expect(after.status).toBe(400);
			expect(await after.json()).toMatchObject({ error: { code: 133_010 } });

			const registered = await post(`/v25.0/${fixture.phoneNumberId}/register`, { messaging_product: "whatsapp" });

			expect(registered.status).toBe(200);

			const sendingAgain = await sendText(fixture.phoneNumberId);

			expect(sendingAgain.status).toBe(200);
		});

		it.each(["request_code", "verify_code", "register", "deregister"])(
			"reports an unknown id on %s as a missing object",
			async action => {
				const response = await post(`/v25.0/999999999999999/${action}`, {
					code_method: "SMS",
					language: "en_US",
					code: "123456",
					messaging_product: "whatsapp",
				});

				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
			},
		);
	});

	describe("field exposure", () => {
		it("honors fields on the listing, always keeping id", async () => {
			const response = await get(`/v25.0/${fixture.wabaId}/phone_numbers?fields=display_phone_number,status`);

			expect(await response.json()).toMatchObject({
				data: [{ display_phone_number: "+55 11 91234-5678", status: "CONNECTED", id: fixture.phoneNumberId }],
			});
		});

		it("leaves the four fields the consumer asks for untouched", async () => {
			const response = await get(
				`/v25.0/${fixture.phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,throughput`,
			);

			expect(await response.json()).toEqual({
				verified_name: "whaloc Test Business",
				display_phone_number: "+55 11 91234-5678",
				quality_rating: "GREEN",
				throughput: { level: "STANDARD" },
				id: fixture.phoneNumberId,
			});
		});

		it.each(["v25.0", "v99.9", "v1.0"])("answers the ladder under /%s too", async version => {
			const created = await post(`/${version}/${fixture.wabaId}/phone_numbers`, {
				phone_number: "16315559999",
				verified_name: "Any Version",
			});

			expect(created.status).toBe(200);
			const body = await readJson<{ id: string }>(created);
			const requested = await post(`/${version}/${body.id}/request_code`, { code_method: "SMS", language: "en_US" });

			expect(requested.status).toBe(200);
		});
	});
});
