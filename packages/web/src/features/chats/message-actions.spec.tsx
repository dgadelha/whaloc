import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeAppState, makeMessage } from "../../test/factories.ts";
import { StoreProvider } from "../../store/store.tsx";
import { MessageActions } from "./message-actions.tsx";

/**
 * The menu both directions carry (copy id, reply, react) versus the ladder only an outbound
 * message has: statuses exist for business messages alone (SPEC §4), but an inbound wamid is
 * what a mark-as-read or reaction call needs, so copying it must not require one.
 */
function renderActions(direction: "inbound" | "outbound"): void {
	render(
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			<MessageActions message={makeMessage({ direction })} onReply={() => {}} onReact={() => {}} />
		</StoreProvider>,
	);

	fireEvent.click(screen.getByRole("button", { name: "Message actions" }));
}

describe("MessageActions", () => {
	it("offers copy, reply and react on an inbound message, but no status ladder", () => {
		renderActions("inbound");

		expect(screen.getByRole("menuitem", { name: "Copy message ID" })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "Reply to this" })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "React…" })).toBeTruthy();
		expect(screen.queryByRole("menuitem", { name: "Mark delivered" })).toBeNull();
		expect(screen.queryByText("Fail as…")).toBeNull();
	});

	it("keeps the full ladder on an outbound message, copy included", () => {
		renderActions("outbound");

		expect(screen.getByRole("menuitem", { name: "Copy message ID" })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "Mark delivered" })).toBeTruthy();
		expect(screen.getByRole("menuitem", { name: "Mark read" })).toBeTruthy();
		expect(screen.getByText("Fail as…")).toBeTruthy();
	});
});
