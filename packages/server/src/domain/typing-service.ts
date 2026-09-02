import { conversationId, type TypingIndicator } from "@whaloc/shared";
import type { MessageRecord } from "../db/index.ts";
import type { OutboundMessageEvents } from "./domain-events.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createSystemScheduler, type ScheduledTask, type Scheduler } from "./scheduler.ts";

/**
 * Typing indicators (SPEC §2.18).
 *
 * Meta shows a typing indicator for **25 seconds**, or until the business sends its next
 * message — whichever comes first. whaloc reproduces both halves and nothing else: the state
 * lives in memory next to the status-ladder timers (SPEC §4), keyed by conversation, and every
 * change is announced over the control-plane WebSocket so the UI can render the bubble.
 *
 * Deterministic like the rest of the project: the dismissal is one scheduled task through the
 * injected {@link Scheduler}, replaced (never duplicated) when the app raises the indicator
 * again, and cancelled when the conversation's next outbound message is accepted.
 */

/** Meta's dismissal window: an indicator that nobody refreshes disappears after 25 s. */
export const TYPING_INDICATOR_TTL_MS = 25_000;

export interface TypingServiceOptions {
	events?: EventPublisher;
	scheduler?: Scheduler;
	/** Overridden by the specs; the default is Meta's window. */
	ttlMs?: number;
}

interface ActiveIndicator {
	phoneNumberId: string;
	contactWaId: string;
	expiresAt: Date;
	dismissal: ScheduledTask;
}

/**
 * Also an {@link OutboundMessageEvents} listener: the business sending anything is what makes
 * WhatsApp drop the indicator, so the service hears about accepted sends directly.
 */
export class TypingService implements OutboundMessageEvents {
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #ttlMs: number;
	readonly #active = new Map<string, ActiveIndicator>();

	constructor(options: TypingServiceOptions = {}) {
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#ttlMs = options.ttlMs ?? TYPING_INDICATOR_TTL_MS;
	}

	#announce(indicator: TypingIndicator): void {
		this.#events.publish({ type: "typing.changed", payload: { typing: indicator } });
	}

	#drop(key: string): ActiveIndicator | null {
		const indicator = this.#active.get(key);

		if (indicator === undefined) {
			return null;
		}

		indicator.dismissal.cancel();
		this.#active.delete(key);

		return indicator;
	}

	/**
	 * Raises the indicator for one conversation, or pushes an existing one's dismissal back —
	 * an app that keeps saying "still typing" keeps the bubble up, which is what the 25-second
	 * window is for.
	 */
	start(phoneNumberId: string, contactWaId: string): TypingIndicator {
		const key = conversationId(phoneNumberId, contactWaId);

		this.#drop(key);

		const expiresAt = new Date(this.#scheduler.now().getTime() + this.#ttlMs);
		const dismissal = this.#scheduler.schedule(this.#ttlMs, () => {
			this.clear(phoneNumberId, contactWaId);
		});

		this.#active.set(key, { phoneNumberId, contactWaId, expiresAt, dismissal });

		const indicator: TypingIndicator = { phoneNumberId, contactWaId, expiresAt: expiresAt.toISOString() };

		this.#announce(indicator);

		return indicator;
	}

	/** Takes the indicator down. Announces nothing when there was none — this is idempotent. */
	clear(phoneNumberId: string, contactWaId: string): void {
		if (this.#drop(conversationId(phoneNumberId, contactWaId)) === null) {
			return;
		}

		this.#announce({ phoneNumberId, contactWaId, expiresAt: null });
	}

	/** Drops every indicator without announcing (`POST /api/reset`, shutdown). */
	clearAll(): void {
		for (const indicator of this.#active.values()) {
			indicator.dismissal.cancel();
		}

		this.#active.clear();
	}

	/**
	 * The live indicators, so a UI that just loaded sees one that is already up (SPEC §5).
	 * Anything past its window is dropped on the way out: with a scheduler whose clock a test
	 * moves by hand, the dismissal task is not what decides whether an indicator is stale.
	 */
	list(phoneNumberId?: string): TypingIndicator[] {
		const now = this.#scheduler.now().getTime();
		const indicators: TypingIndicator[] = [];

		for (const indicator of this.#active.values()) {
			const isExpired = indicator.expiresAt.getTime() <= now;
			const isWanted = phoneNumberId === undefined || indicator.phoneNumberId === phoneNumberId;

			if (!isExpired && isWanted) {
				indicators.push({
					phoneNumberId: indicator.phoneNumberId,
					contactWaId: indicator.contactWaId,
					expiresAt: indicator.expiresAt.toISOString(),
				});
			}
		}

		return indicators;
	}

	get activeCount(): number {
		return this.#active.size;
	}

	/** The business sent something: WhatsApp replaces the indicator with the message. */
	onOutboundAccepted(message: MessageRecord): void {
		this.clear(message.phoneNumberId, message.contactWaId);
	}
}
