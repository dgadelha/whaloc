/**
 * The bubble WhatsApp shows while the other side is typing (SPEC §2.18).
 *
 * It sits on the outbound side of the thread, because the side that types here is the **app
 * under test**: it raised the indicator by sending `typing_indicator` on
 * `POST /{phoneNumberId}/messages`. Nothing here counts down — the server dismisses the
 * indicator after Meta's 25-second window and says so over the socket, so this component only
 * ever renders or does not.
 */
export function TypingBubble() {
	return (
		<div className="bubble-row bubble-row--out">
			<div className="bubble bubble--out bubble--typing" role="status" aria-label="typing">
				<span className="typing-dots" aria-hidden="true">
					<span className="typing-dots__dot" />
					<span className="typing-dots__dot" />
					<span className="typing-dots__dot" />
				</span>
			</div>
		</div>
	);
}
