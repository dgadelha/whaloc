import {
	conversationId,
	MESSAGE_STATUSES,
	parseConversationId,
	type ChangeEvent,
	type Contact,
	type Conversation,
	type InjectionRule,
	type Message,
	type MessageStatus,
	type PhoneNumber,
	type StateResponse,
	type Template,
	type TokenState,
	type Waba,
	type WsEvent,
} from "@whaloc/shared";
import { resolveScope, isSameScope } from "./scope.ts";
import type { Action, AppState } from "./types.ts";

/**
 * The whole client state, in one reducer (SPEC §5: the UI is a pure client of REST + WS).
 *
 * REST answers seed a collection, the WebSocket keeps it current, and nothing polls. The two
 * sources race by nature — a `message.status_changed` can arrive while its conversation is
 * still loading — so the merges below are written to be order-independent: messages are keyed
 * by wamid and sorted by timestamp, and a status only ever moves forward.
 */

export const initialState: AppState = {
	phase: "loading",
	loadError: null,
	server: null,
	wabaId: null,
	phoneNumberId: null,
	contacts: null,
	conversations: null,
	activeConversationId: null,
	conversationMoved: null,
	messages: {},
	messagesBefore: {},
	unread: {},
	typing: {},
	templates: null,
	injectionRules: null,
	tokens: null,
	deliveries: null,
	deliveriesBefore: null,
	errorPresets: [],
	connection: "connecting",
	toasts: [],
};

/** Where a status sits on the ladder (SPEC §4); `failed` is last, so it always wins. */
export function statusRank(status: MessageStatus): number {
	return MESSAGE_STATUSES.indexOf(status);
}

function compareMessages(a: Message, b: Message): number {
	if (a.timestamp !== b.timestamp) {
		return a.timestamp < b.timestamp ? -1 : 1;
	}

	// Same second: fall back to insertion order, which `createdAt` records to the millisecond.
	if (a.createdAt !== b.createdAt) {
		return a.createdAt < b.createdAt ? -1 : 1;
	}

	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Adds (or replaces) one message, keeping the list oldest-first. */
export function insertMessage(messages: readonly Message[], message: Message): Message[] {
	const existing = messages.findIndex(candidate => candidate.id === message.id);

	if (existing !== -1) {
		const merged = [...messages];

		merged[existing] = message;

		return merged;
	}

	// Almost always already in order: the sort is the cheap way to be right when it is not.
	return [...messages, message].toSorted((a, b) => compareMessages(a, b));
}

/** Applies a status transition, ignoring one that would move the message backwards. */
export function mergeStatus(current: Message, incoming: Message): Message {
	return statusRank(incoming.status) < statusRank(current.status) ? current : incoming;
}

function upsertMessage(state: AppState, message: Message, kind: "created" | "status"): AppState {
	const id = conversationId(message.phoneNumberId, message.contactWaId);
	const loaded = state.messages[id];
	const messages =
		loaded === undefined
			? state.messages
			: {
					...state.messages,
					[id]: insertMessage(loaded, mergeInto(loaded, message)),
				};

	return {
		...state,
		messages,
		conversations: withConversationOf(state, message, id, kind),
		// The business sending something is what takes its typing indicator down (SPEC §2.18).
		// The server announces that too; applying it here means the bubble never survives the
		// message that replaced it, whatever order the two frames arrive in.
		typing: kind === "created" && message.direction === "outbound" ? withoutTyping(state.typing, id) : state.typing,
	};
}

/** Drops one conversation's indicator, keeping the object identity when there was none. */
function withoutTyping(typing: Record<string, string>, id: string): Record<string, string> {
	if (!Object.hasOwn(typing, id)) {
		return typing;
	}

	const { [id]: _dismissed, ...rest } = typing;

	return rest;
}

/** Keeps a late-arriving frame from undoing a status the UI already has. */
function mergeInto(messages: readonly Message[], message: Message): Message {
	const current = messages.find(candidate => candidate.id === message.id);

	return current === undefined ? message : mergeStatus(current, message);
}

/**
 * Folds a message into the conversation list: a new message puts its conversation on top, a
 * status change only refreshes the preview — and only when it is *that* message, so a
 * `delivered` on yesterday's message does not resurrect the thread. Untouched when the list
 * has never been loaded.
 */
function withConversationOf(
	state: AppState,
	message: Message,
	id: string,
	kind: "created" | "status",
): Conversation[] | null {
	if (state.conversations === null) {
		return null;
	}

	const existing = state.conversations.find(conversation => conversation.id === id);

	if (kind === "status" || existing?.lastMessage?.id === message.id) {
		return state.conversations.map(conversation => {
			return conversation.id === id && conversation.lastMessage?.id === message.id
				? { ...conversation, lastMessage: message }
				: conversation;
		});
	}

	const contact = state.contacts?.find(candidate => candidate.waId === message.contactWaId) ?? null;
	const updated: Conversation = {
		id,
		phoneNumberId: message.phoneNumberId,
		contactWaId: message.contactWaId,
		contact: existing?.contact ?? contact,
		messageCount: (existing?.messageCount ?? 0) + 1,
		lastMessageAt: message.timestamp,
		lastMessage: message,
	};

	return [updated, ...state.conversations.filter(conversation => conversation.id !== id)];
}

function countUnread(state: AppState, message: Message, id: string): Record<string, number> {
	if (message.direction !== "inbound" || id === state.activeConversationId) {
		return state.unread;
	}

	return { ...state.unread, [id]: (state.unread[id] ?? 0) + 1 };
}

function upsertBy<TItem>(items: TItem[] | null, item: TItem, isMatch: (candidate: TItem) => boolean): TItem[] | null {
	if (items === null) {
		return null;
	}

	const index = items.findIndex(candidate => isMatch(candidate));

	if (index === -1) {
		return [item, ...items];
	}

	const next = [...items];

	next[index] = item;

	return next;
}

/**
 * Replaces the state snapshot, keeping the scope pointing at something that still exists:
 * deleting the selected number (or the WABA above it) has to leave the views on another one
 * rather than on nothing. A changed number drops the conversation list, exactly like picking one
 * by hand does.
 *
 * The router repairs the *URL* the same way, through the same {@link resolveScope} — this is the
 * half that keeps the store from pointing at a deleted id for the frame in between, which is
 * long enough for a view to fetch a conversation list that no longer has an owner.
 */
function withServer(state: AppState, server: StateResponse): AppState {
	const scope = resolveScope(server, state);

	if (isSameScope(scope, state)) {
		return { ...state, server };
	}

	return {
		...state,
		server,
		...scope,
		...(scope.phoneNumberId !== state.phoneNumberId && { conversations: null, activeConversationId: null }),
	};
}

/** Adds or replaces one number, keeping the order the control plane serves them in. */
function upsertPhoneNumber(phoneNumbers: readonly PhoneNumber[], phoneNumber: PhoneNumber): PhoneNumber[] {
	const index = phoneNumbers.findIndex(candidate => candidate.id === phoneNumber.id);

	if (index === -1) {
		return [...phoneNumbers, phoneNumber];
	}

	const merged = [...phoneNumbers];

	merged[index] = phoneNumber;

	return merged;
}

/**
 * Adds or replaces one injection rule, **keeping creation order** — which is also the order the
 * server evaluates them in, and the reason the first rule in the list is the one that fires.
 */
function upsertInjectionRule(rules: readonly InjectionRule[] | null, rule: InjectionRule): InjectionRule[] | null {
	if (rules === null) {
		return null;
	}

	const index = rules.findIndex(candidate => candidate.id === rule.id);

	if (index === -1) {
		return [...rules, rule];
	}

	const merged = [...rules];

	merged[index] = rule;

	return merged;
}

/** A reset revives every expired token: the rows are gone, the registry is not (SPEC §1.9). */
function withValidTokens(tokens: readonly TokenState[] | null): TokenState[] | null {
	return tokens?.map(token => ({ ...token, expired: false, expiredAt: null })) ?? null;
}

function applyWabaChange(state: AppState, waba: Waba, event: ChangeEvent): AppState {
	if (state.server === null) {
		return state;
	}

	const isKnown = state.server.wabas.some(candidate => candidate.id === waba.id);
	const wabas =
		event === "deleted"
			? state.server.wabas.filter(candidate => candidate.id !== waba.id)
			: isKnown
				? state.server.wabas.map(candidate => {
						return candidate.id === waba.id
							? { ...candidate, name: waba.name, subscribedAt: waba.subscribedAt }
							: candidate;
					})
				: [...state.server.wabas, { id: waba.id, name: waba.name, subscribedAt: waba.subscribedAt, phoneNumbers: [] }];

	return withServer(state, { ...state.server, wabas });
}

function applyPhoneNumberChange(state: AppState, phoneNumber: PhoneNumber, event: ChangeEvent): AppState {
	if (state.server === null) {
		return state;
	}

	const wabas = state.server.wabas.map(waba => {
		if (waba.id !== phoneNumber.wabaId) {
			return waba;
		}

		return {
			...waba,
			phoneNumbers:
				event === "deleted"
					? waba.phoneNumbers.filter(candidate => candidate.id !== phoneNumber.id)
					: upsertPhoneNumber(waba.phoneNumbers, phoneNumber),
		};
	});

	return withServer(state, { ...state.server, wabas });
}

/**
 * A contact that moved to a new number (SPEC §5). Everything the UI keys by conversation id has
 * to be re-keyed, because that id is derived from the `wa_id` that just changed: the contact
 * list, the conversation list, the loaded histories, their cursors, the unread counts and the
 * typing indicators — plus a note of where the open conversation went, so the chat view can
 * follow the person instead of staring at an id nobody will ever send to again.
 */
function withMovedContact(state: AppState, contact: Contact, previousWaId: string): AppState {
	const movedId = (id: string): string | null => {
		const endpoints = parseConversationId(id);

		return endpoints?.contactWaId === previousWaId ? conversationId(endpoints.phoneNumberId, contact.waId) : null;
	};
	const known = state.contacts?.filter(candidate => candidate.waId !== previousWaId) ?? null;
	const activeMovedTo = state.activeConversationId === null ? null : movedId(state.activeConversationId);
	const messages: Record<string, Message[]> = {};

	for (const [id, loaded] of Object.entries(state.messages)) {
		messages[movedId(id) ?? id] = loaded.map(message =>
			message.contactWaId === previousWaId ? { ...message, contactWaId: contact.waId } : message,
		);
	}

	return {
		...state,
		contacts: upsertBy<Contact>(known, contact, candidate => candidate.waId === contact.waId),
		conversations:
			state.conversations?.map(conversation => {
				const moved = movedId(conversation.id);

				return moved === null ? conversation : { ...conversation, id: moved, contactWaId: contact.waId, contact };
			}) ?? null,
		messages,
		messagesBefore: reKeyBy(state.messagesBefore, movedId),
		unread: reKeyBy(state.unread, movedId),
		typing: reKeyBy(state.typing, movedId),
		...(activeMovedTo !== null && {
			activeConversationId: activeMovedTo,
			conversationMoved: { from: state.activeConversationId!, to: activeMovedTo },
		}),
	};
}

/** Renames the keys of a conversation-keyed record, leaving the ones that did not move. */
function reKeyBy<TValue>(
	entries: Record<string, TValue>,
	movedId: (id: string) => string | null,
): Record<string, TValue> {
	return Object.fromEntries(Object.entries(entries).map(([id, value]) => [movedId(id) ?? id, value]));
}

function applyWsEvent(state: AppState, event: WsEvent): AppState {
	switch (event.type) {
		case "message.created": {
			const { message } = event.payload;
			const id = conversationId(message.phoneNumberId, message.contactWaId);

			return { ...upsertMessage(state, message, "created"), unread: countUnread(state, message, id) };
		}

		case "message.status_changed": {
			return upsertMessage(state, event.payload.message, "status");
		}

		case "typing.changed": {
			const { typing } = event.payload;
			const id = conversationId(typing.phoneNumberId, typing.contactWaId);

			return {
				...state,
				typing:
					typing.expiresAt === null ? withoutTyping(state.typing, id) : { ...state.typing, [id]: typing.expiresAt },
			};
		}

		case "template.changed": {
			const { template } = event.payload;

			return {
				...state,
				templates: upsertBy<Template>(state.templates, template, candidate => candidate.id === template.id),
			};
		}

		case "webhook.delivery": {
			return state.deliveries === null
				? state
				: { ...state, deliveries: [event.payload.delivery, ...state.deliveries] };
		}

		case "contact.changed": {
			const { contact, previousWaId } = event.payload;

			// A number change is a rename of the contact's identity, not an edit to it.
			if (previousWaId !== undefined && previousWaId !== contact.waId) {
				return withMovedContact(state, contact, previousWaId);
			}

			const contacts = upsertBy<Contact>(state.contacts, contact, candidate => candidate.waId === contact.waId);

			return {
				...state,
				contacts: contacts?.toSorted((a, b) => a.waId.localeCompare(b.waId)) ?? null,
				conversations:
					state.conversations?.map(conversation =>
						conversation.contactWaId === contact.waId ? { ...conversation, contact } : conversation,
					) ?? null,
			};
		}

		case "waba.changed": {
			return applyWabaChange(state, event.payload.waba, event.payload.event);
		}

		case "phone_number.changed": {
			return applyPhoneNumberChange(state, event.payload.phoneNumber, event.payload.event);
		}

		case "injection.changed": {
			const { rule, event: change } = event.payload;

			// Unlike the other collections this one is never `null` after the bootstrap, so an
			// `updated` frame — which is how a countdown moves — always has somewhere to land.
			return {
				...state,
				injectionRules:
					change === "deleted"
						? (state.injectionRules?.filter(candidate => candidate.id !== rule.id) ?? null)
						: upsertInjectionRule(state.injectionRules, rule),
			};
		}

		case "token.changed": {
			const { token } = event.payload;

			return {
				...state,
				tokens: state.tokens?.map(candidate => (candidate.id === token.id ? token : candidate)) ?? null,
			};
		}

		// A reset went back to the seed and an import went to somebody else's world, but from
		// here they are the same event: everything this client held is gone (SPEC §5).
		case "state.imported":
		case "state.reset": {
			// Everything the wipe took is dropped; the views reload what they need. The scope
			// goes through `withServer` because the state that came back may not have the number
			// that was selected.
			const isReset = event.type === "state.reset";

			return withServer(
				{
					...initialState,
					phase: "ready",
					server: event.payload.state,
					wabaId: state.wabaId,
					phoneNumberId: state.phoneNumberId,
					errorPresets: state.errorPresets,
					// A reset disarmed every injection rule and revived every token (SPEC §4), so
					// both are stated outright rather than left `null` and the shell's badge goes
					// away without anyone having to reload the list. An **import** brings whatever
					// the snapshot carried, which this client cannot know: they stay unknown until
					// the store re-reads them.
					injectionRules: isReset ? [] : null,
					tokens: isReset ? withValidTokens(state.tokens) : null,
					connection: state.connection,
					toasts: state.toasts,
				},
				event.payload.state,
			);
		}
	}
}

export function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "bootstrap/loaded": {
			// A default scope so the shell has something to render before the router has resolved
			// one. (Not `withServer`: the bootstrap must not clear a conversation the user opened
			// while it was in flight.)
			return {
				...state,
				phase: "ready",
				loadError: null,
				server: action.server,
				contacts: action.contacts,
				errorPresets: action.errorPresets,
				injectionRules: action.injectionRules,
				...resolveScope(action.server, state),
			};
		}

		case "bootstrap/failed": {
			return { ...state, phase: "failed", loadError: action.message };
		}

		case "state/loaded": {
			// A refreshed snapshot can be missing the selected number (deleted in another tab,
			// or while this one's socket was down).
			return withServer(state, action.server);
		}

		case "scope/selected": {
			// Idempotent on purpose: the router re-announces the scope on every navigation, and
			// re-announcing the same one must not throw away the conversation list it just loaded.
			if (isSameScope(action, state)) {
				return state;
			}

			return {
				...state,
				wabaId: action.wabaId,
				phoneNumberId: action.phoneNumberId,
				...(action.phoneNumberId !== state.phoneNumberId && { conversations: null, activeConversationId: null }),
			};
		}

		case "contacts/loaded": {
			return { ...state, contacts: action.contacts };
		}

		case "conversations/loaded": {
			return { ...state, conversations: action.conversations };
		}

		case "conversation/opened": {
			// Opening a conversation is what marks it read — and settles any pending move: the
			// view is now wherever it was going.
			const unread = Object.fromEntries(Object.entries(state.unread).filter(([id]) => id !== action.conversationId));

			return { ...state, activeConversationId: action.conversationId, conversationMoved: null, unread };
		}

		case "messages/loaded": {
			// Both the first page and an older one merge into what is there: a `message.created`
			// that arrived while the page was in flight must not be dropped by its answer.
			let merged = state.messages[action.conversationId] ?? [];

			for (const message of action.messages) {
				merged = insertMessage(merged, mergeInto(merged, message));
			}

			return {
				...state,
				messages: { ...state.messages, [action.conversationId]: merged },
				messagesBefore: { ...state.messagesBefore, [action.conversationId]: action.before },
			};
		}

		case "typing/loaded": {
			// A full replacement: `GET /api/typing` is the authority on what is up right now.
			return {
				...state,
				typing: Object.fromEntries(
					action.indicators.flatMap(indicator => {
						return indicator.expiresAt === null
							? []
							: [[conversationId(indicator.phoneNumberId, indicator.contactWaId), indicator.expiresAt]];
					}),
				),
			};
		}

		case "templates/loaded": {
			return { ...state, templates: action.templates };
		}

		case "injection-rules/loaded": {
			return { ...state, injectionRules: action.rules };
		}

		case "tokens/loaded": {
			return { ...state, tokens: action.tokens };
		}

		case "deliveries/loaded": {
			const known = action.mode === "older" ? (state.deliveries ?? []) : [];
			const seen = new Set(known.map(delivery => delivery.id));
			const appended = action.deliveries.filter(delivery => !seen.has(delivery.id));

			return {
				...state,
				deliveries: [...known, ...appended],
				deliveriesBefore: action.before,
			};
		}

		case "connection/changed": {
			return { ...state, connection: action.connection };
		}

		case "ws/event": {
			return applyWsEvent(state, action.event);
		}

		case "toast/pushed": {
			// Four is enough to see a burst of failures without burying the app.
			return { ...state, toasts: [...state.toasts, action.toast].slice(-4) };
		}

		case "toast/dismissed": {
			return { ...state, toasts: state.toasts.filter(toast => toast.id !== action.id) };
		}
	}
}
