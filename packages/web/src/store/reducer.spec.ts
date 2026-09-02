import { conversationId, type Message, type WsEvent } from "@whaloc/shared";
import { describe, expect, it } from "vitest";
import {
	CONTACT_WA_ID,
	CONVERSATION_ID,
	makeAppState,
	makeContact,
	makeDelivery,
	makeInjectionRule,
	makeMessage,
	makePhoneNumber,
	makeStateResponse,
	makeTemplate,
	makeToken,
	PHONE_NUMBER_ID,
	WABA_ID,
} from "../test/factories.ts";
import { insertMessage, reducer, statusRank } from "./reducer.ts";
import type { AppState } from "./types.ts";

function created(message: Message): WsEvent {
	return { type: "message.created", payload: { message } };
}

function statusChanged(message: Message, previousStatus: Message["status"]): WsEvent {
	return { type: "message.status_changed", payload: { message, previousStatus } };
}

function typingChanged(expiresAt: string | null): WsEvent {
	return {
		type: "typing.changed",
		payload: { typing: { phoneNumberId: PHONE_NUMBER_ID, contactWaId: CONTACT_WA_ID, expiresAt } },
	};
}

function apply(state: AppState, ...events: WsEvent[]): AppState {
	let current = state;

	for (const event of events) {
		current = reducer(current, { type: "ws/event", event });
	}

	return current;
}

/** A store with the conversation already loaded — the case every WS event lands in. */
function loadedState(messages: Message[] = []): AppState {
	return makeAppState({
		messages: { [CONVERSATION_ID]: messages },
		messagesBefore: { [CONVERSATION_ID]: null },
		conversations: [
			{
				id: CONVERSATION_ID,
				phoneNumberId: PHONE_NUMBER_ID,
				contactWaId: CONTACT_WA_ID,
				contact: null,
				messageCount: messages.length,
				lastMessageAt: messages.at(-1)?.timestamp ?? "2026-08-31T11:00:00.000Z",
				lastMessage: messages.at(-1) ?? null,
			},
		],
	});
}

describe("insertMessage", () => {
	it("keeps the list oldest first, wherever the message belongs", () => {
		const first = makeMessage({ id: "wamid.1", timestamp: "2026-08-31T12:00:00.000Z" });
		const third = makeMessage({ id: "wamid.3", timestamp: "2026-08-31T12:00:02.000Z" });
		const second = makeMessage({ id: "wamid.2", timestamp: "2026-08-31T12:00:01.000Z" });

		const list = insertMessage(insertMessage([], first), third);
		const complete = insertMessage(list, second);

		expect(complete.map(message => message.id)).toEqual(["wamid.1", "wamid.2", "wamid.3"]);
	});

	it("replaces a message it already has instead of duplicating it", () => {
		const message = makeMessage({ status: "sent" });
		const list = insertMessage([message], { ...message, status: "delivered" });

		expect(list).toHaveLength(1);
		expect(list[0]?.status).toBe("delivered");
	});
});

describe("statusRank", () => {
	it("orders the ladder, with failed last so it always wins", () => {
		expect(statusRank("accepted")).toBeLessThan(statusRank("sent"));
		expect(statusRank("sent")).toBeLessThan(statusRank("delivered"));
		expect(statusRank("delivered")).toBeLessThan(statusRank("read"));
		expect(statusRank("read")).toBeLessThan(statusRank("failed"));
	});
});

describe("reducer, WebSocket events", () => {
	it("adds a created message to a loaded conversation", () => {
		const message = makeMessage({ id: "wamid.new", direction: "inbound", timestamp: "2026-08-31T12:05:00.000Z" });
		const state = apply(loadedState([makeMessage()]), created(message));

		expect(state.messages[CONVERSATION_ID]?.map(entry => entry.id)).toEqual(["wamid.1", "wamid.new"]);
	});

	it("ignores a message for a conversation nobody has opened", () => {
		const state = apply(makeAppState(), created(makeMessage()));

		expect(state.messages).toEqual({});
	});

	it("moves the conversation to the top with the new preview", () => {
		const other = conversationId(PHONE_NUMBER_ID, "5511999999999");
		const base = loadedState([makeMessage()]);
		const state = apply(
			{
				...base,
				conversations: [
					{
						id: other,
						phoneNumberId: PHONE_NUMBER_ID,
						contactWaId: "5511999999999",
						contact: null,
						messageCount: 1,
						lastMessageAt: "2026-08-31T13:00:00.000Z",
						lastMessage: makeMessage({ id: "wamid.other", contactWaId: "5511999999999" }),
					},
					...(base.conversations ?? []),
				],
			},
			created(makeMessage({ id: "wamid.new", timestamp: "2026-08-31T14:00:00.000Z" })),
		);

		expect(state.conversations?.[0]?.id).toBe(CONVERSATION_ID);
		expect(state.conversations?.[0]?.lastMessage?.id).toBe("wamid.new");
		expect(state.conversations?.[0]?.messageCount).toBe(2);
	});

	it("upgrades a status", () => {
		const message = makeMessage({ status: "sent" });
		const state = apply(
			loadedState([message]),
			statusChanged({ ...message, status: "delivered" }, "sent"),
			statusChanged({ ...message, status: "read" }, "delivered"),
		);

		expect(state.messages[CONVERSATION_ID]?.[0]?.status).toBe("read");
	});

	it("never moves a status backwards, however the frames are ordered", () => {
		const message = makeMessage({ status: "sent" });
		const state = apply(
			loadedState([message]),
			statusChanged({ ...message, status: "read" }, "delivered"),
			// A `delivered` frame that overtook the `read` one must not undo it.
			statusChanged({ ...message, status: "delivered" }, "sent"),
		);

		expect(state.messages[CONVERSATION_ID]?.[0]?.status).toBe("read");
	});

	it("lets a failure win, even after read", () => {
		const message = makeMessage({ status: "read" });
		const failed = { ...message, status: "failed" as const, error: { code: 131_049 } };
		const state = apply(loadedState([message]), statusChanged(failed, "read"));

		expect(state.messages[CONVERSATION_ID]?.[0]?.status).toBe("failed");
	});

	it("does not resurrect a conversation because an old message changed status", () => {
		const old = makeMessage({ id: "wamid.old", timestamp: "2026-08-31T10:00:00.000Z", status: "sent" });
		const latest = makeMessage({ id: "wamid.latest", timestamp: "2026-08-31T12:00:00.000Z" });
		const state = apply(loadedState([old, latest]), statusChanged({ ...old, status: "delivered" }, "sent"));

		expect(state.conversations?.[0]?.lastMessage?.id).toBe("wamid.latest");
	});

	it("counts an inbound message as unread unless its conversation is open", () => {
		const inbound = makeMessage({ id: "wamid.in", direction: "inbound" });
		const counted = apply(loadedState(), created(inbound));

		expect(counted.unread[CONVERSATION_ID]).toBe(1);

		const opened = reducer(counted, { type: "conversation/opened", conversationId: CONVERSATION_ID });

		expect(opened.unread[CONVERSATION_ID]).toBeUndefined();

		// While it is open, nothing that arrives in it counts as unread.
		const whileOpen = apply(opened, created(makeMessage({ id: "wamid.in2", direction: "inbound" })));

		expect(whileOpen.unread).toEqual({});
	});

	it("does not count outbound messages as unread", () => {
		const outbound = created(makeMessage({ id: "wamid.out" }));

		expect(apply(loadedState(), outbound).unread).toEqual({});
	});

	it("prepends a webhook delivery once the log has been loaded", () => {
		const withLog = reducer(makeAppState(), {
			type: "deliveries/loaded",
			deliveries: [makeDelivery({ id: "delivery-1" })],
			before: null,
			mode: "latest",
		});
		const state = apply(withLog, {
			type: "webhook.delivery",
			payload: { delivery: makeDelivery({ id: "delivery-2" }) },
		});

		expect(state.deliveries?.map(delivery => delivery.id)).toEqual(["delivery-2", "delivery-1"]);
	});

	it("upserts a template in place", () => {
		const template = makeTemplate();
		const withTemplates = reducer(makeAppState(), { type: "templates/loaded", templates: [template] });
		const state = apply(withTemplates, {
			type: "template.changed",
			payload: { template: { ...template, status: "APPROVED" }, event: "APPROVED" },
		});

		expect(state.templates).toHaveLength(1);
		expect(state.templates?.[0]?.status).toBe("APPROVED");
	});

	it("folds a created WABA and a created phone number into the snapshot", () => {
		const waba = {
			id: "102290129340398",
			name: "Second Business",
			subscribedAt: null,
			createdAt: "2026-09-01T10:00:00.000Z",
		};
		const phoneNumber = makePhoneNumber({ id: "111222333444555", wabaId: waba.id, displayPhoneNumber: "+1 631" });
		const state = apply(
			makeAppState(),
			{ type: "waba.changed", payload: { waba, event: "created" } },
			{ type: "phone_number.changed", payload: { phoneNumber, event: "created" } },
		);

		expect(state.server?.wabas.map(candidate => candidate.name)).toEqual(["whaloc Test Business", "Second Business"]);
		expect(state.server?.wabas[1]?.phoneNumbers).toEqual([phoneNumber]);
		// The scope was already on a number that still exists, so it is left alone.
		expect(state.phoneNumberId).toBe(PHONE_NUMBER_ID);
	});

	it("keeps a phone number in place when it is updated", () => {
		const renamed = makePhoneNumber({ verifiedName: "Renamed Business" });
		const state = apply(makeAppState(), {
			type: "phone_number.changed",
			payload: { phoneNumber: renamed, event: "updated" },
		});

		expect(state.server?.wabas[0]?.phoneNumbers).toEqual([renamed]);
	});

	it("moves the scope off a deleted phone number, and drops it entirely with the last one", () => {
		const second = makePhoneNumber({ id: "111222333444555", displayPhoneNumber: "+1 631-555-5555" });
		const withTwo = apply(makeAppState(), {
			type: "phone_number.changed",
			payload: { phoneNumber: second, event: "created" },
		});
		const afterFirst = apply(withTwo, {
			type: "phone_number.changed",
			payload: { phoneNumber: makePhoneNumber(), event: "deleted" },
		});

		expect(afterFirst.phoneNumberId).toBe(second.id);
		expect(afterFirst.conversations).toBeNull();

		const afterBoth = apply(afterFirst, {
			type: "phone_number.changed",
			payload: { phoneNumber: second, event: "deleted" },
		});

		expect(afterBoth.phoneNumberId).toBeNull();
	});

	it("takes the phone numbers of a deleted WABA with it", () => {
		const state = apply(makeAppState(), {
			type: "waba.changed",
			payload: {
				waba: { id: WABA_ID, name: "whaloc Test Business", subscribedAt: null, createdAt: "2026-09-01T10:00:00.000Z" },
				event: "deleted",
			},
		});

		expect(state.server?.wabas).toEqual([]);
		expect(state.phoneNumberId).toBeNull();
		// Nothing is left to be scoped to, which is what puts the shell in its empty state.
		expect(state.wabaId).toBeNull();
	});

	it("ignores a change that arrives before the bootstrap answered", () => {
		const state = apply(makeAppState({ server: null }), {
			type: "phone_number.changed",
			payload: { phoneNumber: makePhoneNumber(), event: "created" },
		});

		expect(state.server).toBeNull();
	});

	it("drops everything the reset wiped but keeps the shell usable", () => {
		const before = reducer(loadedState([makeMessage()]), {
			type: "deliveries/loaded",
			deliveries: [makeDelivery()],
			before: null,
			mode: "latest",
		});
		const state = apply(before, { type: "state.reset", payload: { state: makeStateResponse() } });

		expect(state.messages).toEqual({});
		expect(state.conversations).toBeNull();
		expect(state.deliveries).toBeNull();
		expect(state.phase).toBe("ready");
		expect(state.phoneNumberId).toBe(PHONE_NUMBER_ID);
		// A reset disarmed every rule and revived every token (SPEC §4), which the reducer states
		// outright so the shell's badge goes away without a round trip.
		expect(state.injectionRules).toEqual([]);
	});

	/**
	 * An import replaces everything with a snapshot (SPEC §5): the same wipe, except that what
	 * comes back is a stranger's world — so the collections this client cannot derive stay
	 * unknown and the store re-reads them.
	 */
	it("drops everything an import replaced, leaving the rules and tokens unknown", () => {
		const before = makeAppState({
			messages: { [CONVERSATION_ID]: [makeMessage()] },
			injectionRules: [makeInjectionRule()],
			tokens: [makeToken({ expired: true, expiredAt: "2026-08-31T12:00:00.000Z" })],
		});
		const state = apply(before, { type: "state.imported", payload: { state: makeStateResponse() } });

		expect(state.messages).toEqual({});
		expect(state.conversations).toBeNull();
		expect(state.phase).toBe("ready");
		expect(state.injectionRules).toBeNull();
		expect(state.tokens).toBeNull();
	});

	/** Typing indicators (SPEC §2.18): both edges arrive as `typing.changed`. */
	describe("typing indicators", () => {
		it("raises and dismisses one, keyed by conversation", () => {
			const up = apply(loadedState(), typingChanged("2026-08-31T12:00:25.000Z"));

			expect(up.typing).toEqual({ [CONVERSATION_ID]: "2026-08-31T12:00:25.000Z" });

			const down = apply(up, typingChanged(null));

			expect(down.typing).toEqual({});
		});

		it("drops it when the business sends its next message", () => {
			const up = apply(loadedState(), typingChanged("2026-08-31T12:00:25.000Z"));
			const sent = apply(up, created(makeMessage({ id: "wamid.next", direction: "outbound" })));

			expect(sent.typing).toEqual({});
		});

		it("keeps it while the user is the one writing", () => {
			const up = apply(loadedState(), typingChanged("2026-08-31T12:00:25.000Z"));
			const received = apply(up, created(makeMessage({ id: "wamid.in", direction: "inbound" })));

			expect(received.typing).toEqual({ [CONVERSATION_ID]: "2026-08-31T12:00:25.000Z" });
		});

		it("keeps it when a status frame arrives for the same conversation", () => {
			const up = apply(loadedState(), typingChanged("2026-08-31T12:00:25.000Z"));
			const delivered = apply(up, statusChanged(makeMessage({ status: "delivered" }), "sent"));

			expect(delivered.typing).toEqual({ [CONVERSATION_ID]: "2026-08-31T12:00:25.000Z" });
		});

		it("forgets every indicator a reset wiped", () => {
			const up = apply(loadedState(), typingChanged("2026-08-31T12:00:25.000Z"));
			const state = apply(up, { type: "state.reset", payload: { state: makeStateResponse() } });

			expect(state.typing).toEqual({});
		});
	});
});

describe("reducer, REST answers", () => {
	it("scopes the bootstrap to the first number of any WABA, not of the first one", () => {
		const second = makePhoneNumber({ id: "111222333444555", wabaId: "102290129340398" });
		const state = reducer(makeAppState({ wabaId: null, phoneNumberId: null, server: null, phase: "loading" }), {
			type: "bootstrap/loaded",
			server: makeStateResponse({
				wabas: [
					// The seeded WABA can legitimately end up with no numbers now that they can be
					// deleted at runtime.
					{ id: WABA_ID, name: "whaloc Test Business", subscribedAt: null, phoneNumbers: [] },
					{ id: "102290129340398", name: "Second Business", subscribedAt: null, phoneNumbers: [second] },
				],
			}),
			contacts: [],
			errorPresets: [],
			injectionRules: [],
		});

		expect(state.phoneNumberId).toBe(second.id);
		// And to the account above it: the two segments are one path, not two pickers.
		expect(state.wabaId).toBe("102290129340398");
	});

	it("keeps the bootstrap on a WABA that has no numbers when that is the one asked for", () => {
		const state = reducer(makeAppState({ wabaId: WABA_ID, phoneNumberId: null, server: null, phase: "loading" }), {
			type: "bootstrap/loaded",
			server: makeStateResponse({
				wabas: [
					{ id: WABA_ID, name: "whaloc Test Business", subscribedAt: null, phoneNumbers: [] },
					{
						id: "102290129340398",
						name: "Second Business",
						subscribedAt: null,
						phoneNumbers: [makePhoneNumber({ id: "111222333444555", wabaId: "102290129340398" })],
					},
				],
			}),
			contacts: [],
			errorPresets: [],
			injectionRules: [],
		});

		expect(state.wabaId).toBe(WABA_ID);
		expect(state.phoneNumberId).toBeNull();
	});

	/** The scope the router resolved from the URL, announced to the store (SPEC §5). */
	it("follows the router's scope, dropping the conversations of the number it left", () => {
		const state = reducer(makeAppState({ conversations: [], activeConversationId: CONVERSATION_ID }), {
			type: "scope/selected",
			wabaId: "102290129340398",
			phoneNumberId: "111222333444555",
		});

		expect(state.wabaId).toBe("102290129340398");
		expect(state.phoneNumberId).toBe("111222333444555");
		expect(state.conversations).toBeNull();
		expect(state.activeConversationId).toBeNull();
	});

	// The router re-announces the scope on every navigation; a tab change must not throw away the
	// conversation list the chats view just loaded.
	it("ignores the scope it is already on", () => {
		const before = makeAppState({ conversations: [] });
		const state = reducer(before, { type: "scope/selected", wabaId: WABA_ID, phoneNumberId: PHONE_NUMBER_ID });

		expect(state).toBe(before);
	});

	it("keeps the conversations when only the account changed under an unchanged number", () => {
		const state = reducer(makeAppState({ conversations: [] }), {
			type: "scope/selected",
			wabaId: "102290129340398",
			phoneNumberId: PHONE_NUMBER_ID,
		});

		expect(state.conversations).toEqual([]);
	});

	it("moves the scope off a number a refreshed snapshot no longer has", () => {
		const other = makePhoneNumber({ id: "111222333444555", displayPhoneNumber: "+1 631-555-5555" });
		const state = reducer(makeAppState({ conversations: [] }), {
			type: "state/loaded",
			server: makeStateResponse({
				wabas: [{ id: WABA_ID, name: "whaloc Test Business", subscribedAt: null, phoneNumbers: [other] }],
			}),
		});

		expect(state.phoneNumberId).toBe(other.id);
		expect(state.conversations).toBeNull();
	});

	it("keeps the scope, and the loaded conversations, when the snapshot still has it", () => {
		const state = reducer(makeAppState({ conversations: [] }), { type: "state/loaded", server: makeStateResponse() });

		expect(state.phoneNumberId).toBe(PHONE_NUMBER_ID);
		expect(state.conversations).toEqual([]);
	});

	it("merges a loaded page with what the socket delivered meanwhile", () => {
		const live = makeMessage({ id: "wamid.live", timestamp: "2026-08-31T12:10:00.000Z" });
		const state = reducer(apply(loadedState(), created(live)), {
			type: "messages/loaded",
			conversationId: CONVERSATION_ID,
			messages: [makeMessage({ id: "wamid.old", timestamp: "2026-08-31T11:00:00.000Z" })],
			before: "2026-08-31T11:00:00.000Z",
		});

		expect(state.messages[CONVERSATION_ID]?.map(message => message.id)).toEqual(["wamid.old", "wamid.live"]);
		expect(state.messagesBefore[CONVERSATION_ID]).toBe("2026-08-31T11:00:00.000Z");
	});

	it("pages the delivery log without repeating a row", () => {
		const first = reducer(makeAppState(), {
			type: "deliveries/loaded",
			deliveries: [makeDelivery({ id: "a" }), makeDelivery({ id: "b" })],
			before: "cursor",
			mode: "latest",
		});
		const second = reducer(first, {
			type: "deliveries/loaded",
			deliveries: [makeDelivery({ id: "b" }), makeDelivery({ id: "c" })],
			before: null,
			mode: "older",
		});

		expect(second.deliveries?.map(delivery => delivery.id)).toEqual(["a", "b", "c"]);
		expect(second.deliveriesBefore).toBeNull();
	});

	it("replaces the typing state with what GET /api/typing answered", () => {
		const before = reducer(makeAppState({ typing: { "stale:conversation": "2026-08-31T12:00:25.000Z" } }), {
			type: "typing/loaded",
			indicators: [{ phoneNumberId: PHONE_NUMBER_ID, contactWaId: CONTACT_WA_ID, expiresAt: null }],
		});

		expect(before.typing).toEqual({});

		const state = reducer(before, {
			type: "typing/loaded",
			indicators: [
				{ phoneNumberId: PHONE_NUMBER_ID, contactWaId: CONTACT_WA_ID, expiresAt: "2026-08-31T12:00:25.000Z" },
			],
		});

		expect(state.typing).toEqual({ [CONVERSATION_ID]: "2026-08-31T12:00:25.000Z" });
	});

	/**
	 * A contact that changed number (SPEC §5). The conversation id is derived from its `wa_id`,
	 * so everything keyed by it has to move with the person — and the chat view has to be told
	 * where the conversation it has open went.
	 */
	describe("a contact that changed number", () => {
		const MOVED_WA_ID = "5511900000000";
		const MOVED_ID = conversationId(PHONE_NUMBER_ID, MOVED_WA_ID);

		function movedTo(waId: string): WsEvent {
			return {
				type: "contact.changed",
				payload: { contact: makeContact({ waId, userId: "BR.ENT.4KgQ2wJ8" }), previousWaId: CONTACT_WA_ID },
			};
		}

		function openedState(): AppState {
			return {
				...loadedState([makeMessage({ id: "wamid.1" })]),
				contacts: [makeContact()],
				activeConversationId: CONVERSATION_ID,
				unread: { [CONVERSATION_ID]: 2 },
				typing: { [CONVERSATION_ID]: "2026-08-31T12:00:25.000Z" },
			};
		}

		it("re-keys the conversation, its history and everything hanging off it", () => {
			const state = apply(openedState(), movedTo(MOVED_WA_ID));

			expect(state.conversations?.map(conversation => conversation.id)).toEqual([MOVED_ID]);
			expect(state.conversations?.[0]).toMatchObject({ contactWaId: MOVED_WA_ID });
			expect(Object.keys(state.messages)).toEqual([MOVED_ID]);
			expect(state.messages[MOVED_ID]?.[0]?.contactWaId).toBe(MOVED_WA_ID);
			expect(Object.keys(state.messagesBefore)).toEqual([MOVED_ID]);
			expect(state.unread).toEqual({ [MOVED_ID]: 2 });
			expect(state.typing).toEqual({ [MOVED_ID]: "2026-08-31T12:00:25.000Z" });
		});

		it("replaces the contact rather than listing the person twice", () => {
			const state = apply(openedState(), movedTo(MOVED_WA_ID));

			expect(state.contacts).toEqual([makeContact({ waId: MOVED_WA_ID, userId: "BR.ENT.4KgQ2wJ8" })]);
		});

		it("records where the open conversation went, and forgets once it is opened", () => {
			const moved = apply(openedState(), movedTo(MOVED_WA_ID));

			expect(moved.conversationMoved).toEqual({ from: CONVERSATION_ID, to: MOVED_ID });
			expect(moved.activeConversationId).toBe(MOVED_ID);

			const opened = reducer(moved, { type: "conversation/opened", conversationId: MOVED_ID });

			expect(opened.conversationMoved).toBeNull();
		});

		it("leaves another conversation alone", () => {
			const other = conversationId(PHONE_NUMBER_ID, "5511999999999");
			const state = apply({ ...openedState(), unread: { [other]: 1 } }, movedTo(MOVED_WA_ID));

			expect(state.unread).toEqual({ [other]: 1 });
			expect(state.conversationMoved).toEqual({ from: CONVERSATION_ID, to: MOVED_ID });
		});

		it("is a plain edit when no previous number came with it", () => {
			const state = apply(openedState(), {
				type: "contact.changed",
				payload: { contact: makeContact({ profileName: "Ana S.", userId: "US.4KgQ2wJ8" }) },
			});

			expect(state.conversationMoved).toBeNull();
			expect(Object.keys(state.messages)).toEqual([CONVERSATION_ID]);
			expect(state.contacts?.[0]).toMatchObject({ profileName: "Ana S.", userId: "US.4KgQ2wJ8" });
			expect(state.conversations?.[0]?.contact).toMatchObject({ profileName: "Ana S." });
		});
	});

	it("selects the first seeded phone number on bootstrap", () => {
		const state = reducer(makeAppState({ phase: "loading", phoneNumberId: null, server: null }), {
			type: "bootstrap/loaded",
			server: makeStateResponse(),
			contacts: [],
			errorPresets: [],
			injectionRules: [],
		});

		expect(state.phase).toBe("ready");
		expect(state.phoneNumberId).toBe(PHONE_NUMBER_ID);
	});
});
