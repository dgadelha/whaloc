import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FBTRACE_ID_PATTERN } from "../domain/index.ts";
import { pathOf, readJson, statusOf, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * The token registry (SPEC §1.9).
 *
 * Three states are asserted end to end, because the whole point of the feature is what the app
 * under test sees on the wire: permissive (the default), strict with a registered token, and
 * strict with one the control plane expired.
 */

interface ErrorEnvelope {
	error: { message: string; type: string; code: number; error_subcode?: number; fbtrace_id: string };
}

interface TokenListBody {
	strict: boolean;
	data: { id: string; masked: string; last4: string; expired: boolean; expiredAt: string | null }[];
}

const REGISTERED = "EAAregistered-token-one";
const SECOND = "EAAregistered-token-two";

describe("bearer auth", () => {
	let fixture: TestApp;

	afterEach(async () => {
		await fixture.close();
	});

	function get(token: string | null) {
		return fixture.app.request(
			`/v25.0/${fixture.phoneNumberId}`,
			token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
		);
	}

	async function listTokens(): Promise<TokenListBody> {
		return readJson<TokenListBody>(await fixture.app.request("/api/tokens"));
	}

	describe("permissive mode: WHALOC_TOKENS unset (the default)", () => {
		beforeEach(async () => {
			fixture = await createTestApp();
		});

		it("accepts any non-empty token", async () => {
			expect(await statusOf(get("anything-at-all"))).toBe(200);
			expect(await statusOf(get(REGISTERED))).toBe(200);
		});

		it("still rejects a missing token with the 401 / 190 envelope", async () => {
			const response = await get(null);

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

		it("reports an empty registry rather than an error", async () => {
			expect(await listTokens()).toEqual({ strict: false, data: [] });
		});

		it("has nothing to expire", async () => {
			const response = await fixture.app.request("/api/tokens/0123456789abcdef/expire", { method: "POST" });

			expect(response.status).toBe(404);
		});
	});

	describe("strict mode: WHALOC_TOKENS set", () => {
		beforeEach(async () => {
			// The trailing comma and the padding are deliberate: a compose file writes lists that way.
			fixture = await createTestApp({ WHALOC_TOKENS: `${REGISTERED}, ${SECOND},` });
		});

		it("accepts every registered token", async () => {
			expect(await statusOf(get(REGISTERED))).toBe(200);
			expect(await statusOf(get(SECOND))).toBe(200);
		});

		it("rejects an unregistered token with the same envelope as a missing one", async () => {
			const unregistered = await get("EAAnot-in-the-registry");
			const missing = await get(null);

			expect(unregistered.status).toBe(401);
			expect(await unregistered.json()).toEqual({
				error: {
					message: "Invalid OAuth access token - Cannot parse access token",
					type: "OAuthException",
					code: 190,
					fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
				},
			});
			const body = await readJson<ErrorEnvelope>(missing);

			expect(body.error.code).toBe(190);
		});

		it("is not fooled by a prefix or a case change", async () => {
			const truncated = REGISTERED.slice(0, -1);
			const shouted = REGISTERED.toUpperCase();

			expect(await statusOf(get(truncated))).toBe(401);
			expect(await statusOf(get(shouted))).toBe(401);
		});

		it("lists the registry masked, never the token itself", async () => {
			const body = await listTokens();

			expect(body.strict).toBe(true);
			expect(body.data).toHaveLength(2);
			// Twelve dots is the cap, so a long token cannot stretch the UI.
			expect(body.data[0]).toMatchObject({
				masked: "••••••••••••-one",
				last4: "-one",
				expired: false,
				expiredAt: null,
			});
			expect(JSON.stringify(body)).not.toContain(REGISTERED);
		});

		it("answers a token it expired with code 190 subcode 463 and no error_data", async () => {
			const { data } = await listTokens();
			const expired = await fixture.app.request(`/api/tokens/${data[0]!.id}/expire`, { method: "POST" });

			expect(expired.status).toBe(200);

			const response = await get(REGISTERED);
			const body = await readJson<ErrorEnvelope>(response);

			expect(response.status).toBe(401);
			expect(body.error).toEqual({
				message: stringMatching(/^Error validating access token: Session has expired on \w+day, \d\d-\w\w\w-\d\d /),
				type: "OAuthException",
				code: 190,
				error_subcode: 463,
				fbtrace_id: stringMatching(FBTRACE_ID_PATTERN),
			});
			expect(body.error).not.toHaveProperty("error_data");
			// One expired token says nothing about the other.
			expect(await statusOf(get(SECOND))).toBe(200);
		});

		it("restores an expired token", async () => {
			const { data } = await listTokens();

			await fixture.app.request(`/api/tokens/${data[0]!.id}/expire`, { method: "POST" });
			expect(await statusOf(get(REGISTERED))).toBe(401);

			await fixture.app.request(`/api/tokens/${data[0]!.id}/restore`, { method: "POST" });
			expect(await statusOf(get(REGISTERED))).toBe(200);
		});

		it("keeps expiring and restoring idempotent", async () => {
			const { data } = await listTokens();
			const id = data[0]!.id;

			await fixture.app.request(`/api/tokens/${id}/expire`, { method: "POST" });

			const first = await listTokens();

			await fixture.app.request(`/api/tokens/${id}/expire`, { method: "POST" });

			const second = await listTokens();

			expect(second.data[0]!.expiredAt).toBe(first.data[0]!.expiredAt);

			await fixture.app.request(`/api/tokens/${id}/restore`, { method: "POST" });
			await fixture.app.request(`/api/tokens/${id}/restore`, { method: "POST" });

			const restored = await listTokens();

			expect(restored.data[0]).toMatchObject({ expired: false, expiredAt: null });
		});

		it("brings every token back on POST /api/reset", async () => {
			const { data } = await listTokens();

			await fixture.app.request(`/api/tokens/${data[0]!.id}/expire`, { method: "POST" });
			await fixture.app.request("/api/reset", { method: "POST" });

			const afterReset = await listTokens();

			expect(afterReset.data.every(token => !token.expired)).toBe(true);
		});

		it("says so in GET /api/state, without serving the tokens", async () => {
			const response = await fixture.app.request("/api/state");
			const body = await readJson<{ behavior: { strictTokens: boolean } }>(response);

			expect(body.behavior.strictTokens).toBe(true);
			expect(JSON.stringify(body)).not.toContain(REGISTERED);
		});

		it("leaves the media byte endpoint outside the gate (SPEC §2.12)", async () => {
			const upload = new FormData();

			upload.set("messaging_product", "whatsapp");
			upload.set("file", new File([new Uint8Array([1, 2, 3])], "a.bin", { type: "image/png" }));

			const uploaded = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/media`, {
				method: "POST",
				headers: { authorization: `Bearer ${REGISTERED}` },
				body: upload,
			});
			const { id } = await readJson<{ id: string }>(uploaded);
			const descriptor = await fixture.app.request(`/v25.0/${id}?phone_number_id=${fixture.phoneNumberId}`, {
				headers: { authorization: `Bearer ${REGISTERED}` },
			});
			const { url } = await readJson<{ url: string }>(descriptor);
			const bytes = await fixture.app.request(pathOf(url));

			expect(bytes.status).toBe(200);
		});
	});

	describe("the fixture's own token", () => {
		beforeEach(async () => {
			fixture = await createTestApp();
		});

		// Every other spec in the suite leans on this: the shared header keeps working because
		// permissive mode is the default and nothing about it changed.
		it("keeps working unchanged", async () => {
			const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}`, { headers: TEST_AUTH_HEADERS });

			expect(response.status).toBe(200);
		});
	});
});
