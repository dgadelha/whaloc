import type { SignupChoice, SignupSessionEvent } from "@whaloc/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
	jsonResponse,
	makePhoneNumber,
	PHONE_NUMBER_ID,
	requestBodyOf,
	stubFetch,
	WABA_ID,
	type FetchMock,
} from "../../test/factories.ts";
import { EmbeddedSignupPage } from "./embedded-signup-page.tsx";

/**
 * The Embedded Signup popup (SPEC §2.24) as the page that opened it sees it: whatever path the
 * user walks, what reaches `window.opener` is Meta's session event and then whaloc's code, as
 * JSON strings sent only to the `origin` `FB.login` named, and the popup closes. The page under
 * test and `sdk.js` depend on exactly that, so the assertions are on the posted strings.
 */

const APP_ID = "4242424242";
const PAGE_ORIGIN = "https://app.example.test";
const DIALOG_URL = `/dialog/embedded-signup?app_id=${APP_ID}&origin=${encodeURIComponent(PAGE_ORIGIN)}&version=v25.0`;
const CODE = "AQcode";

const CHOICES: SignupChoice[] = [
	{
		waba: { id: WABA_ID, name: "Test Business", subscribedAt: null, createdAt: "2026-08-31T12:00:00.000Z" },
		phoneNumbers: [makePhoneNumber()],
	},
];

function finishEvent(event: SignupSessionEvent["event"], data: Record<string, string>): SignupSessionEvent {
	return { type: "WA_EMBEDDED_SIGNUP", event, data };
}

describe("EmbeddedSignupPage", () => {
	let fetchMock: FetchMock;
	let postMessage: Mock<(message: string, targetOrigin: string) => void>;
	let close: Mock<() => void>;
	let sessionEvent: SignupSessionEvent;
	let isCompleteHeld: boolean;

	beforeEach(() => {
		sessionEvent = finishEvent("FINISH", { phone_number_id: PHONE_NUMBER_ID, waba_id: WABA_ID, business_id: "1" });
		isCompleteHeld = false;
		fetchMock = stubFetch(path => {
			if (path.startsWith("/api/embedded-signup/choices")) {
				return Promise.resolve(
					path.includes(`app_id=${APP_ID}`)
						? jsonResponse({ data: CHOICES })
						: jsonResponse({ error: { message: "App ID 1 is not this whaloc's app.", code: "unknown_app" } }, 400),
				);
			}

			if (path === "/api/embedded-signup/complete") {
				return isCompleteHeld
					? new Promise<never>(() => {})
					: Promise.resolve(jsonResponse({ data: { code: CODE, sessionEvent } }));
			}

			return Promise.resolve(jsonResponse({ data: { sessionId: "session-1", timestamp: "1767225600000" } }));
		});
		postMessage = vi.fn();
		close = vi.fn();
		vi.stubGlobal("opener", { postMessage });
		vi.stubGlobal("close", close);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function renderDialog(url = DIALOG_URL): void {
		render(
			<MemoryRouter initialEntries={[url]}>
				<Routes>
					<Route path="dialog/embedded-signup" element={<EmbeddedSignupPage />} />
				</Routes>
			</MemoryRouter>,
		);
	}

	function next(): void {
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
	}

	/** What the opener received, parsed back, with the origin each message was sent to. */
	function posted(): [unknown, string][] {
		return postMessage.mock.calls.map(([message, origin]) => [JSON.parse(message), origin]);
	}

	function completeRequestBody(): unknown {
		const call = fetchMock.mock.calls.findIndex(([path]) => path === "/api/embedded-signup/complete");

		return requestBodyOf(fetchMock, call);
	}

	it("finishes with an existing account and number: the session event, then the code, then closes", async () => {
		renderDialog();

		fireEvent.click(await screen.findByRole("radio", { name: /Test Business/ }));
		next();
		fireEvent.click(screen.getByRole("radio", { name: /\+55 11 91234-5678/ }));
		next();
		fireEvent.click(screen.getByRole("button", { name: "Finish" }));

		expect(await screen.findByRole("status")).toHaveProperty(
			"textContent",
			"Account connected. You can close this window.",
		);
		expect(completeRequestBody()).toEqual({
			appId: APP_ID,
			sessionInfoVersion: "v4",
			waba: { kind: "existing", id: WABA_ID },
			phoneNumber: { kind: "existing", id: PHONE_NUMBER_ID },
		});
		expect(posted()).toEqual([
			[sessionEvent, PAGE_ORIGIN],
			[{ type: "WHALOC_LOGIN_RESPONSE", code: CODE }, PAGE_ORIGIN],
		]);
		expect(close).toHaveBeenCalledOnce();
	});

	it("shares only the WABA when the user continues without a number", async () => {
		sessionEvent = finishEvent("FINISH_ONLY_WABA", { waba_id: WABA_ID, business_id: "1" });
		renderDialog();

		await screen.findByRole("radio", { name: /Test Business/ });
		next();
		fireEvent.click(screen.getByRole("radio", { name: /Continue without a phone number/ }));
		next();
		fireEvent.click(screen.getByRole("button", { name: "Finish" }));
		await screen.findByRole("status");

		expect(completeRequestBody()).toMatchObject({ phoneNumber: { kind: "none" } });
		expect(posted()[0]).toEqual([sessionEvent, PAGE_ORIGIN]);
	});

	it("creates a WABA and a coexistence number, refusing to move on while either is incomplete", async () => {
		sessionEvent = finishEvent("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", { waba_id: "777" });
		renderDialog();

		fireEvent.click(await screen.findByRole("radio", { name: /Create a new WABA/ }));
		next();
		const missingName = screen.getByRole("alert").textContent;

		fireEvent.change(screen.getByLabelText("New WABA name"), { target: { value: " Acme " } });
		next();
		// A new WABA has no numbers yet, so adding one is the default.
		expect(screen.queryByRole("radio", { name: /\+55 11/ })).toBeNull();
		next();
		const missingNumber = screen.getByRole("alert").textContent;

		fireEvent.change(screen.getByLabelText("New phone number"), { target: { value: "+1 631 555 0100" } });
		fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Acme" } });
		fireEvent.click(screen.getByRole("checkbox", { name: /coexistence/ }));
		next();
		fireEvent.click(screen.getByRole("button", { name: "Finish" }));
		await screen.findByRole("status");

		expect([missingName, missingNumber]).toEqual([
			"A new WABA needs a name.",
			"A new phone number needs the number and a display name.",
		]);
		expect(completeRequestBody()).toEqual({
			appId: APP_ID,
			sessionInfoVersion: "v4",
			waba: { kind: "new", name: "Acme" },
			phoneNumber: { kind: "new", phoneNumber: "+1 631 555 0100", verifiedName: "Acme", coexistence: true },
		});
		expect(posted()).toEqual([
			[sessionEvent, PAGE_ORIGIN],
			[{ type: "WHALOC_LOGIN_RESPONSE", code: CODE }, PAGE_ORIGIN],
		]);
	});

	it("asks for v5's event when FB.login asked for v5", async () => {
		renderDialog(`${DIALOG_URL}&extras=${encodeURIComponent(JSON.stringify({ version: "v5" }))}`);

		await screen.findByRole("radio", { name: /Test Business/ });
		next();
		next();
		fireEvent.click(screen.getByRole("button", { name: "Finish" }));
		await screen.findByRole("status");

		expect(completeRequestBody()).toMatchObject({ sessionInfoVersion: "v5" });
	});

	it("offers no other way out while Finish is on its way", async () => {
		isCompleteHeld = true;
		renderDialog();

		await screen.findByRole("radio", { name: /Test Business/ });
		next();
		next();
		fireEvent.click(screen.getByRole("button", { name: "Finish" }));

		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Simulate error" }).disabled).toBe(true);
	});

	it("cancels at the step the user is on, unless another one is picked", async () => {
		renderDialog();

		await screen.findByRole("radio", { name: /Test Business/ });
		next();
		const followed = screen.getByRole<HTMLSelectElement>("combobox", { name: "Cancel at step" }).value;

		fireEvent.change(screen.getByLabelText("Cancel at step"), { target: { value: "PHONE_NUMBER_VERIFICATION" } });
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(followed).toBe("PHONE_NUMBER_SETUP");
		expect(posted()).toEqual([
			[
				{ data: { current_step: "PHONE_NUMBER_VERIFICATION" }, type: "WA_EMBEDDED_SIGNUP", event: "CANCEL" },
				PAGE_ORIGIN,
			],
		]);
		expect(close).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/embedded-signup/complete");
	});

	it("simulates an error with the typed code and message and whaloc's session", async () => {
		renderDialog();

		await screen.findByRole("radio", { name: /Test Business/ });
		fireEvent.change(screen.getByLabelText("Error code"), { target: { value: "2" } });
		fireEvent.change(screen.getByLabelText("Error message"), { target: { value: "Boom" } });
		fireEvent.click(screen.getByRole("button", { name: "Simulate error" }));
		await screen.findByRole("status");

		expect(posted()).toEqual([
			[
				{
					data: { error_message: "Boom", error_code: "2", session_id: "session-1", timestamp: "1767225600000" },
					type: "WA_EMBEDDED_SIGNUP",
					event: "ERROR",
				},
				PAGE_ORIGIN,
			],
		]);
		expect(close).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"an app that is not whaloc's",
			"/dialog/embedded-signup?app_id=1&origin=https%3A%2F%2Fapp.example.test",
			"App ID 1 is not this whaloc's app.",
		],
		[
			"no page to answer to",
			`/dialog/embedded-signup?app_id=${APP_ID}&origin=javascript%3Aalert(1)`,
			"The dialog has no page to answer to: open it through FB.login.",
		],
	])("refuses to start for %s, posting nothing", async (_case, url, message) => {
		renderDialog(url);

		const alert = await screen.findByRole("alert");

		expect(alert.textContent).toBe(message);
		expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
		expect(postMessage).not.toHaveBeenCalled();
	});
});
