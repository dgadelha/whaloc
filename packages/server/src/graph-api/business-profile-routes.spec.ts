import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson, stringContaining } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, TEST_PUBLIC_URL, type TestApp } from "../testing/test-app.ts";

/**
 * `GET|POST /{phoneNumberId}/whatsapp_business_profile` (SPEC §2.19).
 *
 * The endpoint is not in the vendored specs, so these tests pin what whaloc promises instead:
 * Meta's field set with its limits, `{data:[…]}` around a single profile, merge-on-update, and
 * `profile_picture_handle` taking a whaloc media id.
 */
interface ProfilePage {
	data: Record<string, unknown>[];
}

const FULL_PROFILE = {
	messaging_product: "whatsapp",
	about: "Fresh groceries, delivered.",
	address: "1 Market Street, Salvador",
	description: "A whaloc test business.",
	email: "hello@example.test",
	vertical: "GROCERY",
	websites: ["https://example.test", "https://shop.example.test"],
};

describe("business profile (SPEC §2.19)", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	function read(query = "", phoneNumberId = fixture.phoneNumberId) {
		return fixture.app.request(`/v25.0/${phoneNumberId}/whatsapp_business_profile${query}`, {
			headers: TEST_AUTH_HEADERS,
		});
	}

	async function profile(query = ""): Promise<Record<string, unknown>> {
		const page = await readJson<ProfilePage>(await read(query));

		return page.data[0] ?? {};
	}

	function write(body: unknown, phoneNumberId = fixture.phoneNumberId) {
		return fixture.app.request(`/v25.0/${phoneNumberId}/whatsapp_business_profile`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/** Uploads bytes the way the app under test would, and hands back the media id. */
	async function uploadMedia(): Promise<string> {
		const form = new FormData();

		form.set("messaging_product", "whatsapp");
		form.set("file", new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
		form.set("type", "image/png");

		const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/media`, {
			method: "POST",
			headers: TEST_AUTH_HEADERS,
			body: form,
		});
		const uploaded = await readJson<{ id: string }>(response);

		return uploaded.id;
	}

	describe("GET", () => {
		it("answers an empty profile as messaging_product alone", async () => {
			const response = await read();

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ data: [{ messaging_product: "whatsapp" }] });
		});

		it("serves every field that was set, in Meta's snake_case", async () => {
			await write(FULL_PROFILE);

			expect(await profile()).toEqual(FULL_PROFILE);
		});

		it("honors fields, keeping messaging_product whatever was asked for", async () => {
			await write(FULL_PROFILE);

			expect(await profile("?fields=about,email")).toEqual({
				messaging_product: "whatsapp",
				about: FULL_PROFILE.about,
				email: FULL_PROFILE.email,
			});
		});

		it("reports an unknown phone number as a missing object (SPEC §1.4)", async () => {
			const response = await read("", "888888888888888");

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});

	describe("POST", () => {
		it("answers {success:true}", async () => {
			const response = await write({ messaging_product: "whatsapp", about: "Hello" });

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });
		});

		it("changes only the fields it carries", async () => {
			await write(FULL_PROFILE);
			await write({ messaging_product: "whatsapp", about: "Now with same-day delivery." });

			expect(await profile()).toEqual({ ...FULL_PROFILE, about: "Now with same-day delivery." });
		});

		it("clears a field given as an empty string", async () => {
			await write(FULL_PROFILE);
			await write({ messaging_product: "whatsapp", about: "", websites: [] });

			const current = await profile();

			expect(current).not.toHaveProperty("about");
			expect(current).not.toHaveProperty("websites");
			expect(current).toMatchObject({ email: FULL_PROFILE.email });
		});

		it("stores the profile on the phone number itself", async () => {
			await write({ messaging_product: "whatsapp", vertical: "RETAIL" });

			expect(await fixture.services.repositories.phoneNumbers.findById(fixture.phoneNumberId)).toMatchObject({
				businessProfile: { vertical: "RETAIL" },
			});
		});

		it("announces the phone number so the UI sees a profile it did not post", async () => {
			const events: string[] = [];

			fixture.services.domain.events.subscribe(event => {
				events.push(event.type);
			});

			await write({ messaging_product: "whatsapp", about: "Hello" });

			expect(events).toEqual(["phone_number.changed"]);
		});

		it.each([
			{ label: "a wrong messaging_product", body: { messaging_product: "sms", about: "Hi" } },
			{ label: "an about over 139 characters", body: { messaging_product: "whatsapp", about: "x".repeat(140) } },
			{
				label: "a description over 512 characters",
				body: { messaging_product: "whatsapp", description: "x".repeat(513) },
			},
			{
				label: "a third website",
				body: { messaging_product: "whatsapp", websites: ["https://a.test", "https://b.test", "https://c.test"] },
			},
			{ label: "a vertical Meta does not define", body: { messaging_product: "whatsapp", vertical: "SPACESHIPS" } },
		])("rejects $label", async ({ body }) => {
			const response = await write(body);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, message: "(#100) Invalid parameter" } });
		});

		it("reports an unknown phone number as a missing object", async () => {
			const response = await write({ messaging_product: "whatsapp", about: "Hi" }, "888888888888888");

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});

	describe("profile_picture_handle", () => {
		it("publishes an uploaded media object as profile_picture_url", async () => {
			const response = await write({ messaging_product: "whatsapp", profile_picture_handle: await uploadMedia() });

			expect(response.status).toBe(200);
			expect(await profile()).toMatchObject({
				profile_picture_url: stringContaining(`${TEST_PUBLIC_URL}/whaloc-media/`),
			});
		});

		it("clears the picture when the handle is empty", async () => {
			await write({ messaging_product: "whatsapp", profile_picture_handle: await uploadMedia() });
			await write({ messaging_product: "whatsapp", profile_picture_handle: "" });

			expect(await profile()).not.toHaveProperty("profile_picture_url");
		});

		it("refuses a handle that is not a media object of this number", async () => {
			const response = await write({ messaging_product: "whatsapp", profile_picture_handle: "1234567890" });

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { error_data: { details: stringContaining("Param profile_picture_handle (1234567890)") } },
			});
		});

		it("refuses media belonging to another phone number", async () => {
			const mediaId = await uploadMedia();
			const other = await fixture.services.repositories.phoneNumbers.insert({
				id: "111222333444555",
				wabaId: fixture.wabaId,
				displayPhoneNumber: "+55 11 90000-0000",
				verifiedName: "Another number",
			});
			const response = await write({ messaging_product: "whatsapp", profile_picture_handle: mediaId }, other.id);

			expect(response.status).toBe(400);
		});
	});
});
