import { conversationId, parseConversationId, type Message } from "@whaloc/shared";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../../api/endpoints.ts";
import { ChangeNumberDialog } from "../../components/change-number-dialog.tsx";
import { CopyButton } from "../../components/copy-button.tsx";
import { CreatePhoneNumberDialog } from "../../components/create-phone-number-dialog.tsx";
import { pathFor } from "../../store/scope.ts";
import { useAppState, useDispatch, useToasts } from "../../store/store.tsx";
import { Composer } from "./composer.tsx";
import { ConversationList } from "./conversation-list.tsx";
import { MessageList } from "./message-list.tsx";

const PAGE_SIZE = 50;

/**
 * A WABA with nothing under it. Chats is the view a developer opens first, so the number this
 * account is missing is offered here rather than pointed at from here — the breadcrumb's
 * "Add number…" opens the same dialog.
 */
function NoPhoneNumber(props: { wabaId: string | null }) {
	const navigate = useNavigate();
	const [isAdding, setIsAdding] = useState(false);

	return (
		<div className="hero">
			<h1>No phone number yet</h1>
			<p className="muted">
				A conversation happens between one of this account's numbers and a contact — and this account has none.
			</p>
			{props.wabaId === null ? (
				<p className="faint">
					Add one under <code>Settings</code>, or check <code>WHALOC_SEED</code>.
				</p>
			) : (
				<button
					type="button"
					className="button button--primary"
					onClick={() => {
						setIsAdding(true);
					}}
				>
					Add a phone number
				</button>
			)}
			<p className="faint">
				The Graph API's <code>POST /{"{wabaId}"}/phone_numbers</code> adds one the unverified way.
			</p>

			{isAdding && props.wabaId !== null && (
				<CreatePhoneNumberDialog
					wabaId={props.wabaId}
					onClose={() => {
						setIsAdding(false);
					}}
					onCreated={created => {
						void navigate(pathFor("chats", { wabaId: props.wabaId, phoneNumberId: created.id }) ?? "/chats", {
							replace: true,
						});
					}}
				/>
			)}
		</div>
	);
}

/**
 * Chats (SPEC §5): the conversations of the selected phone number on the left, the messenger
 * on the right, and a composer that acts as the *user* — everything it sends is an inbound
 * message the app under test receives as a webhook.
 *
 * Nothing here polls. The two effects load a list once; from then on `message.created` and
 * `message.status_changed` keep the view current through the store.
 */
export function ChatsPage() {
	const { contactWaId: routeContactWaId } = useParams();
	const state = useAppState();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const navigate = useNavigate();
	const [replyTo, setReplyTo] = useState<Message | null>(null);
	const [reactionTarget, setReactionTarget] = useState<Message | null>(null);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [changingNumber, setChangingNumber] = useState(false);
	const { wabaId, phoneNumberId, conversationMoved: moved } = state;
	// The path names the *contact*; the conversation id is derived from it and the scope above it,
	// which is why switching number cannot strand the view on an id that belongs to another one.
	const activeId =
		phoneNumberId === null || routeContactWaId === undefined ? null : conversationId(phoneNumberId, routeContactWaId);

	useEffect(() => {
		if (phoneNumberId === null) {
			return;
		}

		const controller = new AbortController();

		async function load(id: string): Promise<void> {
			try {
				// A typing indicator can already be up when the view opens (SPEC §2.18); from
				// here on `typing.changed` keeps it current.
				const [conversations, indicators] = await Promise.all([
					api.listConversations(id, { signal: controller.signal }),
					api.listTyping(id, { signal: controller.signal }),
				]);

				dispatch({ type: "conversations/loaded", conversations });
				dispatch({ type: "typing/loaded", indicators });
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		}

		void load(phoneNumberId);

		return () => {
			controller.abort();
		};
	}, [phoneNumberId, dispatch, toasts]);

	useEffect(() => {
		dispatch({ type: "conversation/opened", conversationId: activeId });
		setReplyTo(null);
		setReactionTarget(null);

		if (activeId === null) {
			return;
		}

		const controller = new AbortController();

		async function load(conversationId: string): Promise<void> {
			try {
				const page = await api.listMessages(conversationId, { limit: PAGE_SIZE }, { signal: controller.signal });

				dispatch({
					type: "messages/loaded",
					conversationId,
					messages: page.data,
					before: page.paging.before,
				});
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		}

		void load(activeId);

		return () => {
			controller.abort();
		};
	}, [activeId, dispatch, toasts]);

	// The contact behind the open conversation changed number (SPEC §5): its derived id moved with
	// it, so the view follows rather than sitting on an id nothing will arrive on again. The store
	// records where it went — the move may well have been made in another tab.
	useEffect(() => {
		if (moved === null || moved.from !== activeId) {
			return;
		}

		const to = parseConversationId(moved.to);

		if (to !== null) {
			void navigate(pathFor("chats", { wabaId, phoneNumberId }, to.contactWaId) ?? "/chats", { replace: true });
		}
	}, [moved, activeId, navigate, wabaId, phoneNumberId]);

	const loadOlder = useCallback(() => {
		const before = activeId === null ? null : (state.messagesBefore[activeId] ?? null);

		if (activeId === null || before === null) {
			return;
		}

		async function loadPage(conversationId: string, cursor: string): Promise<void> {
			setLoadingOlder(true);

			try {
				const page = await api.listMessages(conversationId, { limit: PAGE_SIZE, before: cursor });

				dispatch({
					type: "messages/loaded",
					conversationId,
					messages: page.data,
					before: page.paging.before,
				});
			} catch (error) {
				toasts.error(error);
			} finally {
				setLoadingOlder(false);
			}
		}

		void loadPage(activeId, before);
	}, [activeId, state.messagesBefore, dispatch, toasts]);

	if (phoneNumberId === null) {
		return <NoPhoneNumber wabaId={wabaId} />;
	}

	const endpoints = routeContactWaId === undefined ? null : { phoneNumberId, contactWaId: routeContactWaId };
	const conversation = state.conversations?.find(candidate => candidate.id === activeId) ?? null;
	const messages = activeId === null ? [] : (state.messages[activeId] ?? []);
	const contact =
		state.contacts?.find(candidate => candidate.waId === endpoints?.contactWaId) ?? conversation?.contact ?? null;
	const title = conversation?.contact?.profileName ?? contact?.profileName ?? endpoints?.contactWaId ?? "";

	return (
		<div className="chats">
			<ConversationList
				conversations={state.conversations}
				activeId={activeId}
				wabaId={wabaId}
				phoneNumberId={phoneNumberId}
			/>

			{endpoints === null ? (
				<div className="chat chat--empty">
					<p className="empty">Pick a conversation, or start one, to act as that WhatsApp user.</p>
				</div>
			) : (
				<section className="chat">
					<header className="chat__header">
						<div className="page__title">
							<h1>{title}</h1>
							<span className="faint mono">{endpoints.contactWaId}</span>
							{/* The business-scoped identity, when this person has one (SPEC §1.15). */}
							{contact?.userId !== null && contact?.userId !== undefined && (
								<span className="faint mono" title="Business-scoped user ID">
									{contact.userId}
								</span>
							)}
						</div>
						<span className="spacer" />
						{contact !== null && (
							<button
								type="button"
								className="button button--ghost"
								onClick={() => {
									setChangingNumber(true);
								}}
							>
								Changed number…
							</button>
						)}
						<span className="chip" title="Phone number ID">
							{endpoints.phoneNumberId}
						</span>
						<CopyButton value={endpoints.phoneNumberId} label="phone number ID" />
					</header>

					{changingNumber && contact !== null && (
						<ChangeNumberDialog
							contact={contact}
							phoneNumberId={endpoints.phoneNumberId}
							onClose={() => {
								setChangingNumber(false);
							}}
						/>
					)}

					<MessageList
						messages={messages}
						isTyping={activeId !== null && Object.hasOwn(state.typing, activeId)}
						hasMore={activeId !== null && (state.messagesBefore[activeId] ?? null) !== null}
						loadingOlder={loadingOlder}
						onLoadOlder={loadOlder}
						onReply={setReplyTo}
						onReact={setReactionTarget}
					/>

					<Composer
						phoneNumberId={endpoints.phoneNumberId}
						contactWaId={endpoints.contactWaId}
						replyTo={replyTo}
						onClearReply={() => {
							setReplyTo(null);
						}}
						reactionTarget={reactionTarget}
						onClearReaction={() => {
							setReactionTarget(null);
						}}
					/>
				</section>
			)}
		</div>
	);
}
