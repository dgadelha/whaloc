import type { SignupCompleteRequest } from "@whaloc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AUTHORIZATION_CODE_TTL_MS, businessIdOf } from "../domain/index.ts";
import { createRecordingScheduler, type RecordingScheduler } from "../testing/domain-harness.ts";
import { readJson, statusOf, stringMatching } from "../testing/expectations.ts";
import { createTestApp, type TestApp } from "../testing/test-app.ts";

/**
 * Embedded Signup end to end (SPEC §2.23-§2.24), driven the way a page and its backend drive
 * Meta: the dialog's choices, sent to its API, produce the session event and the code, the
 * backend exchanges the code, asks `debug_token` what the token was granted, and onboards the numbers it lists.
 */

const APP_ID = "4242424242";
const APP_SECRET = "dev-app-secret";
const APP_TOKEN = { authorization: `Bearer ${APP_ID}|${APP_SECRET}` };

interface SessionEvent {
	type: string;
	event: string;
	data: { waba_id?: string; phone_number_id?: string; business_id?: string };
}

type DialogChoice = Pick<SignupCompleteRequest, "waba" | "phoneNumber"> &
	Partial<Pick<SignupCompleteRequest, "sessionInfoVersion">>;

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

	function complete(choice: DialogChoice, appId = APP_ID) {
		return fixture.app.request("/api/embedded-signup/complete", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ appId, sessionInfoVersion: "v4", ...choice }),
		});
	}

	/** Finishes the dialog and reads back the event and the code it posts to the page. */
	async function finishDialog(choice: DialogChoice): Promise<{ event: SessionEvent; code: string }> {
		const response = await complete(choice);
		const { data } = await readJson<{ data: { code: string; sessionEvent: SessionEvent } }>(response);

		expect(response.status).toBe(200);

		return { event: data.sessionEvent, code: data.code };
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
			waba: { kind: "new", name: "Acme" },
			phoneNumber: { kind: "new", phoneNumber: "+1 631 555 0100", verifiedName: "Acme", coexistence: false },
		});
		const exchanged = await exchange(code);
		const { access_token: token, token_type: tokenType } = await readJson<{ access_token: string; token_type: string }>(
			exchanged,
		);
		const reused = await exchange(code);
		const wabaId = event.data.waba_id ?? "";
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
		const phoneNumberId = event.data.phone_number_id ?? "";

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
		const waba = { kind: "existing", id: wabaId } as const;
		const onlyWaba = await finishDialog({ waba, phoneNumber: { kind: "none" } });
		const existing = await finishDialog({ waba, phoneNumber: { kind: "existing", id: phoneNumberId } });
		const coexistence = await finishDialog({
			waba,
			phoneNumber: { kind: "new", phoneNumber: "5511912340000", verifiedName: "Coexisting", coexistence: true },
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

	it("posts v5's event, the one fixed shape, to a page that asked for v5", async () => {
		await start();

		const { wabaId, phoneNumberId } = fixture;
		const waba = { kind: "existing", id: wabaId } as const;
		const sessionInfoVersion = "v5";
		const onlyWaba = await finishDialog({ waba, phoneNumber: { kind: "none" }, sessionInfoVersion });
		const existing = await finishDialog({
			waba,
			phoneNumber: { kind: "existing", id: phoneNumberId },
			sessionInfoVersion,
		});
		const coexistence = await finishDialog({
			waba,
			phoneNumber: { kind: "new", phoneNumber: "5511912340000", verifiedName: "Coexisting", coexistence: true },
			sessionInfoVersion,
		});
		const v5Data = (isOnBizApp: boolean) => {
			return {
				is_on_biz_app: isOnBizApp,
				messaging_account_ids: [wabaId],
				primary_waac_ids: [],
				page_ids: [],
				catalog_ids: [],
				dataset_ids: [],
				business_id: businessIdOf(wabaId),
				instagram_account_ids: [],
			};
		};

		expect(onlyWaba.event).toEqual({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: v5Data(false) });
		expect(existing.event).toEqual({
			type: "WA_EMBEDDED_SIGNUP",
			event: "FINISH",
			data: { phone_number_id: phoneNumberId, ...v5Data(false) },
		});
		expect(coexistence.event).toEqual({
			type: "WA_EMBEDDED_SIGNUP",
			event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
			data: { phone_number_id: stringMatching(/^\d+$/), ...v5Data(true) },
		});
	});

	it("leaves no WABA behind when another signup claims the same new number first", async () => {
		await start();

		const claim = (name: string) => {
			return complete({
				waba: { kind: "new", name },
				phoneNumber: { kind: "new", phoneNumber: "+1 631 555 0199", verifiedName: name, coexistence: false },
			});
		};
		const responses = await Promise.all([claim("First"), claim("Second")]);
		const wabas = await fixture.services.repositories.wabas.list();

		expect(responses.map(response => response.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
		expect(wabas).toHaveLength(2);
	});

	it("forgets codes a minute after they expire, and every code on a reset", async () => {
		await start();

		const waba = { kind: "existing", id: fixture.wabaId } as const;
		const expiring = await finishDialog({ waba, phoneNumber: { kind: "none" } });

		scheduler.setNow(new Date(scheduler.now().getTime() + 2 * AUTHORIZATION_CODE_TTL_MS));

		const forgotten = await readJson<ErrorEnvelope>(await exchange(expiring.code));
		const beforeReset = await finishDialog({ waba, phoneNumber: { kind: "none" } });

		await fixture.app.request("/api/reset", { method: "POST" });

		const afterReset = await readJson<ErrorEnvelope>(await exchange(beforeReset.code));

		expect(forgotten.error.message).toBe("Invalid verification code format.");
		expect(afterReset.error.message).toBe("Invalid verification code format.");
	});

	it("reads the app secret after the first `|` of the app token, `|` included", async () => {
		await start({ WHALOC_APP_SECRET: "dev|secret" });

		const debug = await fixture.app.request("/v25.0/debug_token?input_token=x", {
			headers: { authorization: `Bearer ${APP_ID}|dev|secret` },
		});

		expect(debug.status).toBe(200);
	});

	it("finds the app token where the bearer gate finds a token: the query only without a header", async () => {
		await start();

		const path = `/v25.0/debug_token?input_token=x&access_token=${APP_ID}|${APP_SECRET}`;
		const fromQuery = await fixture.app.request(path);
		const malformedHeader = await fixture.app.request(path, { headers: { authorization: "Basic abc" } });
		const refusal = await readJson<ErrorEnvelope>(malformedHeader);

		expect(fromQuery.status).toBe(200);
		expect(malformedHeader.status).toBe(401);
		expect(refusal.error.code).toBe(190);
	});

	it("gives the dialog the WABAs to pick from and the session an ERROR event names", async () => {
		await start();

		const choices = await readJson<{ data: { waba: { id: string }; phoneNumbers: { id: string }[] }[] }>(
			await fixture.app.request(`/api/embedded-signup/choices?app_id=${APP_ID}`),
		);
		const session = await readJson<{ data: { sessionId: string; timestamp: string } }>(
			await fixture.app.request(`/api/embedded-signup/error-session?app_id=${APP_ID}`),
		);

		expect(choices.data.map(({ waba, phoneNumbers }) => [waba.id, phoneNumbers.map(({ id }) => id)])).toEqual([
			[fixture.wabaId, [fixture.phoneNumberId]],
		]);
		// Meta documents the timestamp as Unix milliseconds in a string.
		expect(session.data).toEqual({
			sessionId: stringMatching(/^\S+$/),
			timestamp: String(scheduler.now().getTime()),
		});
	});

	it("refuses what Meta refuses, without touching state", async () => {
		await start();

		const unknownApp = await Promise.all([
			fixture.app.request("/api/embedded-signup/choices?app_id=1"),
			fixture.app.request("/api/embedded-signup/error-session?app_id=1"),
			complete({ waba: { kind: "new", name: "Should not exist" }, phoneNumber: { kind: "none" } }, "1"),
		]);
		const foreignNumber = await complete({
			waba: { kind: "new", name: "Should not exist" },
			phoneNumber: { kind: "existing", id: fixture.phoneNumberId },
		});
		const wabasAfter = await fixture.services.repositories.wabas.list();
		const { code } = await finishDialog({
			waba: { kind: "existing", id: fixture.wabaId },
			phoneNumber: { kind: "none" },
		});
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

		// The dialog shows this message, as Meta's refuses an app it does not know.
		const refusal = [400, { error: { message: "App ID 1 is not this whaloc's app.", code: "unknown_app" } }];

		expect(await Promise.all(unknownApp.map(async response => [response.status, await response.json()]))).toEqual([
			refusal,
			refusal,
			refusal,
		]);
		expect(foreignNumber.status).toBe(400);
		expect(await readJson<{ error: { message: string } }>(foreignNumber)).toEqual({
			error: {
				message: `phone number ${fixture.phoneNumberId} does not belong to the chosen WABA`,
				code: "phone_number_not_in_waba",
			},
		});
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

		const { code } = await finishDialog({
			waba: { kind: "existing", id: fixture.wabaId },
			phoneNumber: { kind: "none" },
		});
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
