import type { Message } from "@whaloc/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import {
	CONTACT_WA_ID,
	jsonResponse,
	makeAppState,
	makeMessage,
	PHONE_NUMBER_ID,
	requestBodyOf,
	stubFetch,
	type FetchMock,
} from "../../test/factories.ts";
import { MessageBody } from "./message-body.tsx";

/**
 * The interactive menus the app under test sends, tapped through the DOM: what each tap puts on
 * `POST /api/inbound`. A reply carries the menu's own `id`/`title` and quotes the menu, the
 * `context` Meta attaches to a real reply.
 */

const MENU_ID = "wamid.menu";

function renderInteractive(interactive: Record<string, unknown>, overrides: Partial<Message> = {}): void {
	render(
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			<MessageBody
				message={makeMessage({ id: MENU_ID, type: "interactive", payload: { interactive }, ...overrides })}
			/>
		</StoreProvider>,
	);
}

const BUTTON_MENU = {
	type: "button",
	body: { text: "Ready for the turnover?" },
	action: {
		buttons: [
			{ type: "reply", reply: { id: "start-yes", title: "Yes" } },
			{ type: "reply", reply: { id: "start-later", title: "Later" } },
		],
	},
};

const LIST_MENU = {
	type: "list",
	body: { text: "When should we come?" },
	action: {
		button: "Pick a slot",
		sections: [
			{ title: "Morning", rows: [{ id: "slot-9", title: "09:00", description: "Before check-out" }] },
			{ title: "Afternoon", rows: [{ id: "slot-14", title: "14:00" }] },
		],
	},
};

describe("interactive menus", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: makeMessage({ direction: "inbound" }) }, 201)));
	});

	it("sends a button_reply quoting the menu when a reply button is tapped", async () => {
		renderInteractive(BUTTON_MENU);

		fireEvent.click(screen.getByRole("button", { name: "Later" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/inbound");
		expect(requestBodyOf(fetchMock)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			from: CONTACT_WA_ID,
			replyTo: MENU_ID,
			type: "interactive",
			interactive: { type: "button_reply", button_reply: { id: "start-later", title: "Later" } },
		});
	});

	it("opens a list on its button, showing the sections and the rows with their descriptions", () => {
		renderInteractive(LIST_MENU);

		expect(screen.queryByText("Morning")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Pick a slot" }));

		const dialog = screen.getByRole("dialog", { name: "Pick a slot" });

		expect(dialog.textContent).toContain("Morning");
		expect(dialog.textContent).toContain("Afternoon");
		expect(dialog.textContent).toContain("Before check-out");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends a list_reply with the row's id, title and description when a row is picked", async () => {
		renderInteractive(LIST_MENU);

		fireEvent.click(screen.getByRole("button", { name: "Pick a slot" }));
		fireEvent.click(screen.getByRole("button", { name: /09:00/ }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			from: CONTACT_WA_ID,
			replyTo: MENU_ID,
			type: "interactive",
			interactive: {
				type: "list_reply",
				list_reply: { id: "slot-9", title: "09:00", description: "Before check-out" },
			},
		});
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("leaves the description out for a row that has none", async () => {
		renderInteractive(LIST_MENU);

		fireEvent.click(screen.getByRole("button", { name: "Pick a slot" }));
		fireEvent.click(screen.getByRole("button", { name: "14:00" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toMatchObject({
			interactive: { type: "list_reply", list_reply: { id: "slot-14", title: "14:00" } },
		});
		expect(requestBodyOf(fetchMock)).not.toHaveProperty("interactive.list_reply.description");
	});

	it("sends a row's id, title and description exactly as the menu has them, whitespace included", async () => {
		renderInteractive({
			type: "list",
			action: {
				button: "Pick a slot",
				sections: [{ rows: [{ id: " slot-9 ", title: " 09:00 ", description: " Before check-out " }] }],
			},
		});

		fireEvent.click(screen.getByRole("button", { name: "Pick a slot" }));
		fireEvent.click(screen.getByRole("button", { name: /09:00/ }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toMatchObject({
			interactive: {
				type: "list_reply",
				list_reply: { id: " slot-9 ", title: " 09:00 ", description: " Before check-out " },
			},
		});
	});

	it("keeps a row's explicitly empty description", async () => {
		renderInteractive({
			type: "list",
			action: { button: "Pick a slot", sections: [{ rows: [{ id: "slot-9", title: "09:00", description: "" }] }] },
		});

		fireEvent.click(screen.getByRole("button", { name: "Pick a slot" }));
		fireEvent.click(screen.getByRole("button", { name: /09:00/ }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toMatchObject({
			interactive: { type: "list_reply", list_reply: { id: "slot-9", title: "09:00", description: "" } },
		});
	});

	it("sends a reply button's id and title untrimmed", async () => {
		renderInteractive({
			type: "button",
			action: { buttons: [{ type: "reply", reply: { id: " start-yes ", title: " Yes " } }] },
		});

		fireEvent.click(screen.getByRole("button", { name: "Yes" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		expect(requestBodyOf(fetchMock)).toMatchObject({
			interactive: { type: "button_reply", button_reply: { id: " start-yes ", title: " Yes " } },
		});
	});

	it("opens a cta_url button's link instead of sending anything", () => {
		renderInteractive({
			type: "cta_url",
			body: { text: "Your checklist is ready." },
			action: { name: "cta_url", parameters: { display_text: "Open checklist", url: "https://irl.test/checklist" } },
		});

		const link = screen.getByRole("link", { name: /Open checklist/ });

		expect(link.getAttribute("href")).toBe("https://irl.test/checklist");
		expect(link.getAttribute("target")).toBe("_blank");

		fireEvent.click(link);

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
