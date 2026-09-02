import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_MEDIA_BYTES, META_ID_PATTERN } from "../domain/index.ts";
import { readJson, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, TEST_PUBLIC_URL, type TestApp } from "../testing/test-app.ts";

interface MediaNode {
	messaging_product: string;
	url: string;
	mime_type: string;
	sha256: string;
	file_size: number;
	id: string;
}

/** Incompressible bytes, so a range that serves the wrong slice shows up immediately. */
const IMAGE_BYTES = randomBytes(4096);
const MEDIA_URL_PATTERN = new RegExp(String.raw`^${TEST_PUBLIC_URL}/whaloc-media/[\w-]+$`);

/** The path of a media URL, which is what `app.request()` takes. */
function pathOf(url: string): string {
	const parsed = new URL(url);

	return parsed.pathname;
}

describe("media (SPEC §1.7, §1.8, §2.6, §2.12)", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	function upload(form: FormData, phoneNumberId = fixture.phoneNumberId) {
		return fixture.app.request(`/v25.0/${phoneNumberId}/media`, {
			method: "POST",
			headers: TEST_AUTH_HEADERS,
			body: form,
		});
	}

	/** The parts the consumer sends: an injected `messaging_product`, then `file` and `type`. */
	function consumerForm(type = "image/jpeg"): FormData {
		const form = new FormData();

		form.set("messaging_product", "whatsapp");
		form.set("file", new File([IMAGE_BYTES], "photo.jpg", { type }));
		form.set("type", type);

		return form;
	}

	async function uploadedId(form = consumerForm()): Promise<string> {
		const response = await upload(form);
		const body = await readJson<{ id: string }>(response);

		return body.id;
	}

	async function uploadAndResolve(form = consumerForm()): Promise<MediaNode> {
		const id = await uploadedId(form);
		const response = await fixture.app.request(`/v25.0/${id}?phone_number_id=${fixture.phoneNumberId}`, {
			headers: TEST_AUTH_HEADERS,
		});

		return readJson<MediaNode>(response);
	}

	function download(url: string, headers: Record<string, string> = {}) {
		return fixture.app.request(pathOf(url), { headers });
	}

	describe("POST /:phoneNumberId/media", () => {
		it("answers a digit-only id (SPEC §1.3)", async () => {
			const response = await upload(consumerForm());

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ id: stringMatching(META_ID_PATTERN) });
		});

		it("records the type part as the MIME type", async () => {
			const node = await uploadAndResolve(consumerForm("application/pdf"));

			expect(node.mime_type).toBe("application/pdf");
		});

		it("falls back to the file part's own type when `type` is missing", async () => {
			const form = new FormData();

			form.set("messaging_product", "whatsapp");
			form.set("file", new File([IMAGE_BYTES], "clip.mp4", { type: "video/mp4" }));

			const node = await uploadAndResolve(form);

			expect(node.mime_type).toBe("video/mp4");
		});

		it("falls back to application/octet-stream when nothing declares a type", async () => {
			const form = new FormData();

			form.set("file", new File([IMAGE_BYTES], "blob"));

			const node = await uploadAndResolve(form);

			expect(node.mime_type).toBe("application/octet-stream");
		});

		it("accepts an upload without the messaging_product part", async () => {
			const form = new FormData();

			form.set("file", new File([IMAGE_BYTES], "photo.jpg", { type: "image/jpeg" }));
			form.set("type", "image/jpeg");

			const response = await upload(form);

			expect(response.status).toBe(200);
		});

		it("requires a file part", async () => {
			const form = new FormData();

			form.set("messaging_product", "whatsapp");
			form.set("type", "image/jpeg");

			const response = await upload(form);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { code: 100, error_data: { details: "Param file is required in a multipart/form-data body" } },
			});
		});

		it("rejects a body that is not multipart", async () => {
			const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/media`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: "{}",
			});

			expect(response.status).toBe(400);
		});

		it("reports an unknown phone number as a missing object", async () => {
			const response = await upload(consumerForm(), "888888888888888");

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});

		it("refuses an upload that declares more than the cap, before reading it (SPEC §2.6)", async () => {
			const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/media`, {
				method: "POST",
				headers: {
					...TEST_AUTH_HEADERS,
					"content-type": "multipart/form-data; boundary=x",
					"content-length": String(MAX_MEDIA_BYTES + 1),
				},
				body: "--x--",
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { message: "(#100) Media file size too big. Max file size we currently support: 100MB", code: 100 },
			});
		});
	});

	describe("GET /:mediaId — the first hop (SPEC §1.7)", () => {
		it("answers the whole descriptor with a WHALOC_PUBLIC_URL-based url", async () => {
			const node = await uploadAndResolve();

			expect(node).toEqual({
				messaging_product: "whatsapp",
				url: stringMatching(MEDIA_URL_PATTERN),
				mime_type: "image/jpeg",
				// The descriptor reports the digest base64, the way Meta writes it.
				sha256: createHash("sha256").update(IMAGE_BYTES).digest("base64"),
				file_size: IMAGE_BYTES.byteLength,
				id: stringMatching(META_ID_PATTERN),
			});
		});

		it("resolves without the phone_number_id query parameter", async () => {
			const id = await uploadedId();
			const response = await fixture.app.request(`/v25.0/${id}`, { headers: TEST_AUTH_HEADERS });

			expect(response.status).toBe(200);
		});

		it("reports media of another phone number as missing", async () => {
			const id = await uploadedId();
			const response = await fixture.app.request(`/v25.0/${id}?phone_number_id=888888888888888`, {
				headers: TEST_AUTH_HEADERS,
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});

	describe("GET /whaloc-media/:token — the second hop (SPEC §2.12)", () => {
		it("serves the bytes that were uploaded, unchanged", async () => {
			const node = await uploadAndResolve();
			const response = await download(node.url);

			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("image/jpeg");
			expect(response.headers.get("content-length")).toBe(String(IMAGE_BYTES.byteLength));
			expect(response.headers.get("accept-ranges")).toBe("bytes");
			expect(Buffer.from(await response.arrayBuffer()).equals(IMAGE_BYTES)).toBe(true);
		});

		it("never redirects — the consumer treats a 3xx as a failure", async () => {
			const node = await uploadAndResolve();
			const response = await download(node.url);

			expect(response.status).toBeLessThan(300);
			expect(response.headers.get("location")).toBeNull();
		});

		it("needs no Authorization header: the token is the credential", async () => {
			const node = await uploadAndResolve();
			const response = await download(node.url);

			expect(response.status).toBe(200);
		});

		it("answers a closed range with 206 and the right slice", async () => {
			const node = await uploadAndResolve();
			const response = await download(node.url, { range: "bytes=0-99" });

			expect(response.status).toBe(206);
			expect(response.headers.get("content-range")).toBe(`bytes 0-99/${String(IMAGE_BYTES.byteLength)}`);
			expect(response.headers.get("content-length")).toBe("100");
			expect(Buffer.from(await response.arrayBuffer()).equals(IMAGE_BYTES.subarray(0, 100))).toBe(true);
		});

		it("answers an open-ended range with the rest of the object", async () => {
			const node = await uploadAndResolve();
			const start = IMAGE_BYTES.byteLength - 10;
			const response = await download(node.url, { range: `bytes=${String(start)}-` });

			expect(response.status).toBe(206);
			expect(response.headers.get("content-length")).toBe("10");
			expect(Buffer.from(await response.arrayBuffer()).equals(IMAGE_BYTES.subarray(start))).toBe(true);
		});

		it("answers a suffix range with the last bytes", async () => {
			const node = await uploadAndResolve();
			const response = await download(node.url, { range: "bytes=-16" });

			expect(response.status).toBe(206);
			expect(Buffer.from(await response.arrayBuffer()).equals(IMAGE_BYTES.subarray(-16))).toBe(true);
		});

		it("answers an unsatisfiable range with 416", async () => {
			const node = await uploadAndResolve();
			const response = await download(node.url, { range: "bytes=99999-100000" });

			expect(response.status).toBe(416);
			expect(response.headers.get("content-range")).toBe(`bytes */${String(IMAGE_BYTES.byteLength)}`);
		});

		it("ignores a range unit it does not serve", async () => {
			const node = await uploadAndResolve();
			const response = await download(node.url, { range: "items=0-10" });

			expect(response.status).toBe(200);
		});

		it("answers a plain 404 for an unknown token", async () => {
			const response = await fixture.app.request("/whaloc-media/not-a-real-token");

			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not Found");
		});
	});

	/**
	 * `DELETE /{mediaId}` (SPEC §2.6b). The point of it is the state it leaves behind: every hop
	 * afterwards has to look exactly like the media never existed, because that is what a consumer
	 * keys its "this media is gone" path on.
	 */
	describe("DELETE /:mediaId", () => {
		function remove(id: string, query = "") {
			return fixture.app.request(`/v25.0/${id}${query}`, { method: "DELETE", headers: TEST_AUTH_HEADERS });
		}

		it("answers {success:true} and takes the object with it", async () => {
			const node = await uploadAndResolve();
			const response = await remove(node.id);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
			expect(await fixture.services.repositories.media.findById(node.id)).toBeNull();
		});

		it("leaves the resolve hop answering the missing-object envelope (SPEC §1.4)", async () => {
			const node = await uploadAndResolve();

			await remove(node.id);

			const resolved = await fixture.app.request(`/v25.0/${node.id}?phone_number_id=${fixture.phoneNumberId}`, {
				headers: TEST_AUTH_HEADERS,
			});

			expect(resolved.status).toBe(400);
			expect(await readJson<{ error: { code: number; error_subcode: number } }>(resolved)).toMatchObject({
				error: { code: 100, error_subcode: 33 },
			});
		});

		it("leaves the byte URL 404ing like an unknown token", async () => {
			const node = await uploadAndResolve();

			await remove(node.id);

			const bytes = await download(node.url);

			expect(bytes.status).toBe(404);
		});

		it("accepts the optional phone_number_id scope", async () => {
			const node = await uploadAndResolve();
			const response = await remove(node.id, `?phone_number_id=${fixture.phoneNumberId}`);

			expect(response.status).toBe(200);
		});

		it("reports another number's media as missing, and keeps it", async () => {
			const node = await uploadAndResolve();
			const other = await fixture.services.domain.phoneNumbers.create({
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+55 11 90000-0002",
				verifiedName: "Other",
			});
			const response = await remove(node.id, `?phone_number_id=${other.id}`);

			expect(response.status).toBe(400);
			expect(await fixture.services.repositories.media.findById(node.id)).not.toBeNull();
		});

		it("is 400 / 100 / 33 for a media id nothing was ever uploaded under", async () => {
			const response = await remove("999999999999999");

			expect(response.status).toBe(400);
			expect(await readJson<{ error: { code: number; error_subcode: number } }>(response)).toMatchObject({
				error: { code: 100, error_subcode: 33 },
			});
		});

		it("refuses an id that is not media at all", async () => {
			const response = await remove(fixture.phoneNumberId);

			expect(response.status).toBe(400);
			expect(await readJson<{ error: { error_subcode: number } }>(response)).toMatchObject({
				error: { error_subcode: 33 },
			});
		});
	});
});
