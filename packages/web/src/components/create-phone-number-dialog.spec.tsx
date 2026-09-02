import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "../store/store.tsx";
import {
	jsonResponse,
	makeAppState,
	makePhoneNumber,
	requestBodyOf,
	stubFetch,
	WABA_ID,
	type FetchMock,
} from "../test/factories.ts";
import { CreatePhoneNumberDialog } from "./create-phone-number-dialog.tsx";

/**
 * The number-creation dialog Settings and the breadcrumb share (SPEC §5).
 *
 * The id is the interesting half: `WHATSAPP_PHONE_NUMBER_ID` is the value an app under test is
 * most often already configured with, and being able to type it here is what lets that `.env` be
 * pointed at whaloc unedited.
 */
function renderDialog(onClose = vi.fn()): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			{children}
		</StoreProvider>
	);

	render(<CreatePhoneNumberDialog wabaId={WABA_ID} wabaName="whaloc Test Business" onClose={onClose} />, { wrapper });
}

function fillRequiredFields(): void {
	fireEvent.change(screen.getByLabelText("New phone number display number"), {
		target: { value: "+1 631-555-5555" },
	});
	fireEvent.change(screen.getByLabelText("New phone number verified name"), {
		target: { value: "Jasper's Market" },
	});
}

describe("CreatePhoneNumberDialog", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() =>
			Promise.resolve(jsonResponse({ data: makePhoneNumber({ id: "150123456789012" }) }, 201)),
		);
	});

	it("leaves the id out when the field is blank, so whaloc mints one", async () => {
		renderDialog();
		fillRequiredFields();
		fireEvent.click(screen.getByRole("button", { name: "Add phone number" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});

		expect(requestBodyOf(fetchMock)).toEqual({
			wabaId: WABA_ID,
			displayPhoneNumber: "+1 631-555-5555",
			verifiedName: "Jasper's Market",
		});
	});

	it("sends the id that was typed", async () => {
		renderDialog();
		fillRequiredFields();
		fireEvent.change(screen.getByLabelText("New phone number ID"), { target: { value: "150123456789012" } });
		fireEvent.click(screen.getByRole("button", { name: "Add phone number" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});

		expect(requestBodyOf(fetchMock)).toEqual({
			wabaId: WABA_ID,
			displayPhoneNumber: "+1 631-555-5555",
			verifiedName: "Jasper's Market",
			id: "150123456789012",
		});
	});

	it("refuses an id that is not digits, without asking the server", () => {
		renderDialog();
		fillRequiredFields();
		fireEvent.change(screen.getByLabelText("New phone number ID"), { target: { value: "1".repeat(33) } });
		fireEvent.click(screen.getByRole("button", { name: "Add phone number" }));

		expect(screen.getByRole("alert").textContent).toContain("1-32 digits");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps the dialog open on a collision, showing what the server said", async () => {
		const onClose = vi.fn();

		fetchMock = stubFetch(() =>
			Promise.resolve(
				jsonResponse(
					{
						error: { message: "the id 150123456789012 is already taken by a template", code: "duplicate_phone_number" },
					},
					409,
				),
			),
		);
		renderDialog(onClose);
		fillRequiredFields();
		fireEvent.change(screen.getByLabelText("New phone number ID"), { target: { value: "150123456789012" } });
		fireEvent.click(screen.getByRole("button", { name: "Add phone number" }));

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("the id 150123456789012 is already taken by a template");
		});

		expect(onClose).not.toHaveBeenCalled();
	});
});
