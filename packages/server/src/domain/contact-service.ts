import type { ContactCreateRequest, ContactNumberChangeRequest, ContactUpdateRequest } from "@whaloc/shared";
import type { ContactRecord, PhoneNumberRecord, Repositories } from "../db/index.ts";
import type { BackgroundTasks } from "./background-tasks.ts";
import { toContactDto } from "./control-dto.ts";
import { controlBadRequest, controlConflict, controlNotFound } from "./control-plane-error.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createWamid, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";
import type { WebhookEmitter } from "./webhook-emitter.ts";
import { systemNumberChangeValue, webhookEnvelope, WEBHOOK_FIELDS } from "./webhook-payloads.ts";

/**
 * Contacts as the control plane manages them (SPEC §5): the WhatsApp users whaloc pretends to
 * be. Sends and inbound simulations create them on the fly; this is the explicit CRUD the UI
 * uses to add one up front, rename it, give it a **business-scoped user id** (SPEC §1.15), or
 * move it to a new number — the last of which is what Meta announces with a
 * `user_changed_number` system event.
 */
export interface ContactServiceOptions {
	repositories: Repositories;
	webhooks: WebhookEmitter;
	tasks: BackgroundTasks;
	events?: EventPublisher;
	scheduler?: Scheduler;
	random?: RandomBytes;
}

export class ContactService {
	readonly #repositories: Repositories;
	readonly #webhooks: WebhookEmitter;
	readonly #tasks: BackgroundTasks;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #random: RandomBytes;

	constructor(options: ContactServiceOptions) {
		this.#repositories = options.repositories;
		this.#webhooks = options.webhooks;
		this.#tasks = options.tasks;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#random = options.random ?? defaultRandomBytes;
	}

	#announce(contact: ContactRecord, previousWaId?: string): void {
		this.#events.publish({
			type: "contact.changed",
			payload: { contact: toContactDto(contact), ...(previousWaId !== undefined && { previousWaId }) },
		});
	}

	/**
	 * A BSUID identifies exactly one person: it is the key `POST /{phoneNumberId}/messages`
	 * resolves a `recipient` through (SPEC §2.5), so a duplicate would make that ambiguous.
	 */
	async #assertUserIdIsFree(userId: string | null | undefined, waId?: string): Promise<void> {
		if (userId === null || userId === undefined) {
			return;
		}

		const owner = await this.#repositories.contacts.findByUserId(userId);

		if (owner !== null && owner.waId !== waId) {
			throw controlConflict(`the business-scoped user id ${userId} belongs to contact ${owner.waId}`, "user_id_taken");
		}
	}

	/**
	 * The business numbers a number change is announced to: the one the caller named, or every
	 * number that has a conversation with the contact — which is exactly who Meta would tell.
	 */
	async #targetsOf(waId: string, phoneNumberId?: string): Promise<PhoneNumberRecord[]> {
		if (phoneNumberId !== undefined) {
			const phoneNumber = await this.#repositories.phoneNumbers.findById(phoneNumberId);

			if (phoneNumber === null) {
				throw controlNotFound(`no phone number with id ${phoneNumberId}`, "unknown_phone_number");
			}

			return [phoneNumber];
		}

		const summaries = await this.#repositories.messages.listConversations();
		const targets: PhoneNumberRecord[] = [];

		for (const summary of summaries) {
			if (summary.contactWaId !== waId) {
				continue;
			}

			const phoneNumber = await this.#repositories.phoneNumbers.findById(summary.phoneNumberId);

			if (phoneNumber !== null) {
				targets.push(phoneNumber);
			}
		}

		return targets;
	}

	async list(): Promise<ContactRecord[]> {
		return this.#repositories.contacts.list();
	}

	async find(waId: string): Promise<ContactRecord | null> {
		return this.#repositories.contacts.findByWaId(waId);
	}

	async create(request: ContactCreateRequest): Promise<ContactRecord> {
		if ((await this.#repositories.contacts.findByWaId(request.waId)) !== null) {
			throw controlConflict(`a contact with wa_id ${request.waId} already exists`, "contact_exists");
		}

		await this.#assertUserIdIsFree(request.userId);

		const contact = await this.#repositories.contacts.insert({
			waId: request.waId,
			profileName: request.profileName,
			...(request.userId !== undefined && { userId: request.userId }),
		});

		this.#announce(contact);

		return contact;
	}

	/** `PATCH /api/contacts/:waId`; `null` when there is no such contact. */
	async update(waId: string, request: ContactUpdateRequest): Promise<ContactRecord | null> {
		// Existence first: a PATCH to a contact that is not there is a 404, even when the BSUID it
		// carries happens to belong to someone else.
		if ((await this.#repositories.contacts.findByWaId(waId)) === null) {
			return null;
		}

		await this.#assertUserIdIsFree(request.userId, waId);

		const contact = await this.#repositories.contacts.update(waId, request);

		if (contact !== null) {
			this.#announce(contact);
		}

		return contact;
	}

	/**
	 * `POST /api/contacts/:waId/change-number` — the person moved (SPEC §5).
	 *
	 * The contact keeps its identity (profile name, BSUID, created timestamp) and takes its
	 * messages with it, so a reaction or a read receipt naming an older wamid keeps working. What
	 * *does* change is every **derived conversation id** (`<phoneNumberId>:<waId>`), which is why
	 * the `contact.changed` event carries the number the person left.
	 */
	async changeNumber(waId: string, request: ContactNumberChangeRequest): Promise<ContactRecord> {
		const contact = await this.#repositories.contacts.findByWaId(waId);

		if (contact === null) {
			throw controlNotFound(`no contact with wa_id ${waId}`, "unknown_contact");
		}

		if (request.waId === waId) {
			throw controlBadRequest(`contact ${waId} is already on that number`, "unchanged_number");
		}

		if ((await this.#repositories.contacts.findByWaId(request.waId)) !== null) {
			throw controlConflict(`a contact with wa_id ${request.waId} already exists`, "contact_exists");
		}

		const targets = await this.#targetsOf(waId, request.phoneNumberId);
		// Not null: the contact was read a few lines up, and nothing else writes concurrently.
		const moved = (await this.#repositories.contacts.changeWaId(waId, request.waId))!;

		this.#announce(moved, waId);

		for (const phoneNumber of targets) {
			const value = systemNumberChangeValue({
				phoneNumber,
				contact: moved,
				previousWaId: waId,
				messageId: createWamid(waId, this.#random),
				at: this.#scheduler.now(),
			});

			this.#tasks.run(() => {
				return this.#webhooks.emit(
					WEBHOOK_FIELDS.messages,
					webhookEnvelope({ wabaId: phoneNumber.wabaId, field: WEBHOOK_FIELDS.messages, value }),
				);
			});
		}

		return moved;
	}
}
