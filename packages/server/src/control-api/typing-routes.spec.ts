import { typingIndicatorListResponseSchema, type TypingIndicator } from "@whaloc/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJson } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * `GET /api/typing` (SPEC §5) — how the UI (and a test script) reads the typing state the app
 * under test raised through the Graph surface.
 *
 * The indicators are made the only way whaloc offers: a read receipt carrying
 * `typing_indicator`. There is deliberately no control-plane route that raises one.
 */
const CONTACT_WA_ID = "5571990000001";

describe("GET /api/typing", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	async function receiveInbound(from = CONTACT_WA_ID): Promise<string> {
		const response = await fixture.app.request("/api/inbound", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ phoneNumberId: fixture.phoneNumberId, from, type: "text", text: { body: "Hello?" } }),
		});
		const received = await readJson<{ data: { id: string } }>(response);

		return received.data.id;
	}

	async function startTyping(from = CONTACT_WA_ID): Promise<void> {
		const messageId = await receiveInbound(from);

		await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({
				messaging_product: "whatsapp",
				status: "read",
				message_id: messageId,
				typing_indicator: { type: "text" },
			}),
		});
	}

	async function list(query = ""): Promise<Response> {
		return fixture.app.request(`/api/typing${query}`);
	}

	async function listed(query = ""): Promise<TypingIndicator[]> {
		const response = await list(query);
		const body = typingIndicatorListResponseSchema.parse(await response.json());

		return body.data;
	}

	it("is empty until the app under test says it is typing", async () => {
		expect(await listed()).toEqual([]);
	});

	it("serves the indicator a read receipt raised", async () => {
		await startTyping();

		expect(await listed()).toEqual([
			{
				phoneNumberId: fixture.phoneNumberId,
				contactWaId: CONTACT_WA_ID,
				expiresAt: expect.any(String) as string,
			},
		]);
	});

	it("narrows the listing to one phone number", async () => {
		await startTyping();

		expect(await listed(`?phoneNumberId=${fixture.phoneNumberId}`)).toHaveLength(1);
		expect(await listed("?phoneNumberId=888888888888888")).toEqual([]);
	});

	it("rejects a blank phoneNumberId with the control plane's error shape", async () => {
		const response = await list("?phoneNumberId=");

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
	});

	it("forgets everything a reset wiped", async () => {
		await startTyping();
		await fixture.app.request("/api/reset", { method: "POST" });

		expect(await listed()).toEqual([]);
	});
});
