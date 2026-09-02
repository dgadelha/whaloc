import type { Message } from "@whaloc/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { dayKey, formatDayLabel } from "../../lib/format.ts";
import { readString } from "../../lib/json.ts";
import { MessageBubble } from "./message-bubble.tsx";
import { TypingBubble } from "./typing-bubble.tsx";

export interface MessageListProps {
	messages: Message[];
	/** Whether the app under test currently has a typing indicator up (SPEC §2.18). */
	isTyping: boolean;
	hasMore: boolean;
	loadingOlder: boolean;
	onLoadOlder: () => void;
	onReply: (message: Message) => void;
	onReact: (message: Message) => void;
}

/** How far from the bottom still counts as "following the conversation". */
const STICKY_THRESHOLD_PX = 48;

/** Reactions are shown on the message they point at, not as bubbles of their own. */
function groupReactions(messages: readonly Message[]): { rendered: Message[]; reactions: Map<string, Message[]> } {
	const ids = new Set(messages.map(message => message.id));
	const reactions = new Map<string, Message[]>();
	const rendered: Message[] = [];

	for (const message of messages) {
		const target = message.type === "reaction" ? readString(message.payload, "reaction", "message_id") : null;

		if (target !== null && ids.has(target)) {
			reactions.set(target, [...(reactions.get(target) ?? []), message]);
		} else {
			rendered.push(message);
		}
	}

	return { rendered, reactions };
}

/**
 * The conversation itself: day separators, bubbles, and a scroll position that stays pinned to
 * the newest message *unless* the reader scrolled up — at which point new messages must not
 * yank the view away. Paging older history keeps the current message under the cursor by
 * restoring the scroll offset after the prepend.
 */
export function MessageList(props: MessageListProps) {
	const container = useRef<HTMLDivElement>(null);
	const sentinel = useRef<HTMLDivElement>(null);
	const [atBottom, setAtBottom] = useState(true);
	const previousHeight = useRef<number | null>(null);
	const { rendered, reactions } = groupReactions(props.messages);
	const byId = new Map(props.messages.map(message => [message.id, message]));

	useLayoutEffect(() => {
		const element = container.current;

		if (element === null) {
			return;
		}

		if (previousHeight.current !== null) {
			element.scrollTop += element.scrollHeight - previousHeight.current;
			previousHeight.current = null;

			return;
		}

		if (atBottom) {
			element.scrollTop = element.scrollHeight;
		}
		// The typing bubble changes the list's height, so it scrolls like a new message would.
	}, [props.messages, props.isTyping, atBottom]);

	// "Is the reader still at the bottom?" is a visibility question, so it is answered by
	// watching a sentinel at the end of the list rather than by measuring on every scroll tick.
	useEffect(() => {
		const element = container.current;
		const marker = sentinel.current;

		if (element === null || marker === null || !("IntersectionObserver" in globalThis)) {
			return;
		}

		const observer = new IntersectionObserver(
			entries => {
				const last = entries.at(-1);

				if (last !== undefined) {
					setAtBottom(last.isIntersecting);
				}
			},
			{ root: element, rootMargin: `0px 0px ${String(STICKY_THRESHOLD_PX)}px 0px` },
		);

		observer.observe(marker);

		return () => {
			observer.disconnect();
		};
	}, []);

	let lastDay = "";

	return (
		<div className="messages">
			<div className="messages__scroll" ref={container}>
				{props.hasMore && (
					<div className="messages__more">
						<button
							type="button"
							className="button button--sm"
							disabled={props.loadingOlder}
							onClick={() => {
								previousHeight.current = container.current?.scrollHeight ?? null;
								props.onLoadOlder();
							}}
						>
							{props.loadingOlder ? "loading…" : "Load older messages"}
						</button>
					</div>
				)}

				{rendered.map(message => {
					const day = dayKey(message.timestamp);
					const separator = day === lastDay ? null : formatDayLabel(message.timestamp);

					lastDay = day;

					return (
						<div key={message.id}>
							{separator !== null && (
								<div className="messages__day">
									<span>{separator}</span>
								</div>
							)}
							<MessageBubble
								message={message}
								reactions={reactions.get(message.id) ?? []}
								repliedTo={message.replyTo === null ? null : (byId.get(message.replyTo) ?? null)}
								onReply={props.onReply}
								onReact={props.onReact}
							/>
						</div>
					);
				})}

				{props.isTyping && <TypingBubble />}

				<div ref={sentinel} className="messages__sentinel" aria-hidden="true" />
			</div>

			{!atBottom && (
				<button
					type="button"
					className="button messages__jump"
					onClick={() => {
						const element = container.current;

						if (element !== null) {
							element.scrollTop = element.scrollHeight;
							setAtBottom(true);
						}
					}}
				>
					Jump to latest ↓
				</button>
			)}
		</div>
	);
}
