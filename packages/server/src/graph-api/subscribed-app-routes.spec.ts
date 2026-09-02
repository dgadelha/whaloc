import { stateResponseSchema } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { META_ID_PATTERN } from "../domain/index.ts";
import { readJson, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, TEST_PUBLIC_URL, type TestApp } from "../testing/test-app.ts";

/**
 * `subscribed_apps` on a WABA (SPEC §2.20).
 *
 * whaloc plays exactly one app — itself — so the surface is a per-WABA on/off fact. What these
 * tests pin is the round trip a consumer performs at startup, Meta's nested listing shape, and
 * the documented divergences: an idempotent `DELETE`, and deliveries that keep going out
 * whatever the subscription says.
 */
interface SubscribedAppsPage {
	data: { whatsapp_business_api_data: { id: string; name: string; link: string } }[];
}

describe("subscribed apps (SPEC §2.20)", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	function call(method: string, wabaId = fixture.wabaId) {
		return fixture.app.request(`/v25.0/${wabaId}/subscribed_apps`, { method, headers: TEST_AUTH_HEADERS });
	}

	async function listed(): Promise<SubscribedAppsPage["data"]> {
		const page = await readJson<SubscribedAppsPage>(await call("GET"));

		return page.data;
	}

	it("lists nothing until an app subscribes", async () => {
		const response = await call("GET");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: [] });
	});

	it("subscribes, then reports the app in Meta's nested shape", async () => {
		const response = await call("POST");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(await listed()).toEqual([
			{
				whatsapp_business_api_data: {
					id: stringMatching(META_ID_PATTERN),
					name: "whaloc",
					link: TEST_PUBLIC_URL,
				},
			},
		]);
	});

	it("records when it happened, on the WABA", async () => {
		await call("POST");

		expect(await fixture.services.repositories.wabas.findById(fixture.wabaId)).toMatchObject({
			subscribedAt: stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
	});

	it("announces the WABA so the UI can show the subscription", async () => {
		const events: string[] = [];

		fixture.services.domain.events.subscribe(event => {
			events.push(event.type);
		});

		await call("POST");

		expect(events).toEqual(["waba.changed"]);
	});

	it("unsubscribes, and stays a success when there was nothing to remove", async () => {
		await call("POST");

		const first = await call("DELETE");

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ success: true });
		expect(await listed()).toEqual([]);

		const second = await call("DELETE");

		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ success: true });
	});

	it("derives a stable app id, and takes WHALOC_APP_ID when it is set", async () => {
		await call("POST");

		const [derived] = await listed();

		await fixture.close();
		fixture = await createTestApp();
		await call("POST");

		const [again] = await listed();

		expect(again?.whatsapp_business_api_data.id).toBe(derived?.whatsapp_business_api_data.id);

		await fixture.close();
		fixture = await createTestApp({ WHALOC_APP_ID: "1234567890" });
		await call("POST");

		const [configured] = await listed();

		expect(configured?.whatsapp_business_api_data.id).toBe("1234567890");
	});

	it("names the app in GET /api/state, subscription included", async () => {
		await call("POST");

		const response = await fixture.app.request("/api/state");
		const state = stateResponseSchema.parse(await response.json());

		expect(state.app).toEqual({ id: stringMatching(META_ID_PATTERN), name: "whaloc" });
		expect(state.wabas[0]?.subscribedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it.each(["GET", "POST", "DELETE"])("reports an unknown WABA as a missing object on %s", async method => {
		const response = await call(method, "888888888888888");

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
	});

	/**
	 * The divergence worth being explicit about: `WHALOC_WEBHOOK_URL` decides where webhooks go,
	 * so a `DELETE` here does not silence them. A dev tool that quietly stopped delivering would
	 * be a support question, not a feature.
	 */
	it("keeps delivering webhooks while nothing is subscribed", async () => {
		await call("DELETE");
		await fixture.app.request("/api/inbound", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				phoneNumberId: fixture.phoneNumberId,
				from: "5571990000001",
				type: "text",
				text: { body: "still delivered" },
			}),
		});
		await fixture.services.domain.tasks.whenIdle();

		expect(await fixture.services.repositories.webhookDeliveries.list()).not.toEqual([]);
	});
});
