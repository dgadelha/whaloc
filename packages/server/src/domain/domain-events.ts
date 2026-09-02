import type { MessageRecord, TemplateRecord } from "../db/index.ts";

/**
 * The seams the status ladder and the template lifecycle plug into (SPEC §4).
 *
 * They are deliberately tiny: `MessageService` and `TemplateService` only announce that
 * something happened, and stay unaware of timers, webhooks and the delivery log. Both are
 * fire-and-forget — a listener schedules work, it never makes the caller wait — so a send
 * response goes out at Meta's speed no matter how slow the receiver is.
 *
 * The implementations are {@link StatusLadder} and {@link TemplateLifecycle}; a test that only
 * cares about persistence passes a spy instead.
 */

export interface OutboundMessageEvents {
	/** A send was accepted and persisted; the ladder starts here (SPEC §4). */
	onOutboundAccepted: (message: MessageRecord) => void;
}

/**
 * Fans one announcement out to several listeners, in order.
 *
 * An accepted send interests two of them: the status ladder starts climbing, and the typing
 * indicator of that conversation comes down (SPEC §2.18). Composing them here keeps
 * {@link MessageService} talking to the single seam it always had.
 */
export function combineOutboundMessageEvents(...listeners: readonly OutboundMessageEvents[]): OutboundMessageEvents {
	return {
		onOutboundAccepted: message => {
			for (const listener of listeners) {
				listener.onOutboundAccepted(message);
			}
		},
	};
}

export interface TemplateLifecycleEvents {
	/** A template was created and is `PENDING`; auto-approval is scheduled here. */
	onTemplateCreated: (template: TemplateRecord) => void;
	/** An edit put an existing template back to `PENDING`; review runs again. */
	onTemplateEdited: (template: TemplateRecord) => void;
	/** Templates were deleted; one `DELETED` status update goes out per language. */
	onTemplateDeleted: (templates: readonly TemplateRecord[]) => void;
}
