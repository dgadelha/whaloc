import type {
	Contact,
	Conversation,
	InjectionRule,
	Message,
	MessageErrorPreset,
	StateResponse,
	Template,
	TokenState,
	TypingIndicator,
	WebhookDelivery,
	WsEvent,
} from "@whaloc/shared";
import type { ConnectionStatus } from "../api/ws-client.ts";

export interface Toast {
	id: string;
	kind: "error" | "info";
	message: string;
}

/**
 * Everything the UI keeps in memory. Collections are `null` until the view that owns them has
 * loaded once — a WebSocket event about a list nobody has fetched is dropped rather than
 * turned into a list of one, which would look like the server lost the rest.
 */
export interface AppState {
	phase: "loading" | "ready" | "failed";
	loadError: string | null;
	server: StateResponse | null;
	/**
	 * The WABA the account-scoped views are looking at. It mirrors the URL — the router is the
	 * source of truth (SPEC §5) — and is healed here when a WebSocket event deletes it.
	 */
	wabaId: string | null;
	/** The phone number the phone-scoped views are looking at; `null` when its WABA has none. */
	phoneNumberId: string | null;
	contacts: Contact[] | null;
	conversations: Conversation[] | null;
	/** The conversation on screen, so inbound messages elsewhere can count as unread. */
	activeConversationId: string | null;
	/**
	 * Where a conversation went when its contact changed number (SPEC §5). Conversation ids are
	 * derived from `(phoneNumberId, contactWaId)`, so a move renames them — and the chat view,
	 * which lives on the id in the URL, would otherwise be left on one that no longer exists.
	 * Cleared as soon as a conversation is opened, which is what a redirect does.
	 */
	conversationMoved: { from: string; to: string } | null;
	/** Conversation id → messages, oldest first (the order the chat renders). */
	messages: Record<string, Message[]>;
	/** Conversation id → cursor for the next older page, `null` when the history is complete. */
	messagesBefore: Record<string, string | null>;
	unread: Record<string, number>;
	/**
	 * Conversation id → when the app under test's typing indicator dismisses itself (SPEC
	 * §2.18). Absent means nobody is typing; the server announces both edges, so nothing here
	 * runs a timer of its own.
	 */
	typing: Record<string, string>;
	templates: Template[] | null;
	/**
	 * The armed error-injection rules (SPEC §4). Unlike the other collections this one is loaded
	 * at **bootstrap**, not by the view that owns it: the shell's badge has to warn about a
	 * forgotten rule whether or not anyone opens Settings.
	 */
	injectionRules: InjectionRule[] | null;
	/** The `WHALOC_TOKENS` registry; `null` until Settings asks, `[]` when there is none. */
	tokens: TokenState[] | null;
	deliveries: WebhookDelivery[] | null;
	deliveriesBefore: string | null;
	errorPresets: MessageErrorPreset[];
	connection: ConnectionStatus;
	toasts: Toast[];
}

export type Action =
	| {
			type: "bootstrap/loaded";
			server: StateResponse;
			contacts: Contact[];
			errorPresets: MessageErrorPreset[];
			injectionRules: InjectionRule[];
	  }
	| { type: "bootstrap/failed"; message: string }
	| { type: "state/loaded"; server: StateResponse }
	/** The URL resolved to a scope that exists; the store follows it. */
	| { type: "scope/selected"; wabaId: string | null; phoneNumberId: string | null }
	| { type: "contacts/loaded"; contacts: Contact[] }
	| { type: "conversations/loaded"; conversations: Conversation[] }
	| { type: "conversation/opened"; conversationId: string | null }
	| { type: "messages/loaded"; conversationId: string; messages: Message[]; before: string | null }
	| { type: "typing/loaded"; indicators: TypingIndicator[] }
	| { type: "templates/loaded"; templates: Template[] }
	| { type: "injection-rules/loaded"; rules: InjectionRule[] }
	| { type: "tokens/loaded"; tokens: TokenState[] }
	| { type: "deliveries/loaded"; deliveries: WebhookDelivery[]; before: string | null; mode: "latest" | "older" }
	| { type: "connection/changed"; connection: ConnectionStatus }
	| { type: "ws/event"; event: WsEvent }
	| { type: "toast/pushed"; toast: Toast }
	| { type: "toast/dismissed"; id: string };
