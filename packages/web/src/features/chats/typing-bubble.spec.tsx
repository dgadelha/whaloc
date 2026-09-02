import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import {
	CONTACT_WA_ID,
	CONVERSATION_ID,
	makeAppState,
	makeMessage,
	PHONE_NUMBER_ID,
	WABA_ID,
} from "../../test/factories.ts";
import { ConversationList } from "./conversation-list.tsx";
import { MessageBubble } from "./message-bubble.tsx";
import { MessageList } from "./message-list.tsx";
import { TypingBubble } from "./typing-bubble.tsx";

/**
 * The two things a read receipt with a typing indicator changes on screen (SPEC §2.18): a
 * bubble at the end of the thread while the app under test is typing, and a marker on the
 * user's own message once the business has read it.
 */
function renderList(isTyping: boolean): void {
	// Every bubble carries the actions menu now (copy id at minimum), which reads the store.
	render(
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			<MessageList
				messages={[makeMessage({ id: "wamid.1", direction: "inbound" })]}
				isTyping={isTyping}
				hasMore={false}
				loadingOlder={false}
				onLoadOlder={() => {}}
				onReply={() => {}}
				onReact={() => {}}
			/>
		</StoreProvider>,
	);
}

function renderBubble(status: "delivered" | "read", direction: "inbound" | "outbound" = "inbound"): void {
	// An outbound bubble carries the manual ladder actions, which read the store.
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			{children}
		</StoreProvider>
	);

	render(
		<MessageBubble
			message={makeMessage({ direction, status })}
			reactions={[]}
			repliedTo={null}
			onReply={() => {}}
			onReact={() => {}}
		/>,
		{ wrapper },
	);
}

describe("TypingBubble", () => {
	it("announces itself as a status region", () => {
		render(<TypingBubble />);

		const bubble = screen.getByRole("status", { name: "typing" });

		// Three dots, animated in CSS; the markup is what a test can hold on to.
		expect(bubble.querySelectorAll(".typing-dots__dot")).toHaveLength(3);
	});

	it("sits on the outbound side, because the app under test is the one typing", () => {
		render(<TypingBubble />);

		expect(screen.getByRole("status", { name: "typing" }).className).toContain("bubble--out");
	});
});

describe("MessageList", () => {
	it("shows the typing bubble only while the indicator is up", () => {
		renderList(false);
		expect(screen.queryByRole("status", { name: "typing" })).toBeNull();

		renderList(true);
		expect(screen.getByRole("status", { name: "typing" })).toBeTruthy();
	});
});

describe("MessageBubble, read receipts", () => {
	it("marks an inbound message the business has read", () => {
		renderBubble("read");

		expect(screen.getByRole("img", { name: "read by the business" })).toBeTruthy();
	});

	it("leaves an unread inbound message unmarked", () => {
		renderBubble("delivered");

		expect(screen.queryByRole("img", { name: "read by the business" })).toBeNull();
	});

	it("keeps the outbound ticks for the other direction", () => {
		renderBubble("read", "outbound");

		expect(screen.queryByRole("img", { name: "read by the business" })).toBeNull();
		expect(screen.getByRole("img", { name: "read" })).toBeTruthy();
	});
});

describe("ConversationList", () => {
	function renderConversations(typing: Record<string, string>): void {
		const wrapper = ({ children }: { children: ReactNode }) => (
			<MemoryRouter>
				<StoreProvider isLive={false} preloadedState={makeAppState({ typing })}>
					{children}
				</StoreProvider>
			</MemoryRouter>
		);

		render(
			<ConversationList
				conversations={[
					{
						id: CONVERSATION_ID,
						phoneNumberId: PHONE_NUMBER_ID,
						contactWaId: CONTACT_WA_ID,
						contact: null,
						messageCount: 1,
						lastMessageAt: "2026-08-31T12:00:00.000Z",
						lastMessage: makeMessage({ payload: { text: { body: "the last thing said" } } }),
					},
				]}
				activeId={null}
				wabaId={WABA_ID}
				phoneNumberId={PHONE_NUMBER_ID}
			/>,
			{ wrapper },
		);
	}

	it("previews the last message when nobody is typing", () => {
		renderConversations({});

		expect(screen.getByText("the last thing said")).toBeTruthy();
		expect(screen.queryByText("typing…")).toBeNull();
	});

	it("shows typing… instead, the way WhatsApp's own list does", () => {
		renderConversations({ [CONVERSATION_ID]: "2026-08-31T12:00:25.000Z" });

		expect(screen.getByText("typing…")).toBeTruthy();
		expect(screen.queryByText("the last thing said")).toBeNull();
	});
});
