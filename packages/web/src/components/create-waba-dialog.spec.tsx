import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "../store/store.tsx";
import { jsonResponse, makeAppState, requestBodyOf, stubFetch, type FetchMock } from "../test/factories.ts";
import { CreateWabaDialog } from "./create-waba-dialog.tsx";

/**
 * The account-creation dialog Settings and the breadcrumb share (SPEC §5).
 *
 * Its own spec, rather than only the Settings one, because of the **id**: an account whose id has
 * to match a production configuration is the reason the field exists, and its three outcomes —
 * generated, honored, refused — are the dialog's contract, not Settings'.
 */
function renderDialog(onClose = vi.fn()): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			{children}
		</StoreProvider>
	);

	render(<CreateWabaDialog onClose={onClose} />, { wrapper });
}

const CREATED = {
	id: "102290129340398",
	name: "Second Business",
	subscribedAt: null,
	createdAt: "2026-09-01T10:00:00.000Z",
};

describe("CreateWabaDialog", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: CREATED }, 201)));
	});

	it("leaves the id out when the field is blank, so whaloc mints one", async () => {
		renderDialog();

		expect(screen.getByLabelText("New WABA ID")).toHaveProperty("placeholder", "auto-generated");

		fireEvent.change(screen.getByLabelText("New WABA name"), { target: { value: "Second Business" } });
		fireEvent.click(screen.getByRole("button", { name: "Add WABA" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});

		expect(requestBodyOf(fetchMock)).toEqual({ name: "Second Business" });
	});

	it("sends the id that was typed", async () => {
		renderDialog();

		fireEvent.change(screen.getByLabelText("New WABA name"), { target: { value: "Second Business" } });
		fireEvent.change(screen.getByLabelText("New WABA ID"), { target: { value: " 102290129340398 " } });
		fireEvent.click(screen.getByRole("button", { name: "Add WABA" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});

		expect(requestBodyOf(fetchMock)).toEqual({ name: "Second Business", id: "102290129340398" });
	});

	// The same schema the server validates with, so the mistake is named where it was made.
	it("refuses an id that is not digits, without asking the server", () => {
		renderDialog();

		fireEvent.change(screen.getByLabelText("New WABA name"), { target: { value: "Second Business" } });
		fireEvent.change(screen.getByLabelText("New WABA ID"), { target: { value: "waba-1" } });
		fireEvent.click(screen.getByRole("button", { name: "Add WABA" }));

		expect(screen.getByRole("alert").textContent).toContain("1-32 digits");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("names the nameless account in the dialog rather than in a toast", () => {
		renderDialog();

		fireEvent.click(screen.getByRole("button", { name: "Add WABA" }));

		expect(screen.getByRole("alert").textContent).toBe("A WABA needs a name");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	/**
	 * A taken id is a correction to make in the field right above the message, with everything
	 * else already typed in — so the dialog stays open and says what happened.
	 */
	it("keeps the dialog open on a collision, showing what the server said", async () => {
		const onClose = vi.fn();

		fetchMock = stubFetch(() =>
			Promise.resolve(
				jsonResponse(
					{ error: { message: "the id 102290129340398 is already taken by a WABA", code: "duplicate_waba" } },
					409,
				),
			),
		);
		renderDialog(onClose);

		fireEvent.change(screen.getByLabelText("New WABA name"), { target: { value: "Twin" } });
		fireEvent.change(screen.getByLabelText("New WABA ID"), { target: { value: "102290129340398" } });
		fireEvent.click(screen.getByRole("button", { name: "Add WABA" }));

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("the id 102290129340398 is already taken by a WABA");
		});

		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByLabelText("New WABA name")).toHaveProperty("value", "Twin");
	});
});
