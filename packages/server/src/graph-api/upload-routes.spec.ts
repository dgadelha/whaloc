import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathOf, readJson, statusOf } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, TEST_PUBLIC_URL, type TestApp } from "../testing/test-app.ts";

/**
 * The Resumable Upload API (SPEC §2.21) end to end, through the composed app — including the
 * thing that could have gone wrong quietly: **`upload:<opaque>` is one path segment with a colon
 * in it**, and it must not be swallowed by the template edit's `POST /{templateId}`.
 */

const IMAGE_BYTES = randomBytes(2048);

interface SessionResponse {
	id: string;
}

interface HandleResponse {
	h: string;
}

interface OffsetResponse {
	id: string;
	file_offset: number;
}

describe("resumable uploads (SPEC §2.21, §2.22)", () => {
	let fixture: TestApp;
	let appId: string;

	beforeEach(async () => {
		fixture = await createTestApp();
		appId = fixture.services.domain.subscribedApps.identity.id;
	});

	afterEach(async () => {
		await fixture.close();
	});

	function openSession(query: string, id = appId) {
		return fixture.app.request(`/v25.0/${id}/uploads?${query}`, { method: "POST", headers: TEST_AUTH_HEADERS });
	}

	async function sessionId(bytes: Uint8Array = IMAGE_BYTES, type = "image/jpeg"): Promise<string> {
		const response = await openSession(
			`file_length=${String(bytes.byteLength)}&file_type=${encodeURIComponent(type)}&file_name=photo.jpg`,
		);

		const body = await readJson<SessionResponse>(response);

		return body.id;
	}

	function sendChunk(id: string, bytes: Uint8Array, fileOffset = 0) {
		return fixture.app.request(`/v25.0/${id}`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, file_offset: String(fileOffset) },
			body: bytes,
		});
	}

	async function uploadedHandle(bytes: Uint8Array = IMAGE_BYTES, type = "image/jpeg"): Promise<string> {
		const id = await sessionId(bytes, type);
		const body = await readJson<HandleResponse>(await sendChunk(id, bytes));

		return body.h;
	}

	describe("POST /{appId}/uploads", () => {
		it("answers an `upload:` session id", async () => {
			const response = await openSession(`file_length=${String(IMAGE_BYTES.byteLength)}&file_type=image/jpeg`);

			const body = await readJson<SessionResponse>(response);

			expect(response.status).toBe(200);
			expect(body.id).toMatch(/^upload:[\w-]+$/);
		});

		it("accepts the parameters in the body as well as on the query string", async () => {
			const response = await fixture.app.request(`/v25.0/${appId}/uploads`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({ file_length: IMAGE_BYTES.byteLength, file_type: "image/png", file_name: "a.png" }),
			});

			expect(response.status).toBe(200);
		});

		it("accepts any digit-only app id, not just whaloc's own (documented divergence)", async () => {
			expect(await statusOf(openSession("file_length=10&file_type=image/jpeg", "1234567890"))).toBe(200);
		});

		it("refuses an app id that is not an id at all", async () => {
			const response = await openSession("file_length=10&file_type=image/jpeg", "not-an-app");

			expect(response.status).toBe(400);
			expect(await readJson<{ error: { code: number } }>(response)).toMatchObject({ error: { code: 100 } });
		});

		it("requires file_length and file_type", async () => {
			expect(await statusOf(openSession("file_type=image/jpeg"))).toBe(400);
			expect(await statusOf(openSession("file_length=10"))).toBe(400);
			expect(await statusOf(openSession("file_length=0&file_type=image/jpeg"))).toBe(400);
		});
	});

	describe("POST /upload:{id}", () => {
		it("stores the whole body at offset 0 and answers a handle", async () => {
			const id = await sessionId();
			const response = await sendChunk(id, IMAGE_BYTES);

			const body = await readJson<HandleResponse>(response);

			expect(response.status).toBe(200);
			expect(body.h).toMatch(/^4::/);
		});

		it("is routed as its own segment, never as a template edit", async () => {
			const id = await sessionId();

			// Proof by contrast: the same one-segment POST with a template id edits a template.
			expect(await statusOf(sendChunk(id, IMAGE_BYTES))).toBe(200);

			const asTemplate = await fixture.app.request(`/v25.0/${id}`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({ components: [{ type: "BODY", text: "hi" }] }),
			});

			// Still the upload route (the session is complete, so it answers with its handle),
			// not `(#100) Invalid parameter` from the template edit's schema.
			expect(await readJson<HandleResponse>(asTemplate)).toHaveProperty("h");
		});

		it("appends a second chunk at the offset the first one left", async () => {
			const id = await sessionId();
			const first = IMAGE_BYTES.subarray(0, 1000);
			const second = IMAGE_BYTES.subarray(1000);
			const partial = await sendChunk(id, first);

			expect(await readJson<OffsetResponse>(partial)).toEqual({ id, file_offset: 1000 });

			const finished = await readJson<HandleResponse>(await sendChunk(id, second, 1000));

			expect(finished.h).toMatch(/^4::/);
		});

		it("refuses a chunk that does not land on the current offset", async () => {
			const id = await sessionId();

			await sendChunk(id, IMAGE_BYTES.subarray(0, 1000));

			const response = await sendChunk(id, IMAGE_BYTES.subarray(1000), 0);

			expect(response.status).toBe(400);
			expect(await readJson<{ error: { error_data: { details: string } } }>(response)).toMatchObject({
				error: { error_data: { details: expect.stringContaining("1000") as string } },
			});
		});

		it("refuses more bytes than the session was opened for", async () => {
			const id = await sessionId(IMAGE_BYTES.subarray(0, 100));

			expect(await statusOf(sendChunk(id, IMAGE_BYTES))).toBe(400);
		});

		it("is the missing-object envelope for a session that was never opened", async () => {
			const response = await sendChunk("upload:nope", IMAGE_BYTES);

			expect(response.status).toBe(400);
			expect(await readJson<{ error: { error_subcode: number } }>(response)).toMatchObject({
				error: { error_subcode: 33 },
			});
		});
	});

	describe("GET /upload:{id}", () => {
		it("reports a truthful file_offset before, during and after the upload", async () => {
			const id = await sessionId();
			const status = async (): Promise<OffsetResponse> =>
				readJson<OffsetResponse>(await fixture.app.request(`/v25.0/${id}`, { headers: TEST_AUTH_HEADERS }));

			expect(await status()).toEqual({ id, file_offset: 0 });

			await sendChunk(id, IMAGE_BYTES.subarray(0, 512));

			expect(await status()).toEqual({ id, file_offset: 512 });

			await sendChunk(id, IMAGE_BYTES.subarray(512), 512);

			expect(await status()).toEqual({ id, file_offset: IMAGE_BYTES.byteLength });
		});

		it("is the missing-object envelope for an unknown session", async () => {
			const response = await fixture.app.request("/v25.0/upload:nope", { headers: TEST_AUTH_HEADERS });

			expect(response.status).toBe(400);
		});
	});

	/** The handle is only worth having if something can be done with it (SPEC §2.7, §2.19). */
	describe("what a handle is good for", () => {
		it("publishes a business profile picture, without needing a media upload first", async () => {
			const handle = await uploadedHandle();
			const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/whatsapp_business_profile`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({ messaging_product: "whatsapp", profile_picture_handle: handle }),
			});

			expect(response.status).toBe(200);

			const profile = await readJson<{ data: [{ profile_picture_url: string }] }>(
				await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/whatsapp_business_profile`, {
					headers: TEST_AUTH_HEADERS,
				}),
			);

			expect(profile.data[0].profile_picture_url).toMatch(
				new RegExp(String.raw`^${TEST_PUBLIC_URL}/whaloc-upload/[\w-]+$`),
			);

			// …and the bytes really are there.
			const bytes = await fixture.app.request(pathOf(profile.data[0].profile_picture_url));

			expect(bytes.status).toBe(200);
			expect(bytes.headers.get("content-type")).toBe("image/jpeg");
			expect(Buffer.from(await bytes.arrayBuffer()).equals(IMAGE_BYTES)).toBe(true);
		});

		it("carries a template's media header, and is refused when it resolves to nothing", async () => {
			const handle = await uploadedHandle();
			const create = (headerHandle: string) => {
				return fixture.app.request(`/v25.0/${fixture.wabaId}/message_templates`, {
					method: "POST",
					headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
					body: JSON.stringify({
						name: `promo_${headerHandle === handle ? "ok" : "bad"}`,
						language: "en_US",
						category: "MARKETING",
						components: [
							{ type: "HEADER", format: "IMAGE", example: { header_handle: [headerHandle] } },
							{ type: "BODY", text: "Hello" },
						],
					}),
				});
			};

			expect(await statusOf(create(handle))).toBe(200);

			const refused = await create("4::bm90LWEtaGFuZGxl:ARZnope");

			expect(refused.status).toBe(400);
			expect(await readJson<{ error: { code: number } }>(refused)).toMatchObject({ error: { code: 100 } });
		});

		it("serves the bytes with Range support, and 404s an unknown token", async () => {
			const handle = await uploadedHandle();
			const session = await fixture.services.repositories.uploadSessions.findByHandle(handle);
			const url = `/whaloc-upload/${session?.urlToken ?? ""}`;
			const sliced = await fixture.app.request(url, { headers: { range: "bytes=0-9" } });

			expect(sliced.status).toBe(206);
			expect(sliced.headers.get("content-range")).toBe(`bytes 0-9/${String(IMAGE_BYTES.byteLength)}`);
			expect(await statusOf(fixture.app.request("/whaloc-upload/not-a-real-token"))).toBe(404);
		});

		it("is resolvable through the control plane, for the UI's template preview", async () => {
			const handle = await uploadedHandle();
			const response = await fixture.app.request(`/api/uploads?handle=${encodeURIComponent(handle)}`);

			expect(response.status).toBe(200);
			expect(await readJson<{ data: { handle: string; mimeType: string; fileName: string } }>(response)).toMatchObject({
				data: { handle, mimeType: "image/jpeg", fileName: "photo.jpg" },
			});
			expect(await statusOf(fixture.app.request("/api/uploads?handle=4::nope"))).toBe(404);
		});

		it("has no URL while the session is still being filled", async () => {
			const id = await sessionId();

			await sendChunk(id, IMAGE_BYTES.subarray(0, 10));

			const session = await fixture.services.repositories.uploadSessions.findById(id.replace("upload:", ""));

			expect(session?.handle).toBeNull();
			expect(session?.urlToken).toBeNull();
		});
	});
});
