import type { MessageErrorCode } from "@whaloc/shared";
import type { StatusDelays } from "../config/index.ts";
import type { JsonObject, MessageRecord, MessageStatus, Repositories } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import type { BackgroundTasks } from "./background-tasks.ts";
import { toMessageDto } from "./control-dto.ts";
import type { OutboundMessageEvents } from "./domain-events.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { messageErrorNode, messageErrorPreset } from "./message-error-presets.ts";
import { createSystemScheduler, type ScheduledTask, type Scheduler } from "./scheduler.ts";
import type { WebhookEmitter } from "./webhook-emitter.ts";
import {
	conversationNode,
	pricingNode,
	statusValue,
	webhookEnvelope,
	WEBHOOK_FIELDS,
	type ConversationCategory,
	type WebhookStatus,
} from "./webhook-payloads.ts";

/**
 * The deterministic status ladder (SPEC §4).
 *
 * An accepted send walks `sent` → `delivered` on the delays in `WHALOC_STATUS_DELAYS`, and
 * stops there: `read` only happens when `read:<ms>` is configured or a user presses the
 * button, and `failed` is always manual. Nothing here is random — that is the golden rule of
 * the project, and what makes a whaloc-backed test suite reproducible.
 *
 * Each message has at most one pending timer, replaced as it climbs. A manual transition
 * cancels it: marking a message `failed` stops the ladder dead, and marking it `read` early
 * skips the `delivered` rung it never got to.
 */

export interface StatusLadderOptions {
	repositories: Repositories;
	webhooks: WebhookEmitter;
	tasks: BackgroundTasks;
	logger: Logger;
	delays: StatusDelays;
	events?: EventPublisher;
	scheduler?: Scheduler;
}

/** Manual transitions the control plane offers (SPEC §5); `sent` is the ladder's own job. */
export type ManualStatus = "delivered" | "read" | "failed";

/** How far along a message is. `failed` is terminal, which is why it sits at the end. */
const STATUS_ORDER: Record<MessageStatus, number> = {
	accepted: 0,
	sent: 1,
	delivered: 2,
	read: 3,
	failed: 4,
};

/** A status webhook is only worth sending when the message actually moved forward. */
function canTransition(current: MessageStatus, next: WebhookStatus): boolean {
	return current !== "failed" && STATUS_ORDER[next] > STATUS_ORDER[current];
}

export class StatusLadder implements OutboundMessageEvents {
	readonly #repositories: Repositories;
	readonly #webhooks: WebhookEmitter;
	readonly #tasks: BackgroundTasks;
	readonly #logger: Logger;
	readonly #delays: StatusDelays;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #pending = new Map<string, ScheduledTask>();

	constructor(options: StatusLadderOptions) {
		this.#repositories = options.repositories;
		this.#webhooks = options.webhooks;
		this.#tasks = options.tasks;
		this.#logger = options.logger;
		this.#delays = options.delays;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	#schedule(messageId: string, status: WebhookStatus, delayMs: number): void {
		this.cancel(messageId);

		const task = this.#scheduler.schedule(delayMs, () => {
			this.#pending.delete(messageId);
			this.#tasks.run(() => this.#climb(messageId, status));
		});

		this.#pending.set(messageId, task);
	}

	/** One automatic rung: apply it if the message is still behind, then queue the next one. */
	async #climb(messageId: string, status: WebhookStatus): Promise<void> {
		const message = await this.#repositories.messages.findById(messageId);

		if (message === null || !canTransition(message.status, status)) {
			return;
		}

		await this.#transition(message, status);

		if (status === "sent") {
			this.#schedule(messageId, "delivered", this.#delays.delivered);
		} else if (status === "delivered" && this.#delays.read !== null) {
			// `read` climbs on its own only when `WHALOC_STATUS_DELAYS` says so (SPEC §4).
			this.#schedule(messageId, "read", this.#delays.read);
		}
	}

	/**
	 * The conversation category a status reports: the category of the template that was sent,
	 * lowercased, or `service` for everything else (SPEC §4).
	 */
	async #conversationCategory(message: MessageRecord): Promise<ConversationCategory> {
		if (message.type !== "template") {
			return "service";
		}

		const phoneNumber = await this.#repositories.phoneNumbers.findById(message.phoneNumberId);
		const template = message.payload["template"];

		if (phoneNumber === null || typeof template !== "object" || template === null) {
			return "service";
		}

		const { name, language } = template as { name?: unknown; language?: { code?: unknown } };
		const languageCode = language?.code;

		if (typeof name !== "string" || typeof languageCode !== "string") {
			return "service";
		}

		const record = await this.#repositories.templates.findByNameAndLanguage(phoneNumber.wabaId, name, languageCode);

		return record === null ? "service" : (record.category.toLowerCase() as ConversationCategory);
	}

	async #emit(message: MessageRecord, status: WebhookStatus, error?: JsonObject): Promise<void> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(message.phoneNumberId);

		if (phoneNumber === null) {
			this.#logger.warn({ messageId: message.id }, "cannot emit a status webhook for an unknown phone number");

			return;
		}

		const at = this.#scheduler.now();
		// `sent` and `delivered` carry the conversation window and its price (SPEC §4).
		const hasConversation = status === "sent" || status === "delivered";
		const category = hasConversation ? await this.#conversationCategory(message) : "service";
		// A recipient with a business-scoped user id gets `recipient_user_id` alongside
		// `recipient_id` (SPEC §1.15) — it is what a consumer records the BSUID from.
		const contact = await this.#repositories.contacts.findByWaId(message.contactWaId);
		const value = statusValue({
			phoneNumber,
			message,
			status,
			at,
			recipientUserId: contact?.userId ?? null,
			// Echoed on every rung, manual or automatic, which is what makes it a correlation key
			// rather than a one-off acknowledgement (SPEC §2.5).
			bizOpaqueCallbackData: message.bizOpaqueCallbackData,
			...(hasConversation && {
				conversation: conversationNode({
					phoneNumberId: message.phoneNumberId,
					contactWaId: message.contactWaId,
					category,
					at,
				}),
				pricing: pricingNode(category),
			}),
			...(error !== undefined && { errors: [error] }),
		});

		await this.#webhooks.emit(
			WEBHOOK_FIELDS.messages,
			webhookEnvelope({ wabaId: phoneNumber.wabaId, field: WEBHOOK_FIELDS.messages, value }),
		);
	}

	/** Persists the new status, then announces it: WebSocket first, webhook right after. */
	async #transition(message: MessageRecord, status: WebhookStatus, error?: JsonObject): Promise<MessageRecord | null> {
		const updated = await this.#repositories.messages.updateStatus(message.id, {
			status,
			...(error !== undefined && { error }),
			updatedAt: this.#scheduler.now().toISOString(),
		});

		if (updated === null) {
			return null;
		}

		this.#events.publish({
			type: "message.status_changed",
			payload: { message: toMessageDto(updated), previousStatus: message.status },
		});

		this.#tasks.run(() => this.#emit(updated, status, error));

		return updated;
	}

	/**
	 * `MessageService` announces every accepted send here. The UI hears about the message
	 * straight away — it is already stored — and the ladder starts climbing at `sent`.
	 */
	onOutboundAccepted(message: MessageRecord): void {
		this.#events.publish({ type: "message.created", payload: { message: toMessageDto(message) } });
		this.#schedule(message.id, "sent", this.#delays.sent);
	}

	/** Drops the pending timer of one message — a manual transition, or a reset. */
	cancel(messageId: string): void {
		this.#pending.get(messageId)?.cancel();
		this.#pending.delete(messageId);
	}

	/** Drops every pending timer (`POST /api/reset`, shutdown). */
	cancelAll(): void {
		for (const task of this.#pending.values()) {
			task.cancel();
		}

		this.#pending.clear();
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	/**
	 * A manual transition from the control plane (SPEC §5). It cancels whatever the ladder had
	 * queued, so a message marked `failed` never turns up `delivered` a moment later.
	 *
	 * Returns the updated message, or `null` when the id is unknown or the message already
	 * moved past that status.
	 */
	async markStatus(
		messageId: string,
		status: ManualStatus,
		errorCode?: MessageErrorCode,
	): Promise<MessageRecord | null> {
		const message = await this.#repositories.messages.findById(messageId);

		if (message === null) {
			return null;
		}

		this.cancel(messageId);

		if (!canTransition(message.status, status)) {
			return null;
		}

		const error = status === "failed" ? messageErrorNode(messageErrorPreset(errorCode)) : undefined;

		return this.#transition(message, status, error);
	}
}
