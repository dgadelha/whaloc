import type { TypingIndicator } from "@whaloc/shared";
import type { MessageRecord, Repositories } from "../db/index.ts";
import { toMessageDto } from "./control-dto.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { invalidParameterError, phoneNumberNotRegisteredError, unknownObjectError } from "./meta-errors.ts";
import type { MarkReadRequest } from "./read-receipt-request.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";
import type { TypingService } from "./typing-service.ts";

export interface ReadReceiptServiceOptions {
	repositories: Repositories;
	typing: TypingService;
	events?: EventPublisher;
	scheduler?: Scheduler;
}

export interface MarkReadResult {
	message: MessageRecord;
	/** The indicator the same request raised, when it carried `typing_indicator`. */
	typing: TypingIndicator | null;
}

/**
 * The business reading a user's message (SPEC §2.18).
 *
 * This is the mirror image of the status ladder: there, whaloc reports what happened to an
 * **outbound** message; here, the app under test tells whaloc it has read an **inbound** one.
 * So the row that moves is the inbound message, and it moves to `read` — which is why the UI
 * hears about it as a plain `message.status_changed`.
 *
 * **No webhook goes out.** Meta reports statuses for outbound messages only: the business
 * marking a user's message read is announced to the *user's* phone, not back to the business.
 * A whaloc that emitted one would teach a consumer to expect a callback that production never
 * sends.
 */
export class ReadReceiptService {
	readonly #repositories: Repositories;
	readonly #typing: TypingService;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;

	constructor(options: ReadReceiptServiceOptions) {
		this.#repositories = options.repositories;
		this.#typing = options.typing;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	/**
	 * The message the receipt names, once it is established that this phone number could have
	 * read it. Every failure is Meta's "object missing" envelope (SPEC §1.4) except the one
	 * whaloc can explain better: an *outbound* wamid is a mistake in the caller's code, so it
	 * gets `(#100) Invalid parameter` with the reason in `error_data.details`.
	 */
	async #resolveInbound(phoneNumberId: string, messageId: string): Promise<MessageRecord> {
		const message = await this.#repositories.messages.findById(messageId);

		if (message === null || message.phoneNumberId !== phoneNumberId) {
			throw unknownObjectError(messageId);
		}

		if (message.direction !== "inbound") {
			throw invalidParameterError(
				"Param message_id must be the id of a message received from the user, not one sent to them",
			);
		}

		return message;
	}

	/** Persists `read` unless the message is already there; announces only a real move. */
	async #markRead(message: MessageRecord): Promise<MessageRecord> {
		if (message.status === "read") {
			return message;
		}

		const updated = await this.#repositories.messages.updateStatus(message.id, {
			status: "read",
			updatedAt: this.#scheduler.now().toISOString(),
		});

		if (updated === null) {
			return message;
		}

		this.#events.publish({
			type: "message.status_changed",
			payload: { message: toMessageDto(updated), previousStatus: message.status },
		});

		return updated;
	}

	/**
	 * `POST /{phoneNumberId}/messages` with `status: "read"`. Idempotent: reading an
	 * already-read message answers `{success:true}` and changes nothing.
	 *
	 * A `typing_indicator` marks the message read **as well** — that is Meta's own semantics
	 * for the combined body, not a shortcut — and raises the indicator for that conversation.
	 */
	async markRead(phoneNumberId: string, request: MarkReadRequest): Promise<MarkReadResult> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(phoneNumberId);

		if (phoneNumber === null) {
			throw unknownObjectError(phoneNumberId);
		}

		// The same gate a send walks through (SPEC §4): a number that is not on the Cloud API
		// cannot read messages either, and `133010` is what a consumer keys that on.
		if (phoneNumber.status !== "CONNECTED") {
			throw phoneNumberNotRegisteredError(phoneNumber.displayPhoneNumber);
		}

		const message = await this.#markRead(await this.#resolveInbound(phoneNumberId, request.message_id));
		const typing =
			request.typing_indicator === undefined ? null : this.#typing.start(phoneNumberId, message.contactWaId);

		return { message, typing };
	}
}
