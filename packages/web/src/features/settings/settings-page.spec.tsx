import type { StateResponse } from "@whaloc/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import type { AppState } from "../../store/types.ts";
import {
	CONTACT_WA_ID,
	jsonResponse,
	makeAppState,
	makeContact,
	makePhoneNumber,
	makeStateResponse,
	makeTwoWabaState,
	PHONE_NUMBER_ID,
	requestBodyOf,
	SECOND_WABA_ID,
	stubFetch,
	THIRD_WABA_ID,
	WABA_ID,
	type FetchMock,
} from "../../test/factories.ts";
import { SettingsPage } from "./settings-page.tsx";

/**
 * Settings through the DOM: the runtime management half (SPEC §5).
 *
 * The store is the same reducer the WebSocket feeds, and every mutation here dispatches the
 * event the server would have pushed — so these tests also prove the optimistic path a click
 * takes when the socket is down.
 */
function renderSettings(state: Partial<AppState> = {}): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState(state)}>
			{children}
		</StoreProvider>
	);

	render(<SettingsPage />, { wrapper });
}

describe("SettingsPage", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: [] })));
	});

	it("groups the phone numbers under their WABA, with the lifecycle badges", () => {
		renderSettings();

		expect(screen.getByRole("heading", { name: "whaloc Test Business" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "+55 11 91234-5678" })).toBeTruthy();
		expect(screen.getByText("CONNECTED")).toBeTruthy();
		expect(screen.getByText("VERIFIED")).toBeTruthy();
	});

	/**
	 * Settings is a document — six unrelated subjects in one column — so it is navigated like one.
	 * Every entry in the anchor row has to land on a section that exists, or the row is a menu of
	 * dead ends.
	 */
	describe("the section layout", () => {
		const SECTION_IDS = ["accounts", "contacts", "error-injection", "behavior", "danger-zone"];

		it("names every section in the sub-nav, in the order they are laid out", () => {
			renderSettings();

			const nav = screen.getByRole("navigation", { name: "Settings sections" });

			expect(
				within(nav)
					.getAllByRole("link")
					.map(link => link.getAttribute("href")),
			).toEqual(SECTION_IDS.map(id => `#${id}`));
			expect(screen.getAllByRole("region").map(region => region.getAttribute("id"))).toEqual(SECTION_IDS);
		});

		/** An absent feature does not need a section, nor an anchor pointing at one (SPEC §1.9). */
		it("adds the tokens section only once the server reports a registry", () => {
			renderSettings({
				server: makeStateResponse({
					behavior: {
						statusDelays: { sent: 0, delivered: 800, read: null },
						templateAutoApproveMs: 2000,
						strictTokens: true,
						mediaTtlSeconds: null,
					},
				}),
			});

			const nav = screen.getByRole("navigation", { name: "Settings sections" });

			expect(
				within(nav)
					.getAllByRole("link")
					.map(link => link.getAttribute("href")),
			).toEqual(["#accounts", "#contacts", "#tokens", "#error-injection", "#behavior", "#danger-zone"]);
		});

		it("puts the create action in the Accounts header", () => {
			renderSettings();

			const accounts = screen.getByRole("region", { name: "Accounts" });

			expect(within(accounts).getByRole("button", { name: "Create WABA…" })).toBeTruthy();
		});
	});

	/**
	 * One collapsible card per account, because whaloc holds as many as a dev creates and each one
	 * expanded is a screenful (SPEC §5). What is worth scanning stays in the header; the rest is
	 * one click away.
	 */
	describe("the account cards", () => {
		function threeWabas(): StateResponse {
			const state = makeTwoWabaState();

			return {
				...state,
				wabas: [...state.wabas, { id: THIRD_WABA_ID, name: "Third Business", subscribedAt: null, phoneNumbers: [] }],
			};
		}

		function expandedOf(name: string): string | null {
			return screen.getByRole("button", { name }).getAttribute("aria-expanded");
		}

		it("summarises each account in its header, open or not", () => {
			renderSettings({ server: threeWabas() });

			expect(screen.getAllByRole("heading", { name: /Business$/ })).toHaveLength(3);
			expect(screen.getAllByText("1 number")).toHaveLength(2);
			expect(screen.getByText("0 numbers")).toBeTruthy();
			expect(screen.getAllByRole("button", { name: "Copy WABA id" })).toHaveLength(3);
		});

		it("expands every card while there are two accounts or fewer", () => {
			renderSettings({ server: makeTwoWabaState() });

			expect(expandedOf("whaloc Test Business")).toBe("true");
			expect(expandedOf("Second Business")).toBe("true");
		});

		// Settings is global — no scope in its URL — so it borrows the one the breadcrumb remembers.
		it("expands only the account the rest of the UI is scoped to, once there are more", () => {
			renderSettings({ server: threeWabas(), wabaId: SECOND_WABA_ID });

			expect(expandedOf("Second Business")).toBe("true");
			expect(expandedOf("whaloc Test Business")).toBe("false");
			expect(expandedOf("Third Business")).toBe("false");

			// A collapsed card is a header and nothing else: no numbers, no actions on the account.
			expect(screen.queryByRole("heading", { name: "+55 11 91234-5678" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Delete WABA whaloc Test Business" })).toBeNull();
			expect(screen.getByRole("heading", { name: "+1 631-555-5555" })).toBeTruthy();
		});

		it("opens a collapsed card, and closes an open one", () => {
			renderSettings({ server: threeWabas(), wabaId: SECOND_WABA_ID });

			fireEvent.click(screen.getByRole("button", { name: "whaloc Test Business" }));

			expect(expandedOf("whaloc Test Business")).toBe("true");
			expect(screen.getByRole("heading", { name: "+55 11 91234-5678" })).toBeTruthy();

			fireEvent.click(screen.getByRole("button", { name: "whaloc Test Business" }));

			expect(expandedOf("whaloc Test Business")).toBe("false");
			expect(screen.queryByRole("heading", { name: "+55 11 91234-5678" })).toBeNull();
		});

		it("says which accounts have an app subscribed without expanding them", () => {
			const state = threeWabas();

			renderSettings({
				server: { ...state, wabas: state.wabas.map(waba => ({ ...waba, subscribedAt: "2026-09-01T10:00:00.000Z" })) },
				wabaId: SECOND_WABA_ID,
			});

			// One short badge per header, plus the row inside the one card that is open.
			expect(screen.getAllByText("subscribed")).toHaveLength(3);
			expect(screen.getAllByText("app subscribed")).toHaveLength(1);
		});
	});

	/** The subscription is read-only in the UI: only the app under test can subscribe (SPEC §2.20). */
	it("says whether an app is subscribed to the WABA's webhooks", () => {
		renderSettings();

		expect(screen.getByText("no app subscribed")).toBeTruthy();
		expect(screen.getByText(/registers whaloc/)).toBeTruthy();

		renderSettings({
			server: makeStateResponse({
				wabas: [
					{
						id: WABA_ID,
						name: "whaloc Test Business",
						subscribedAt: "2026-09-01T10:00:00.000Z",
						phoneNumbers: [makePhoneNumber()],
					},
				],
			}),
		});

		expect(screen.getByText("app subscribed")).toBeTruthy();
	});

	it("creates a WABA and shows it straight away", async () => {
		const created = {
			id: "102290129340398",
			name: "Second Business",
			subscribedAt: null,
			createdAt: "2026-09-01T10:00:00.000Z",
		};

		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: created }, 201)));
		renderSettings();

		// The same dialog the breadcrumb's "Create WABA…" opens (SPEC §5).
		fireEvent.click(screen.getByRole("button", { name: "Create WABA…" }));
		fireEvent.change(screen.getByLabelText("New WABA name"), { target: { value: "Second Business" } });
		fireEvent.click(screen.getByRole("button", { name: "Add WABA" }));

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "Second Business" })).toBeTruthy();
		});

		const [path, init] = fetchMock.mock.calls[0] ?? [];

		expect(path).toBe("/api/wabas");
		expect(init?.method).toBe("POST");
		expect(requestBodyOf(fetchMock)).toEqual({ name: "Second Business" });
	});

	it("does not post a nameless WABA, or a phone number missing a field", () => {
		renderSettings();

		fireEvent.click(screen.getByRole("button", { name: "Create WABA…" }));
		fireEvent.click(screen.getByRole("button", { name: "Add WABA" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

		fireEvent.click(screen.getByRole("button", { name: "Add a phone number to whaloc Test Business" }));
		fireEvent.change(screen.getByLabelText("New phone number display number"), { target: { value: "+1 631" } });
		fireEvent.click(screen.getByRole("button", { name: "Add phone number" }));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("deletes a WABA only after the confirmation", async () => {
		fetchMock = stubFetch(() =>
			Promise.resolve(
				jsonResponse({
					data: {
						id: WABA_ID,
						name: "whaloc Test Business",
						subscribedAt: null,
						createdAt: "2026-09-01T10:00:00.000Z",
					},
				}),
			),
		);
		renderSettings();

		fireEvent.click(screen.getByRole("button", { name: "Delete WABA whaloc Test Business" }));
		expect(fetchMock).not.toHaveBeenCalled();

		const dialog = screen.getByRole("dialog", { name: "Delete whaloc Test Business?" });

		expect(within(dialog).getByText(/phone number\(s\) are deleted too/)).toBeTruthy();

		fireEvent.click(within(dialog).getByRole("button", { name: "Delete WABA" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		const [path, init] = fetchMock.mock.calls[0] ?? [];

		expect(path).toBe(`/api/wabas/${WABA_ID}`);
		expect(init?.method).toBe("DELETE");
		// The reducer drops it, so the page falls back to its empty state.
		await waitFor(() => {
			expect(screen.getByText(/No WABA left/)).toBeTruthy();
		});
	});

	it("adds a phone number under its WABA", async () => {
		const created = makePhoneNumber({ id: "111222333444555", displayPhoneNumber: "+1 631-555-5555" });

		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: created }, 201)));
		renderSettings();

		fireEvent.click(screen.getByRole("button", { name: "Add a phone number to whaloc Test Business" }));
		fireEvent.change(screen.getByLabelText("New phone number display number"), {
			target: { value: "+1 631-555-5555" },
		});
		fireEvent.change(screen.getByLabelText("New phone number verified name"), {
			target: { value: "Jasper's Market" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add phone number" }));

		await waitFor(() => {
			expect(screen.getByRole("heading", { name: "+1 631-555-5555" })).toBeTruthy();
		});

		expect(requestBodyOf(fetchMock)).toEqual({
			wabaId: WABA_ID,
			displayPhoneNumber: "+1 631-555-5555",
			verifiedName: "Jasper's Market",
		});
	});

	it("deletes a phone number after the confirmation, leaving the WABA empty", async () => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: makePhoneNumber() })));
		renderSettings();

		fireEvent.click(screen.getByRole("button", { name: "Delete +55 11 91234-5678" }));

		const dialog = screen.getByRole("dialog", { name: "Delete +55 11 91234-5678?" });

		fireEvent.click(within(dialog).getByRole("button", { name: "Delete phone number" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(`/api/phone-numbers/${PHONE_NUMBER_ID}`, expect.anything());
		});

		await waitFor(() => {
			expect(screen.getByText(/No phone numbers yet/)).toBeTruthy();
		});
	});

	it("shows a pending verification code, copyable, with what to do with it", () => {
		renderSettings({
			server: makeStateResponse({
				wabas: [
					{
						id: WABA_ID,
						name: "whaloc Test Business",
						subscribedAt: null,
						phoneNumbers: [
							makePhoneNumber({
								status: "UNVERIFIED",
								codeVerificationStatus: "NOT_VERIFIED",
								pendingVerification: { code: "123456", method: "SMS", language: "en_US" },
							}),
						],
					},
				],
			}),
		});

		expect(screen.getByText("verification code")).toBeTruthy();
		expect(screen.getByText("123456")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy verification code" })).toBeTruthy();
		expect(screen.getByText(/requested by SMS in en_US/)).toBeTruthy();
		// A number off the Cloud API says what a send would answer.
		expect(screen.getByText(/133010/)).toBeTruthy();
		expect(screen.getByText("UNVERIFIED")).toBeTruthy();
	});

	it("edits a phone number through its dialog", async () => {
		const updated = makePhoneNumber({ verifiedName: "Renamed Business" });

		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: updated })));
		renderSettings();

		fireEvent.click(screen.getByRole("button", { name: "Edit +55 11 91234-5678" }));
		fireEvent.change(screen.getByLabelText("Verified name"), { target: { value: "Renamed Business" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		const [path, init] = fetchMock.mock.calls[0] ?? [];

		expect(path).toBe(`/api/phone-numbers/${PHONE_NUMBER_ID}`);
		expect(init?.method).toBe("PATCH");
		expect(requestBodyOf(fetchMock)).toEqual({
			displayPhoneNumber: "+55 11 91234-5678",
			verifiedName: "Renamed Business",
		});
	});

	/** Contacts, their business-scoped identity and the number-change action (SPEC §1.15, §5). */
	describe("contacts", () => {
		it("shows the BSUID of a contact that has one, and nothing for a contact that has not", () => {
			renderSettings({
				contacts: [makeContact({ userId: "BR.ENT.4KgQ2wJ8" }), makeContact({ waId: "5511900000000" })],
			});

			expect(screen.getByLabelText(`BSUID of ${CONTACT_WA_ID}`)).toHaveProperty("value", "BR.ENT.4KgQ2wJ8");
			expect(screen.getByLabelText("BSUID of 5511900000000")).toHaveProperty("value", "");
		});

		it("creates a contact with a BSUID", async () => {
			fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: makeContact({ userId: "US.4KgQ2wJ8" }) }, 201)));
			renderSettings({ contacts: [] });

			fireEvent.change(screen.getByLabelText("New contact wa_id"), { target: { value: "16505551234" } });
			fireEvent.change(screen.getByLabelText("New contact profile name"), { target: { value: "Sheena Nelson" } });
			fireEvent.change(screen.getByLabelText("New contact BSUID"), { target: { value: "US.4KgQ2wJ8" } });
			fireEvent.click(screen.getByRole("button", { name: "Add contact" }));

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalled();
			});

			expect(requestBodyOf(fetchMock)).toEqual({
				waId: "16505551234",
				profileName: "Sheena Nelson",
				userId: "US.4KgQ2wJ8",
			});
		});

		// Meta's own shape, checked before the request so the mistake is named where it was made.
		it("does not post a BSUID that is not one", () => {
			renderSettings({ contacts: [makeContact()] });

			fireEvent.blur(screen.getByLabelText(`BSUID of ${CONTACT_WA_ID}`), { target: { value: "not a bsuid" } });

			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("sets one on an existing contact, and clears it with a blank field", async () => {
			// The card reloads the list after every edit, so the stub answers both shapes.
			fetchMock = stubFetch((_path, init) =>
				Promise.resolve(jsonResponse(init?.method === undefined ? { data: [makeContact()] } : { data: makeContact() })),
			);
			renderSettings({ contacts: [makeContact({ userId: "BR.ENT.4KgQ2wJ8" })] });

			fireEvent.blur(screen.getByLabelText(`BSUID of ${CONTACT_WA_ID}`), { target: { value: "US.4KgQ2wJ8" } });

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalled();
			});

			expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/contacts/${CONTACT_WA_ID}`);
			expect(requestBodyOf(fetchMock)).toEqual({ userId: "US.4KgQ2wJ8" });

			fireEvent.blur(screen.getByLabelText(`BSUID of ${CONTACT_WA_ID}`), { target: { value: "  " } });

			await waitFor(() => {
				expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
			});

			expect(requestBodyOf(fetchMock, 2)).toEqual({ userId: null });
		});

		it("changes a contact's number through the dialog", async () => {
			const moved = makeContact({ waId: "5511900000000" });

			fetchMock = stubFetch((_path, init) =>
				Promise.resolve(jsonResponse(init?.method === undefined ? { data: [moved] } : { data: moved })),
			);
			renderSettings({ contacts: [makeContact()] });

			fireEvent.click(screen.getByRole("button", { name: "Number…" }));

			const dialog = screen.getByRole("dialog", { name: "User changed number?" });

			expect(within(dialog).getByText(new RegExp(`moves off ${CONTACT_WA_ID}`))).toBeTruthy();

			fireEvent.change(within(dialog).getByLabelText("New wa_id"), { target: { value: "5511900000000" } });
			fireEvent.click(within(dialog).getByRole("button", { name: "Change number" }));

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalled();
			});

			const [path, init] = fetchMock.mock.calls[0] ?? [];

			expect(path).toBe(`/api/contacts/${CONTACT_WA_ID}/change-number`);
			expect(init?.method).toBe("POST");
			expect(requestBodyOf(fetchMock)).toEqual({ waId: "5511900000000" });

			// The store applied the move, so the table already shows the new number.
			await waitFor(() => {
				expect(screen.getByLabelText("BSUID of 5511900000000")).toBeTruthy();
			});
		});

		it("does not post a number change with no number", () => {
			renderSettings({ contacts: [makeContact()] });

			fireEvent.click(screen.getByRole("button", { name: "Number…" }));
			fireEvent.click(screen.getByRole("button", { name: "Change number" }));

			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
