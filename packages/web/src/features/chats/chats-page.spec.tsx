import type { WsEvent } from "@whaloc/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider, useDispatch } from "../../store/store.tsx";
import type { AppState } from "../../store/types.ts";
import {
	CONTACT_WA_ID,
	jsonResponse,
	makeAppState,
	makeContact,
	PHONE_NUMBER_ID,
	stubFetch,
	WABA_ID,
	type FetchMock,
} from "../../test/factories.ts";
import { ChatsPage } from "./chats-page.tsx";

/**
 * The chat view's half of identity simulation (SPEC §1.15, §5): the BSUID beside the number,
 * and the redirect that keeps the open conversation on the person rather than on the number they
 * used to be at — the path names the contact, so a number change renames it under the router's
 * feet.
 */
const MOVED_WA_ID = "5511900000000";
const CHATS_PATH = `/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats`;

/** Publishes a WebSocket frame into the store the way the socket would. */
function Socket(props: { event: WsEvent | null }) {
	const dispatch = useDispatch();

	return (
		<button
			type="button"
			onClick={() => {
				if (props.event !== null) {
					dispatch({ type: "ws/event", event: props.event });
				}
			}}
		>
			publish
		</button>
	);
}

function Path() {
	return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderChat(state: Partial<AppState> = {}, event: WsEvent | null = null): void {
	render(
		<MemoryRouter initialEntries={[`${CHATS_PATH}/${CONTACT_WA_ID}`]}>
			<StoreProvider isLive={false} preloadedState={makeAppState({ contacts: [makeContact()], ...state })}>
				<Socket event={event} />
				<Path />
				<Routes>
					<Route path="/w/:wabaId/p/:phoneNumberId/chats/:contactWaId" element={<ChatsPage />} />
				</Routes>
			</StoreProvider>
		</MemoryRouter>,
	);
}

describe("ChatsPage", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(path =>
			Promise.resolve(jsonResponse(path.includes("/messages") ? { data: [], paging: { before: null } } : { data: [] })),
		);
	});

	/** The header's title block: the profile name, the number, and the BSUID when there is one. */
	function chatTitle(): HTMLElement {
		return screen.getByRole("heading", { name: "Ana Souza" }).parentElement!;
	}

	it("shows the contact's BSUID beside its number", () => {
		renderChat({ contacts: [makeContact({ userId: "BR.ENT.4KgQ2wJ8" })] });

		const title = within(chatTitle());

		expect(title.getByText(CONTACT_WA_ID)).toBeTruthy();
		expect(title.getByTitle("Business-scoped user ID").textContent).toBe("BR.ENT.4KgQ2wJ8");
		expect(fetchMock).toHaveBeenCalled();
	});

	it("leaves the header without a BSUID for a contact that has none", () => {
		renderChat();

		expect(screen.queryByTitle("Business-scoped user ID")).toBeNull();
	});

	/** The requirement behind #14: the view follows the person, wherever the move was made. */
	it("follows a contact that changed number instead of stranding the conversation", async () => {
		renderChat(
			{},
			{
				type: "contact.changed",
				payload: { contact: makeContact({ waId: MOVED_WA_ID }), previousWaId: CONTACT_WA_ID },
			},
		);

		expect(screen.getByTestId("path").textContent).toBe(`${CHATS_PATH}/${CONTACT_WA_ID}`);

		fireEvent.click(screen.getByRole("button", { name: "publish" }));

		await waitFor(() => {
			expect(screen.getByTestId("path").textContent).toBe(`${CHATS_PATH}/${MOVED_WA_ID}`);
		});

		expect(within(chatTitle()).getByText(MOVED_WA_ID)).toBeTruthy();
	});

	it("opens the number-change dialog from the header", () => {
		renderChat();

		fireEvent.click(screen.getByRole("button", { name: "Changed number…" }));

		const dialog = screen.getByRole("dialog", { name: "User changed number?" });

		expect(within(dialog).getByLabelText("New wa_id")).toBeTruthy();
	});
});
