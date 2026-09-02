import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecordingScheduler, type RecordingScheduler } from "../testing/domain-harness.ts";
import { pathOf, readJson, statusOf } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * Media expiry (SPEC §4, "Error simulation").
 *
 * The clock is injected rather than waited on: the row's `created_at` is stamped by the real
 * clock, and the spec moves the *service's* clock forward, so the boundary is asserted exactly
 * instead of approximately.
 */

const TTL_SECONDS = 5;

interface ErrorEnvelope {
	error: { message: string; code: number; error_subcode?: number };
}

describe("media TTL", () => {
	let fixture: TestApp;
	let scheduler: RecordingScheduler;
	let uploadedAt: Date;

	/** Moves the service clock to `age` milliseconds after the object was uploaded. */
	function ageBy(milliseconds: number): void {
		scheduler.setNow(new Date(uploadedAt.getTime() + milliseconds));
	}

	async function upload(): Promise<string> {
		const form = new FormData();

		form.set("messaging_product", "whatsapp");
		form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "a.png", { type: "image/png" }));

		const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/media`, {
			method: "POST",
			headers: TEST_AUTH_HEADERS,
			body: form,
		});
		const { id } = await readJson<{ id: string }>(response);

		return id;
	}

	function resolve(id: string) {
		return fixture.app.request(`/v25.0/${id}?phone_number_id=${fixture.phoneNumberId}`, {
			headers: TEST_AUTH_HEADERS,
		});
	}

	async function byteUrlPath(id: string): Promise<string> {
		const { url } = await readJson<{ url: string }>(await resolve(id));

		return pathOf(url);
	}

	afterEach(async () => {
		await fixture.close();
	});

	describe("with WHALOC_MEDIA_TTL_SECONDS set", () => {
		let mediaId: string;
		let bytePath: string;

		beforeEach(async () => {
			scheduler = createRecordingScheduler();
			fixture = await createTestApp({ WHALOC_MEDIA_TTL_SECONDS: String(TTL_SECONDS) }, { scheduler });
			mediaId = await upload();

			// The row is stamped by the real clock; the service reads the injected one, so the
			// spec's ages are measured from what was actually written.
			const stored = await fixture.services.repositories.media.findById(mediaId);

			uploadedAt = new Date(stored?.createdAt ?? "");
			ageBy(0);
			bytePath = await byteUrlPath(mediaId);
		});

		it("serves a fresh object from both hops", async () => {
			ageBy((TTL_SECONDS - 1) * 1000);

			expect(await statusOf(resolve(mediaId))).toBe(200);
			expect(await statusOf(fixture.app.request(bytePath))).toBe(200);
		});

		it("still serves it one millisecond before the TTL", async () => {
			ageBy(TTL_SECONDS * 1000 - 1);

			expect(await statusOf(resolve(mediaId))).toBe(200);
			expect(await statusOf(fixture.app.request(bytePath))).toBe(200);
		});

		it("expires it the instant its age reaches the TTL: the boundary is inclusive", async () => {
			ageBy(TTL_SECONDS * 1000);

			expect(await statusOf(resolve(mediaId))).toBe(400);
			expect(await statusOf(fixture.app.request(bytePath))).toBe(404);
		});

		it("answers the descriptor hop with 400 / code 100 / subcode 33 (SPEC §1.4)", async () => {
			ageBy(TTL_SECONDS * 1000 + 1);

			const response = await resolve(mediaId);
			const body = await readJson<ErrorEnvelope>(response);

			expect(response.status).toBe(400);
			expect(body.error.code).toBe(100);
			expect(body.error.error_subcode).toBe(33);
			expect(body.error.message).toContain(`Object with ID '${mediaId}' does not exist`);
		});

		it("answers a bare GET /{mediaId} the same way", async () => {
			ageBy(TTL_SECONDS * 1000 + 1);

			const response = await fixture.app.request(`/v25.0/${mediaId}`, { headers: TEST_AUTH_HEADERS });
			const body = await readJson<ErrorEnvelope>(response);

			expect(response.status).toBe(400);
			expect(body.error.error_subcode).toBe(33);
		});

		it("answers the byte endpoint with the plain 404 an unknown token gets (SPEC §2.12)", async () => {
			ageBy(TTL_SECONDS * 1000 + 1);

			const expired = await fixture.app.request(bytePath);
			const unknown = await fixture.app.request("/whaloc-media/not-a-real-token");

			expect(expired.status).toBe(404);
			expect(await expired.text()).toBe(await unknown.text());
		});

		it("keeps the control plane's inspector honest: the UI can still describe it", async () => {
			ageBy(TTL_SECONDS * 1000 + 1);

			const response = await fixture.app.request(`/api/media/${mediaId}`);

			expect(response.status).toBe(200);
			expect(await readJson<{ data: { id: string } }>(response)).toMatchObject({ data: { id: mediaId } });
		});

		it("reports the TTL in GET /api/state", async () => {
			const { behavior } = await readJson<{ behavior: { mediaTtlSeconds: number | null } }>(
				await fixture.app.request("/api/state"),
			);

			expect(behavior.mediaTtlSeconds).toBe(TTL_SECONDS);
		});
	});

	describe("with WHALOC_MEDIA_TTL_SECONDS unset (the default)", () => {
		beforeEach(async () => {
			scheduler = createRecordingScheduler();
			fixture = await createTestApp({}, { scheduler });
			uploadedAt = new Date();
		});

		it("never expires media, however far the clock moves", async () => {
			const mediaId = await upload();
			const bytePath = await byteUrlPath(mediaId);

			scheduler.setNow(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));

			expect(await statusOf(resolve(mediaId))).toBe(200);
			expect(await statusOf(fixture.app.request(bytePath))).toBe(200);
		});

		it("reports no TTL in GET /api/state", async () => {
			const { behavior } = await readJson<{ behavior: { mediaTtlSeconds: number | null } }>(
				await fixture.app.request("/api/state"),
			);

			expect(behavior.mediaTtlSeconds).toBeNull();
		});
	});
});
