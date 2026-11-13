import { afterEach, describe, expect, it } from "vitest";
import { AUTHORIZATION_CODE_TTL_MS, businessIdOf } from "../domain/index.ts";
import { createRecordingScheduler, type RecordingScheduler } from "../testing/domain-harness.ts";
import { readJson, statusOf, stringMatching } from "../testing/expectations.ts";
import { createTestApp, type TestApp } from "../testing/test-app.ts";
import { RESULT_ELEMENT_ID } from "./dialog-page.ts";
import { LOGIN_RESPONSE_TYPE } from "./sdk-script.ts";

/**
 * Embedded Signup end to end (SPEC §2.23-§2.24), driven the way a page and its backend drive
 * Meta: the dialog's form produces the session event and the code, the backend exchanges the
 * code, asks `debug_token` what the token was granted, and onboards the numbers it lists.
 */

const APP_ID = "4242424242";
const APP_SECRET = "dev-app-secret";
const APP_TOKEN = { authorization: `Bearer ${APP_ID}|${APP_SECRET}` };
const PAGE_ORIGIN = "https://app.example.test";
const RESULT_PATTERN = new RegExp(`<script type="application/json" id="${RESULT_ELEMENT_ID}">(.*?)</script>`, "s");

interface PostedMessage {
	type: string;
	event?: string;
	data?: { waba_id?: string; phone_number_id?: string; business_id?: string };
	code?: string;
}

interface ErrorEnvelope {
	error: { message: string; type: string; code: number };
}

interface PhoneNumberNode {
	id: string;
	status: string;
	platform_type: string;
	is_on_biz_app: boolean;
}

describe("Embedded Signup", () => {
	let fixture: TestApp;
	let scheduler: RecordingScheduler;

	afterEach(async () => {
		await fixture.close();
	});

	async function start(env: Record<string, string> = {}): Promise<void> {
		scheduler = createRecordingScheduler();
		fixture = await createTestApp({ WHALOC_APP_ID: APP_ID, WHALOC_APP_SECRET: APP_SECRET, ...env }, { scheduler });
	}

	/** Submits the dialog's form and reads back what the finished dialog posts to the page. */
	async function finishDialog(fields: Record<string, string>): Promise<{ event: PostedMessage; code: string }> {
		const response = await fixture.app.request("/dialog/embedded-signup", {
			method: "POST",
			body: new URLSearchParams({ app_id: APP_ID, origin: PAGE_ORIGIN, ...fields }),
		});
		const html = await response.text();
		const result = JSON.parse(RESULT_PATTERN.exec(html)?.[1] ?? "null") as {
			origin: string;
			messages: [PostedMessage, PostedMessage];
		};

		expect(response.status).toBe(200);
		expect(result.origin).toBe(PAGE_ORIGIN);
		expect(result.messages[1].type).toBe(LOGIN_RESPONSE_TYPE);

		return { event: result.messages[0], code: result.messages[1].code ?? "" };
	}

	function exchange(code: string, overrides: Record<string, string> = {}) {
		const query = new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, code, ...overrides });

		return fixture.app.request(`/v25.0/oauth/access_token?${query.toString()}`);
	}

	async function phoneNumbersOf(wabaId: string, token: string): Promise<PhoneNumberNode[]> {
		const response = await fixture.app.request(
			`/v25.0/${wabaId}/phone_numbers?fields=id,status,platform_type,is_on_biz_app`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		const page = await readJson<{ data: PhoneNumberNode[] }>(response);

		return page.data;
	}

	it("onboards a new WABA and number through the code, the token and debug_token", async () => {
		await start();

		const { event, code } = await finishDialog({
			waba: "new",
			waba_name: "Acme",
			phone_number_choice: "new",
			phone_number: "+1 631 555 0100",
			verified_name: "Acme",
		});
		const exchanged = await exchange(code);
		const { access_token: token, token_type: tokenType } = await readJson<{ access_token: string; token_type: string }>(
			exchanged,
		);
		const reused = await exchange(code);
		const wabaId = event.data?.waba_id ?? "";
		const debug = await fixture.app.request(`/v25.0/debug_token?input_token=${token}`, { headers: APP_TOKEN });

		expect(event).toEqual({
			type: "WA_EMBEDDED_SIGNUP",
			event: "FINISH",
			data: { phone_number_id: stringMatching(/^\d+$/), waba_id: wabaId, business_id: businessIdOf(wabaId) },
		});
		expect(exchanged.status).toBe(200);
		expect(tokenType).toBe("bearer");
		// One code, one token: Meta refuses the second exchange with the code a consumer keys on.
		expect(reused.status).toBe(400);
		expect(await readJson<ErrorEnvelope>(reused)).toMatchObject({
			error: { message: "This authorization code has been used.", type: "OAuthException", code: 100 },
		});
		expect(await debug.json()).toEqual({
			data: {
				app_id: APP_ID,
				type: "SYSTEM_USER",
				application: "whaloc",
				is_valid: true,
				scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
				granular_scopes: [
					{ scope: "whatsapp_business_management", target_ids: [wabaId] },
					{ scope: "whatsapp_business_messaging", target_ids: [wabaId] },
				],
			},
		});

		// Verified in the dialog, so `register` alone takes it onto the Cloud API.
		const phoneNumberId = event.data?.phone_number_id ?? "";

		expect(await phoneNumbersOf(wabaId, token)).toEqual([
			{ id: phoneNumberId, status: "PENDING", platform_type: "NOT_APPLICABLE", is_on_biz_app: false },
		]);

		const registered = await fixture.app.request(`/v25.0/${phoneNumberId}/register`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", pin: "123456" }),
		});

		expect(registered.status).toBe(200);
		expect(await phoneNumbersOf(wabaId, token)).toEqual([
			{ id: phoneNumberId, status: "CONNECTED", platform_type: "CLOUD_API", is_on_biz_app: false },
		]);
	});

	it("posts Meta's event for each way the dialog can finish", async () => {
		await start();

		const { wabaId, phoneNumberId } = fixture;
		const onlyWaba = await finishDialog({ waba: wabaId, phone_number_choice: "none" });
		const existing = await finishDialog({ waba: wabaId, phone_number_choice: phoneNumberId });
		const coexistence = await finishDialog({
			waba: wabaId,
			phone_number_choice: "new",
			phone_number: "5511912340000",
			verified_name: "Coexisting",
			coexistence: "on",
		});
		const numbers = await phoneNumbersOf(wabaId, "any-token");

		expect(onlyWaba.event).toEqual({
			type: "WA_EMBEDDED_SIGNUP",
			event: "FINISH_ONLY_WABA",
			data: { waba_id: wabaId, business_id: businessIdOf(wabaId) },
		});
		expect(existing.event).toEqual({
			type: "WA_EMBEDDED_SIGNUP",
			event: "FINISH",
			data: { phone_number_id: phoneNumberId, waba_id: wabaId, business_id: businessIdOf(wabaId) },
		});
		// Meta's coexistence event names the WABA alone, and the number is already registered.
		expect(coexistence.event).toEqual({
			type: "WA_EMBEDDED_SIGNUP",
			event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
			data: { waba_id: wabaId },
		});
		expect(numbers.map(({ status, platform_type, is_on_biz_app }) => [status, platform_type, is_on_biz_app])).toEqual([
			["CONNECTED", "CLOUD_API", false],
			["CONNECTED", "CLOUD_API", true],
		]);
	});

	it("refuses what Meta refuses, without touching state", async () => {
		await start();

		const unknownApp = await fixture.app.request(`/dialog/embedded-signup?app_id=1&origin=${PAGE_ORIGIN}`);
		const foreignNumber = await fixture.app.request("/dialog/embedded-signup", {
			method: "POST",
			body: new URLSearchParams({
				app_id: APP_ID,
				origin: PAGE_ORIGIN,
				waba: "new",
				waba_name: "Should not exist",
				phone_number_choice: fixture.phoneNumberId,
			}),
		});
		const wabasAfter = await fixture.services.repositories.wabas.list();
		const { code } = await finishDialog({ waba: fixture.wabaId, phone_number_choice: "none" });
		const failures = await Promise.all(
			[exchange(code, { client_id: "1" }), exchange(code, { client_secret: "wrong" }), exchange("AQnot-a-code")].map(
				async request => readJson<ErrorEnvelope>(await request),
			),
		);

		scheduler.setNow(new Date(scheduler.now().getTime() + AUTHORIZATION_CODE_TTL_MS));

		const expired = await readJson<ErrorEnvelope>(await exchange(code));
		const unknownToken = await fixture.app.request("/v25.0/debug_token?input_token=EAAWforged.token", {
			headers: APP_TOKEN,
		});
		const wrongAppToken = await fixture.app.request(
			`/v25.0/debug_token?input_token=x&access_token=${APP_ID}|wrong-secret`,
		);

		expect(unknownApp.status).toBe(400);
		expect(foreignNumber.status).toBe(400);
		expect(await foreignNumber.text()).toContain("does not belong to the chosen WABA");
		expect(wabasAfter.map(waba => waba.id)).toEqual([fixture.wabaId]);
		expect(failures.map(({ error }) => [error.code, error.message])).toEqual([
			[101, "Error validating application. Invalid application ID."],
			[1, "Error validating client secret."],
			[100, "Invalid verification code format."],
		]);
		expect(expired.error).toMatchObject({ code: 100, message: "This authorization code has expired." });
		expect(await unknownToken.json()).toEqual({
			data: {
				is_valid: false,
				error: { code: 190, message: "Invalid OAuth access token - Cannot parse access token" },
				scopes: [],
			},
		});
		expect(wrongAppToken.status).toBe(401);
	});

	it("lets an issued token through the strict gate, and nothing that merely looks like one", async () => {
		await start({ WHALOC_TOKENS: "registered-token" });

		const { code } = await finishDialog({ waba: fixture.wabaId, phone_number_choice: "none" });
		const { access_token: token } = await readJson<{ access_token: string }>(await exchange(code));
		const tampered = `${token.slice(0, -2)}AA`;
		const statusFor = (bearer: string) => {
			return statusOf(
				fixture.app.request(`/v25.0/${fixture.wabaId}/phone_numbers`, {
					headers: { authorization: `Bearer ${bearer}` },
				}),
			);
		};

		expect(await statusFor(token)).toBe(200);
		expect(await statusFor(tampered)).toBe(401);
		expect(await statusFor("registered-token")).toBe(200);
	});
});
