import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FBTRACE_ID_PATTERN } from "../domain/index.ts";
import { anyString, readJson, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

interface ErrorEnvelope {
	error: { message: string; type: string; code: number; error_subcode?: number; fbtrace_id: string };
}

describe("graph api surface", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	function get(path: string, headers: Record<string, string> = TEST_AUTH_HEADERS) {
		return fixture.app.request(path, { headers });
	}

	function createTemplate(version: string, language: string) {
		return fixture.app.request(`/${version}/${fixture.wabaId}/message_templates`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({
				name: "paged",
				language,
				category: "UTILITY",
				components: [{ type: "BODY", text: "Hello" }],
			}),
		});
	}

	describe("version-agnostic mounting (SPEC §1.1)", () => {
		it.each(["v25.0", "v99.9", "v1.0"])("answers under /%s", async version => {
			const response = await get(`/${version}/${fixture.phoneNumberId}`);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ id: fixture.phoneNumberId });
		});

		it.each(["v25", "graph", "v25.0.1"])("does not answer under the prefix /%s", async prefix => {
			const response = await get(`/${prefix}/${fixture.phoneNumberId}`);

			expect(response.status).toBe(404);
		});

		it("echoes the version the caller used in paging.next", async () => {
			await createTemplate("v33.7", "en_US");
			await createTemplate("v33.7", "pt_BR");

			const response = await get(`/v33.7/${fixture.wabaId}/message_templates?limit=1`);
			const body = await readJson<{ paging: { next: string } }>(response);

			expect(body.paging.next).toContain("/v33.7/");
		});
	});

	describe("bearer auth (SPEC §1.9)", () => {
		it("rejects a request without an Authorization header", async () => {
			const response = await get(`/v25.0/${fixture.phoneNumberId}`, {});

			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				error: {
					message: "Invalid OAuth access token - Cannot parse access token",
					type: "OAuthException",
					code: 190,
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
		});

		it.each(["", "Bearer", "Bearer ", "Basic abc", "token-without-scheme"])(
			"rejects the Authorization header %o",
			async authorization => {
				const response = await get(`/v25.0/${fixture.phoneNumberId}`, { authorization });

				expect(response.status).toBe(401);
			},
		);

		it.each(["Bearer x", "bearer EAABwzLixnjYBO", "BEARER  spaced-out"])(
			"accepts any non-empty token: %o",
			async authorization => {
				const response = await get(`/v25.0/${fixture.phoneNumberId}`, { authorization });

				expect(response.status).toBe(200);
			},
		);
	});

	describe("error envelope (SPEC §1.4)", () => {
		it("reports an unknown object as 400 / code 100 / subcode 33, never 404", async () => {
			const response = await get("/v25.0/999999999999999");

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: {
					message:
						"Unsupported get request. Object with ID '999999999999999' does not exist, cannot be loaded " +
						"due to missing permissions, or does not support this operation. Please read the Graph API " +
						"documentation at https://developers.facebook.com/docs/graph-api",
					type: "OAuthException",
					code: 100,
					error_subcode: 33,
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
		});

		it("tags every response with x-fb-request-id, success or failure", async () => {
			const ok = await get(`/v25.0/${fixture.phoneNumberId}`);
			const failed = await get("/v25.0/999999999999999");

			expect(ok.headers.get("x-fb-request-id")).toMatch(FBTRACE_ID_PATTERN);
			expect(failed.headers.get("x-fb-request-id")).toMatch(FBTRACE_ID_PATTERN);
		});

		it("reuses the request id as the envelope's fbtrace_id", async () => {
			const response = await get("/v25.0/999999999999999");
			const body = await readJson<ErrorEnvelope>(response);

			expect(body.error.fbtrace_id).toBe(response.headers.get("x-fb-request-id"));
		});

		it("hands out a different fbtrace_id per request", async () => {
			const first = await get("/v25.0/999999999999999");
			const second = await get("/v25.0/999999999999999");

			expect(first.headers.get("x-fb-request-id")).not.toBe(second.headers.get("x-fb-request-id"));
		});
	});

	describe("GET /:id dispatch (SPEC §2, rows 1-4)", () => {
		it("serves a phone number with every field, lifecycle included", async () => {
			const response = await get(`/v25.0/${fixture.phoneNumberId}`);

			expect(await response.json()).toEqual({
				verified_name: "whaloc Test Business",
				display_phone_number: "+55 11 91234-5678",
				quality_rating: "GREEN",
				throughput: { level: "STANDARD" },
				status: "CONNECTED",
				code_verification_status: "VERIFIED",
				name_status: "APPROVED",
				id: fixture.phoneNumberId,
			});
		});

		it("honors fields on a phone number, always keeping id", async () => {
			const response = await get(`/v25.0/${fixture.phoneNumberId}?fields=verified_name,display_phone_number`);

			expect(await response.json()).toEqual({
				verified_name: "whaloc Test Business",
				display_phone_number: "+55 11 91234-5678",
				id: fixture.phoneNumberId,
			});
		});

		it("flattens a nested field selector", async () => {
			const nested = "throughput{level}";
			const response = await get(`/v25.0/${fixture.phoneNumberId}?fields=${nested}`);

			expect(await response.json()).toEqual({ throughput: { level: "STANDARD" }, id: fixture.phoneNumberId });
		});

		it("ignores fields it does not know", async () => {
			const response = await get(`/v25.0/${fixture.phoneNumberId}?fields=verified_name,nope`);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ verified_name: "whaloc Test Business", id: fixture.phoneNumberId });
		});

		it("serves a WABA", async () => {
			const whole = await get(`/v25.0/${fixture.wabaId}`);
			const projected = await get(`/v25.0/${fixture.wabaId}?fields=id`);

			expect(await whole.json()).toEqual({ name: "whaloc Test Business", id: fixture.wabaId });
			expect(await projected.json()).toEqual({ id: fixture.wabaId });
		});

		it("never blanks the display phone number (SPEC §2.1)", async () => {
			const response = await get(`/v25.0/${fixture.phoneNumberId}`);
			const body = await readJson<{ display_phone_number: string }>(response);

			expect(body.display_phone_number.trim()).not.toBe("");
		});
	});

	describe("GET /:wabaId/phone_numbers (SPEC §2.11)", () => {
		it("lists the numbers of a WABA", async () => {
			const response = await get(`/v25.0/${fixture.wabaId}/phone_numbers`);

			expect(await response.json()).toEqual({
				data: [
					{
						id: fixture.phoneNumberId,
						display_phone_number: "+55 11 91234-5678",
						verified_name: "whaloc Test Business",
						quality_rating: "GREEN",
						throughput: { level: "STANDARD" },
						status: "CONNECTED",
						code_verification_status: "VERIFIED",
						name_status: "APPROVED",
					},
				],
				paging: { cursors: { before: anyString(), after: anyString() } },
			});
		});

		it("reports an unknown WABA as a missing object", async () => {
			const response = await get("/v25.0/404404404404404/phone_numbers");

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});
});
