import type { Message } from "@whaloc/shared";
import clsx from "clsx";
import { formatClock } from "../../lib/format.ts";
import { readString } from "../../lib/json.ts";
import { MessageActions } from "./message-actions.tsx";
import { MessageBody } from "./message-body.tsx";
import { ReadMarker, StatusTicks } from "./status-ticks.tsx";

export interface MessageBubbleProps {
	message: Message;
	/** Reaction messages pointing at this one; rendered under the bubble like WhatsApp does. */
	reactions: Message[];
	/** The message this one replies to, when it is in the loaded history. */
	repliedTo: Message | null;
	onReply: (message: Message) => void;
	onReact: (message: Message) => void;
}

/** A one-line summary of a quoted message, for the reply header inside a bubble. */
export function summarize(message: Message): string {
	switch (message.type) {
		case "text": {
			return readString(message.payload, "text", "body") ?? "";
		}

		case "reaction": {
			return `${readString(message.payload, "reaction", "emoji") ?? ""} reaction`;
		}

		case "template": {
			return `template ${readString(message.payload, "template", "name") ?? ""}`;
		}

		case "location": {
			return readString(message.payload, "location", "name") ?? "location";
		}

		case "interactive": {
			return (
				readString(message.payload, "interactive", "button_reply", "title") ??
				readString(message.payload, "interactive", "list_reply", "title") ??
				readString(message.payload, "interactive", "body", "text") ??
				"interactive"
			);
		}

		case "button": {
			return readString(message.payload, "button", "text") ?? "button";
		}

		default: {
			const caption = readString(message.payload, message.type, "caption");

			return caption ?? message.type;
		}
	}
}

/**
 * One message. Inbound (the user's own side) on the left, outbound (the app under test) on
 * the right with its status ticks and the actions that drive the ladder by hand.
 */
export function MessageBubble(props: MessageBubbleProps) {
	const { message } = props;
	const isOutbound = message.direction === "outbound";
	const sentAt = new Date(message.timestamp);

	return (
		<div className={clsx("bubble-row", isOutbound ? "bubble-row--out" : "bubble-row--in")}>
			<div className={clsx("bubble", isOutbound ? "bubble--out" : "bubble--in", `bubble--${message.type}`)}>
				{props.repliedTo !== null && (
					<div className="bubble__quote">
						<span className="bubble__quote-author">
							{props.repliedTo.direction === "outbound" ? "Business" : "You"}
						</span>
						<span className="bubble__quote-text">{summarize(props.repliedTo)}</span>
					</div>
				)}

				<MessageBody message={message} />

				<div className="bubble__meta">
					<time dateTime={message.timestamp} title={sentAt.toLocaleString()}>
						{formatClock(message.timestamp)}
					</time>
					{isOutbound ? (
						<StatusTicks status={message.status} error={message.error} />
					) : (
						message.status === "read" && <ReadMarker />
					)}
				</div>

				{props.reactions.length > 0 && (
					<div className="bubble__reactions">
						{props.reactions.map(reaction => (
							<span key={reaction.id} className="bubble__reaction" title={`reaction ${reaction.id}`}>
								{readString(reaction.payload, "reaction", "emoji") ?? "∅"}
							</span>
						))}
					</div>
				)}
			</div>

			<MessageActions message={message} onReply={props.onReply} onReact={props.onReact} />
		</div>
	);
}
