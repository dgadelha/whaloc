import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import {
	jsonResponse,
	makeAppState,
	makePhoneNumber,
	PHONE_NUMBER_ID,
	requestBodyOf,
	stubFetch,
	type FetchMock,
} from "../../test/factories.ts";
import { BusinessProfileForm } from "./business-profile-form.tsx";

/**
 * The business profile form (SPEC §2.19, §5).
 *
 * What matters is the body it posts: **every** field, blanks included, because a blank is how
 * the control plane clears one — so the screen and
 * `GET /{phoneNumberId}/whatsapp_business_profile` cannot disagree after a save.
 */
const DISPLAY_PHONE_NUMBER = "+55 11 91234-5678";

function renderForm(profile: Record<string, unknown> = {}): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			{children}
		</StoreProvider>
	);

	render(<BusinessProfileForm phoneNumber={makePhoneNumber({ businessProfile: profile })} />, { wrapper });
}

describe("BusinessProfileForm", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: makePhoneNumber() })));
	});

	it("fills the inputs from the stored profile", () => {
		renderForm({
			about: "Fresh groceries, delivered.",
			vertical: "GROCERY",
			websites: ["https://example.test", "https://shop.example.test"],
		});

		expect(screen.getByLabelText(`About of ${DISPLAY_PHONE_NUMBER}`)).toHaveProperty(
			"value",
			"Fresh groceries, delivered.",
		);
		expect(screen.getByLabelText(`Vertical of ${DISPLAY_PHONE_NUMBER}`)).toHaveProperty("value", "GROCERY");
		expect(screen.getByLabelText(`Website 1 of ${DISPLAY_PHONE_NUMBER}`)).toHaveProperty(
			"value",
			"https://example.test",
		);
		expect(screen.getByLabelText(`Website 2 of ${DISPLAY_PHONE_NUMBER}`)).toHaveProperty(
			"value",
			"https://shop.example.test",
		);
	});

	it("posts every field, so a blank one clears it", async () => {
		renderForm({ about: "Fresh groceries, delivered.", email: "hello@example.test" });

		fireEvent.change(screen.getByLabelText(`About of ${DISPLAY_PHONE_NUMBER}`), { target: { value: "" } });
		fireEvent.change(screen.getByLabelText(`Address of ${DISPLAY_PHONE_NUMBER}`), {
			target: { value: " 1 Market Street " },
		});
		fireEvent.change(screen.getByLabelText(`Vertical of ${DISPLAY_PHONE_NUMBER}`), { target: { value: "RETAIL" } });
		fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		const [path, init] = fetchMock.mock.calls[0] ?? [];

		expect(path).toBe(`/api/phone-numbers/${PHONE_NUMBER_ID}/business-profile`);
		expect(init?.method).toBe("POST");
		expect(requestBodyOf(fetchMock)).toEqual({
			about: "",
			address: "1 Market Street",
			description: "",
			email: "hello@example.test",
			vertical: "RETAIL",
			websites: ["", ""],
		});
	});

	it("caps About at Meta's 139 characters", () => {
		renderForm();

		expect(screen.getByLabelText(`About of ${DISPLAY_PHONE_NUMBER}`).getAttribute("maxlength")).toBe("139");
	});

	it("explains that a profile picture is set through the Graph surface", () => {
		renderForm();

		expect(screen.getByText(/profile_picture_handle/)).toBeTruthy();
	});

	it("links a picture that is set", () => {
		renderForm({ profilePictureUrl: "http://localhost:8080/whaloc-media/abc" });

		expect(screen.getByRole("link", { name: "profile picture" }).getAttribute("href")).toBe(
			"http://localhost:8080/whaloc-media/abc",
		);
	});
});
