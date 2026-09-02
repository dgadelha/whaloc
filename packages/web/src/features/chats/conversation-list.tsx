import { type Contact, type Conversation } from "@whaloc/shared";
import clsx from "clsx";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Dialog } from "../../components/dialog.tsx";
import { formatListTime } from "../../lib/format.ts";
import { pathFor, type Scope } from "../../store/scope.ts";
import { useAppState } from "../../store/store.tsx";
import { summarize } from "./message-bubble.tsx";

export interface ConversationListProps {
	conversations: Conversation[] | null;
	activeId: string | null;
	wabaId: string | null;
	phoneNumberId: string;
}

/** A thread's own URL, under the scope it belongs to: `…/chats/:contactWaId`. */
export function conversationPath(scope: Scope, contactWaId: string): string {
	return pathFor("chats", scope, contactWaId) ?? "/chats";
}

/**
 * A conversation is derived from the messages between a phone number and a contact, so a
 * contact nobody has written to yet has none — and the very first thing a fresh whaloc needs
 * is a way to write as that contact. That is what the "New" dialog does: it opens the empty
 * conversation, which becomes real the moment the composer sends.
 */
function NewConversationDialog(props: { contacts: Contact[]; scope: Scope; onClose: () => void }) {
	const navigate = useNavigate();

	return (
		<Dialog title="Start a conversation" subtitle="Pick the contact to write as" onClose={props.onClose}>
			<div className="stack">
				{props.contacts.length === 0 && <p className="muted">No contacts yet — add one under Settings.</p>}
				{props.contacts.map(contact => (
					<button
						key={contact.waId}
						type="button"
						className="button"
						onClick={() => {
							props.onClose();
							void navigate(conversationPath(props.scope, contact.waId));
						}}
					>
						<span>{contact.profileName}</span>
						<span className="faint mono">{contact.waId}</span>
					</button>
				))}
			</div>
		</Dialog>
	);
}

export function ConversationList(props: ConversationListProps) {
	const { contacts, unread, typing } = useAppState();
	const navigate = useNavigate();
	const [picking, setPicking] = useState(false);
	const scope: Scope = { wabaId: props.wabaId, phoneNumberId: props.phoneNumberId };

	return (
		<aside className="conversations">
			<header className="conversations__header">
				<span className="section-label">Conversations</span>
				<button
					type="button"
					className="button button--sm"
					onClick={() => {
						setPicking(true);
					}}
				>
					New…
				</button>
			</header>

			<div className="conversations__list">
				{props.conversations === null && <p className="empty">loading…</p>}
				{props.conversations?.length === 0 && <p className="empty">No messages yet. Start one with “New…”.</p>}
				{props.conversations?.map(conversation => {
					const unreadCount = unread[conversation.id] ?? 0;

					return (
						<button
							key={conversation.id}
							type="button"
							className={clsx(
								"conversation",
								conversation.id === props.activeId && "is-active",
								unreadCount > 0 && "is-unread",
							)}
							onClick={() => {
								void navigate(conversationPath(scope, conversation.contactWaId));
							}}
						>
							<span className="conversation__top">
								<span className="conversation__name">
									{conversation.contact?.profileName ?? conversation.contactWaId}
								</span>
								<span className="conversation__time faint">{formatListTime(conversation.lastMessageAt)}</span>
							</span>
							<span className="conversation__bottom">
								{/* A live typing indicator wins over the last message, the way WhatsApp's own list does. */}
								{Object.hasOwn(typing, conversation.id) ? (
									<span className="conversation__preview conversation__preview--typing">typing…</span>
								) : (
									<span className="conversation__preview">
										{conversation.lastMessage === null ? "—" : summarize(conversation.lastMessage)}
									</span>
								)}
								{unreadCount > 0 && <span className="conversation__unread">{unreadCount}</span>}
							</span>
						</button>
					);
				})}
			</div>

			{picking && (
				<NewConversationDialog
					contacts={contacts ?? []}
					scope={scope}
					onClose={() => {
						setPicking(false);
					}}
				/>
			)}
		</aside>
	);
}
