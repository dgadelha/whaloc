import type { WsEvent } from "@whaloc/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./app.tsx";
import { StoreProvider, useDispatch } from "./store/store.tsx";
import type { AppState } from "./store/types.ts";
import {
	jsonResponse,
	makeAppState,
	makePhoneNumber,
	makeStateResponse,
	makeTemplate,
	makeTwoWabaState,
	PHONE_NUMBER_ID,
	SECOND_PHONE_NUMBER_ID,
	SECOND_WABA_ID,
	stubFetch,
	WABA_ID,
	type FetchMock,
} from "./test/factories.ts";

/**
 * The shell and the routes it frames (SPEC §5, §8).
 *
 * whaloc's world is a hierarchy — accounts, then numbers — so the shell is a **top bar with a
 * breadcrumb**, and the breadcrumb is the URL: `/w/:wabaId/p/:phoneNumberId/chats` for the view
 * scoped to a number, `/w/:wabaId/templates` for the one scoped to an account, bare paths for
 * the two that are about the whole instance. These tests are mostly about that agreement —
 * where a path lands, what the bar shows for it, and what happens when a path names something
 * that is no longer there.
 */

const CHATS_PATH = `/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats`;
const SECOND_CHATS_PATH = `/w/${SECOND_WABA_ID}/p/${SECOND_PHONE_NUMBER_ID}/chats`;

function Path() {
	return <span data-testid="path">{useLocation().pathname}</span>;
}

/** Publishes a WebSocket frame into the store the way the socket would. */
function Socket(props: { event: WsEvent }) {
	const dispatch = useDispatch();

	return (
		<button
			type="button"
			onClick={() => {
				dispatch({ type: "ws/event", event: props.event });
			}}
		>
			publish
		</button>
	);
}

function renderAt(path: string, state: Partial<AppState> = {}, event?: WsEvent): void {
	render(
		<MemoryRouter initialEntries={[path]}>
			<StoreProvider isLive={false} preloadedState={makeAppState(state)}>
				<App />
				<Path />
				{event !== undefined && <Socket event={event} />}
			</StoreProvider>
		</MemoryRouter>,
	);
}

function currentPath(): string {
	return screen.getByTestId("path").textContent;
}

/** The two accounts state, with the store scoped to the first one — what a bootstrap leaves. */
const TWO_WABAS: Partial<AppState> = { server: makeTwoWabaState() };

describe("App", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(path => {
			if (path.startsWith("/api/conversations")) {
				return Promise.resolve(jsonResponse({ data: [], paging: { before: null } }));
			}

			if (path.startsWith("/api/templates")) {
				return Promise.resolve(jsonResponse({ data: [makeTemplate()] }));
			}

			if (path.startsWith("/api/webhook-deliveries")) {
				return Promise.resolve(jsonResponse({ data: [], paging: { before: null } }));
			}

			return Promise.resolve(jsonResponse({ data: [] }));
		});
	});

	afterEach(() => {
		globalThis.localStorage.clear();
	});

	describe("the views", () => {
		it("shows the four tabs, with the live indicator", () => {
			renderAt(CHATS_PATH);

			for (const label of ["Chats", "Templates", "Webhooks", "Settings"]) {
				expect(screen.getByRole("link", { name: label })).toBeTruthy();
			}

			expect(screen.getByText("connecting…")).toBeTruthy();
		});

		it("marks the tab the route is on", () => {
			renderAt(`/w/${WABA_ID}/templates`);

			expect(screen.getByRole("link", { name: "Templates" }).getAttribute("aria-current")).toBe("page");
			expect(screen.getByRole("link", { name: "Chats" }).getAttribute("aria-current")).toBeNull();
		});

		it("asks for the conversations of the phone number in the path", async () => {
			renderAt(CHATS_PATH);

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledWith(
					`/api/conversations?phoneNumberId=${PHONE_NUMBER_ID}`,
					expect.anything(),
				);
			});
			expect(screen.getByText(/Pick a conversation/)).toBeTruthy();
		});

		it("loads and lists the templates of the WABA in the path", async () => {
			renderAt(`/w/${WABA_ID}/templates`);

			await waitFor(() => {
				expect(screen.getByRole("button", { name: "order_update" })).toBeTruthy();
			});

			expect(fetchMock).toHaveBeenCalledWith(`/api/templates?wabaId=${WABA_ID}`, expect.anything());

			// `PENDING` is also one of the filter's options, so the badge is looked up in the table.
			const table = screen.getByRole("table");

			expect(within(table).getByText("PENDING")).toBeTruthy();
			expect(within(table).getByText("UTILITY")).toBeTruthy();
		});

		it("renders the delivery log with its target bar", async () => {
			renderAt("/webhooks");

			await waitFor(() => {
				expect(screen.getByRole("button", { name: "Verify webhook" })).toBeTruthy();
			});
			expect(screen.getByText(/Nothing delivered yet/)).toBeTruthy();
		});

		it("renders the settings from the state it booted with", () => {
			renderAt("/settings");

			// The breadcrumb is gone on this view, so the id in the card is the only one on screen.
			expect(screen.getByRole("heading", { name: "whaloc Test Business" })).toBeTruthy();
			expect(screen.getByText(PHONE_NUMBER_ID)).toBeTruthy();
			// `read: null` in the behavior config means the receipt is a button, not a timer.
			expect(screen.getByText(/manual — mark it from a message's menu/)).toBeTruthy();
		});
	});

	/** The breadcrumb goes exactly as deep as the view on screen is scoped. */
	describe("the breadcrumb", () => {
		it("shows the account and the number on Chats", () => {
			renderAt(CHATS_PATH);

			expect(screen.getByRole("button", { name: "WABA" }).textContent).toContain("whaloc Test Business");
			expect(screen.getByRole("button", { name: "Phone number" }).textContent).toContain("+55 11 91234-5678");
		});

		// Even with one account: it is the anchor of the hierarchy, and hiding it would teach the
		// wrong shape of the world to whoever is looking at whaloc for the first time.
		it("names the account even when there is only one", () => {
			renderAt(CHATS_PATH);

			expect(screen.getByRole("button", { name: "WABA" }).textContent).toContain("whaloc Test Business");
		});

		it("stops at the account on Templates", () => {
			renderAt(`/w/${WABA_ID}/templates`);

			expect(screen.getByRole("button", { name: "WABA" })).toBeTruthy();
			expect(screen.queryByRole("button", { name: "Phone number" })).toBeNull();
		});

		it("carries no scope at all on the global views", () => {
			renderAt("/webhooks");

			expect(screen.queryByRole("button", { name: "WABA" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Phone number" })).toBeNull();

			renderAt("/settings");

			expect(screen.queryByRole("button", { name: "WABA" })).toBeNull();
		});

		it("lists every account, and switches to the one picked", async () => {
			renderAt(CHATS_PATH, TWO_WABAS);

			fireEvent.click(screen.getByRole("button", { name: "WABA" }));

			const menu = screen.getByRole("menu", { name: "WABA" });

			expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(2);
			expect(
				within(menu)
					.getByRole("menuitemradio", { name: /whaloc Test Business/ })
					.getAttribute("aria-checked"),
			).toBe("true");

			fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Second Business/ }));

			await waitFor(() => {
				expect(currentPath()).toBe(SECOND_CHATS_PATH);
			});
		});

		it("lists the numbers of the account it is under, and switches to the one picked", async () => {
			renderAt(CHATS_PATH, {
				server: makeStateResponse({
					wabas: [
						{
							id: WABA_ID,
							name: "whaloc Test Business",
							subscribedAt: null,
							phoneNumbers: [
								makePhoneNumber(),
								makePhoneNumber({
									id: SECOND_PHONE_NUMBER_ID,
									displayPhoneNumber: "+1 631-555-5555",
									status: "PENDING",
								}),
							],
						},
					],
				}),
			});

			fireEvent.click(screen.getByRole("button", { name: "Phone number" }));

			const menu = screen.getByRole("menu", { name: "Phone number" });

			// A number that cannot send says so where it is picked, not three clicks away.
			expect(within(menu).getByRole("menuitemradio", { name: /\+1 631-555-5555/ }).textContent).toContain("PENDING");

			fireEvent.click(within(menu).getByRole("menuitemradio", { name: /\+1 631-555-5555/ }));

			await waitFor(() => {
				expect(currentPath()).toBe(`/w/${WABA_ID}/p/${SECOND_PHONE_NUMBER_ID}/chats`);
			});
		});

		it("opens the shared create dialogs from the end of each menu", () => {
			renderAt(CHATS_PATH);

			fireEvent.click(screen.getByRole("button", { name: "WABA" }));
			fireEvent.click(screen.getByRole("menuitem", { name: "Create WABA…" }));

			expect(within(screen.getByRole("dialog", { name: "Add a WABA" })).getByLabelText("New WABA name")).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

			fireEvent.click(screen.getByRole("button", { name: "Phone number" }));
			fireEvent.click(screen.getByRole("menuitem", { name: "Add number…" }));

			const dialog = screen.getByRole("dialog", { name: "Add a phone number" });

			expect(within(dialog).getByLabelText("New phone number display number")).toBeTruthy();
			expect(within(dialog).getByLabelText("New phone number verified name")).toBeTruthy();
		});

		/** The menu-button keyboard contract: arrows move, Escape closes and hands focus back. */
		it("is operable from the keyboard", () => {
			renderAt(CHATS_PATH, TWO_WABAS);

			const button = screen.getByRole("button", { name: "WABA" });

			expect(button.getAttribute("aria-expanded")).toBe("false");

			fireEvent.keyDown(button, { key: "ArrowDown" });

			const menu = screen.getByRole("menu", { name: "WABA" });

			expect(button.getAttribute("aria-expanded")).toBe("true");
			// Opens on the account that is current, not on the top of the list.
			expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: /whaloc Test Business/ }));

			fireEvent.keyDown(menu, { key: "ArrowDown" });
			expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: /Second Business/ }));

			fireEvent.keyDown(menu, { key: "End" });
			expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Create WABA…" }));

			fireEvent.keyDown(menu, { key: "Escape" });

			expect(screen.queryByRole("menu")).toBeNull();
			expect(document.activeElement).toBe(button);
		});
	});

	describe("moving between views", () => {
		it("keeps both segments going to Chats and the account going to Templates", async () => {
			renderAt(SECOND_CHATS_PATH, TWO_WABAS);

			fireEvent.click(screen.getByRole("link", { name: "Templates" }));

			await waitFor(() => {
				expect(currentPath()).toBe(`/w/${SECOND_WABA_ID}/templates`);
			});

			fireEvent.click(screen.getByRole("link", { name: "Chats" }));

			await waitFor(() => {
				expect(currentPath()).toBe(SECOND_CHATS_PATH);
			});
		});

		it("drops the scope on the global views, and finds it again on the way back", async () => {
			renderAt(SECOND_CHATS_PATH, TWO_WABAS);

			fireEvent.click(screen.getByRole("link", { name: "Webhooks" }));

			await waitFor(() => {
				expect(currentPath()).toBe("/webhooks");
			});

			fireEvent.click(screen.getByRole("link", { name: "Chats" }));

			await waitFor(() => {
				expect(currentPath()).toBe(SECOND_CHATS_PATH);
			});
		});
	});

	describe("landing without a scope", () => {
		it("sends the root into the default scope", async () => {
			renderAt("/");

			await waitFor(() => {
				expect(currentPath()).toBe(CHATS_PATH);
			});
		});

		it("sends a bare view path into the default scope", async () => {
			renderAt("/templates");

			await waitFor(() => {
				expect(currentPath()).toBe(`/w/${WABA_ID}/templates`);
			});
		});

		it("sends an unknown path to Chats", async () => {
			renderAt("/nonsense");

			await waitFor(() => {
				expect(currentPath()).toBe(CHATS_PATH);
			});
		});

		it("lands in the scope this browser used last", async () => {
			globalThis.localStorage.setItem(
				"whaloc:last-scope",
				JSON.stringify({ wabaId: SECOND_WABA_ID, phoneNumberId: SECOND_PHONE_NUMBER_ID }),
			);
			renderAt("/", TWO_WABAS);

			await waitFor(() => {
				expect(currentPath()).toBe(SECOND_CHATS_PATH);
			});
		});

		it("remembers the scope a visit ended on", async () => {
			renderAt(SECOND_CHATS_PATH, TWO_WABAS);

			await waitFor(() => {
				expect(globalThis.localStorage.getItem("whaloc:last-scope")).toBe(
					JSON.stringify({ wabaId: SECOND_WABA_ID, phoneNumberId: SECOND_PHONE_NUMBER_ID }),
				);
			});
		});

		// A link from before this shell: the thread it names still opens.
		it("carries an old-style conversation link into its scope", async () => {
			renderAt(`/chats/${PHONE_NUMBER_ID}:5511912345678`);

			await waitFor(() => {
				expect(currentPath()).toBe(`${CHATS_PATH}/5511912345678`);
			});
		});
	});

	describe("a path that names something that is gone", () => {
		it("moves off an unknown WABA and says so", async () => {
			renderAt(`/w/999999999999999/p/${PHONE_NUMBER_ID}/chats`);

			await waitFor(() => {
				expect(currentPath()).toBe(CHATS_PATH);
			});

			expect(screen.getByText(/That WABA is gone/)).toBeTruthy();
		});

		it("moves off an unknown phone number and says so", async () => {
			renderAt(`/w/${WABA_ID}/p/999999999999999/chats`);

			await waitFor(() => {
				expect(currentPath()).toBe(CHATS_PATH);
			});

			expect(screen.getByText(/That phone number is gone/)).toBeTruthy();
		});

		it("descends into the account's first number without calling it an error", async () => {
			renderAt(`/w/${WABA_ID}/chats`);

			await waitFor(() => {
				expect(currentPath()).toBe(CHATS_PATH);
			});

			expect(screen.queryByText(/is gone/)).toBeNull();
		});

		/** The requirement behind the multi-WABA deletion tests: navigation follows the store. */
		it("follows the scope onto a sibling number when the one in the path is deleted", async () => {
			const sibling = makePhoneNumber({ id: SECOND_PHONE_NUMBER_ID, displayPhoneNumber: "+1 631-555-5555" });

			renderAt(
				CHATS_PATH,
				{
					server: makeStateResponse({
						wabas: [
							{
								id: WABA_ID,
								name: "whaloc Test Business",
								subscribedAt: null,
								phoneNumbers: [makePhoneNumber(), sibling],
							},
						],
					}),
				},
				{ type: "phone_number.changed", payload: { phoneNumber: makePhoneNumber(), event: "deleted" } },
			);

			fireEvent.click(screen.getByRole("button", { name: "publish" }));

			await waitFor(() => {
				expect(currentPath()).toBe(`/w/${WABA_ID}/p/${SECOND_PHONE_NUMBER_ID}/chats`);
			});
		});

		// The account is still there, only empty: staying on it and offering a number is honest,
		// where jumping to somebody else's account would silently change what a send would do.
		it("stays on the account when its last number is deleted", async () => {
			renderAt(CHATS_PATH, TWO_WABAS, {
				type: "phone_number.changed",
				payload: { phoneNumber: makePhoneNumber(), event: "deleted" },
			});

			fireEvent.click(screen.getByRole("button", { name: "publish" }));

			await waitFor(() => {
				expect(currentPath()).toBe(`/w/${WABA_ID}/chats`);
			});

			expect(screen.getByRole("button", { name: "Add a phone number" })).toBeTruthy();
		});

		it("follows the scope off a WABA deleted from under it", async () => {
			renderAt(CHATS_PATH, TWO_WABAS, {
				type: "waba.changed",
				payload: {
					waba: {
						id: WABA_ID,
						name: "whaloc Test Business",
						subscribedAt: null,
						createdAt: "2026-09-01T10:00:00.000Z",
					},
					event: "deleted",
				},
			});

			fireEvent.click(screen.getByRole("button", { name: "publish" }));

			await waitFor(() => {
				expect(currentPath()).toBe(SECOND_CHATS_PATH);
			});
		});
	});

	describe("an empty whaloc", () => {
		const NO_WABAS: Partial<AppState> = {
			server: makeStateResponse({ wabas: [] }),
			wabaId: null,
			phoneNumberId: null,
		};

		it("offers to create the first WABA, with every scoped tab disabled", async () => {
			renderAt("/", NO_WABAS);

			await waitFor(() => {
				expect(screen.getByRole("button", { name: "Create your first WABA" })).toBeTruthy();
			});

			for (const label of ["Chats", "Templates"]) {
				expect(screen.queryByRole("link", { name: label })).toBeNull();
				expect(screen.getByText(label).getAttribute("aria-disabled")).toBe("true");
			}

			// Settings still works: it is where a reset and an import live.
			expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
			expect(screen.getByRole("link", { name: "Webhooks" })).toBeTruthy();
		});

		// The number segment would have nothing under it and an action that cannot fire.
		it("shows only the account segment, offering the account", async () => {
			renderAt("/", NO_WABAS);

			await waitFor(() => {
				expect(screen.getByRole("button", { name: "WABA" }).textContent).toContain("No WABA");
			});

			expect(screen.queryByRole("button", { name: "Phone number" })).toBeNull();
		});

		it("opens the create dialog from that call to action", async () => {
			renderAt("/", NO_WABAS);

			await waitFor(() => {
				expect(screen.getByRole("button", { name: "Create your first WABA" })).toBeTruthy();
			});

			fireEvent.click(screen.getByRole("button", { name: "Create your first WABA" }));

			expect(screen.getByRole("dialog", { name: "Add a WABA" })).toBeTruthy();
		});

		it("sends a scoped path back to that call to action", async () => {
			renderAt(`/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats`, NO_WABAS);

			await waitFor(() => {
				expect(screen.getByRole("button", { name: "Create your first WABA" })).toBeTruthy();
			});
		});

		it("offers to add the first number of an account that has none", async () => {
			renderAt(`/w/${WABA_ID}/chats`, {
				server: makeTwoWabaState({ firstHasNumbers: false }),
				wabaId: WABA_ID,
				phoneNumberId: null,
			});

			await waitFor(() => {
				expect(currentPath()).toBe(`/w/${WABA_ID}/chats`);
			});

			fireEvent.click(screen.getByRole("button", { name: "Add a phone number" }));

			expect(screen.getByRole("dialog", { name: "Add a phone number" })).toBeTruthy();
		});
	});

	describe("the bootstrap gate", () => {
		it("says so when the control plane never answered", () => {
			renderAt("/", { phase: "failed", loadError: "boom" });

			expect(screen.getByText("whaloc is not answering")).toBeTruthy();
			expect(screen.getByText("boom")).toBeTruthy();
		});

		it("waits before rendering anything while the bootstrap is in flight", () => {
			renderAt("/", { phase: "loading" });

			expect(screen.getByText("Loading whaloc…")).toBeTruthy();
		});
	});
});
