import { BSUID_PATTERN } from "@whaloc/shared";
import type { MessageRecord, Repositories } from "../db/index.ts";
import type { OutboundMessageEvents } from "./domain-events.ts";
import { createWamid, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { phoneNumberNotRegisteredError, unknownObjectError } from "./meta-errors.ts";
import { messagePayloadOf, type SendMessageRequest } from "./send-message-request.ts";
import { assertTemplateIsSendable, assertTemplateParameters } from "./template-send-validation.ts";

export interface MessageServiceOptions {
	repositories: Repositories;
	events: OutboundMessageEvents;
	random?: RandomBytes;
}

export interface SendMessageResult {
	/** The recipient exactly as the caller wrote it — Meta echoes it back as `contacts[0].input`. */
	input: string;
	waId: string;
	message: MessageRecord;
}

/**
 * An MSISDN written with the punctuation people actually use: `+1 (650) 555-1234`. Anything
 * else — a business-scoped user id like `BR.ENT.4KgQ2wJ8` (SPEC §1.15) — is left alone.
 */
const MSISDN_INPUT_PATTERN = /^\+?[\d\s()-]+$/;

/** Meta's `wa_id` is the recipient's digits; the `input` it echoes back keeps the formatting. */
export function toWaId(input: string): string {
	return MSISDN_INPUT_PATTERN.test(input) ? input.replaceAll(/\D/g, "") : input;
}

/**
 * Sending outbound messages (SPEC §2.5).
 *
 * The service owns everything that happens on an accepted send — recipient resolution,
 * template validation, contact auto-creation, persistence — and then announces it through
 * {@link OutboundMessageEvents}. It never touches HTTP: the route hands it a parsed request
 * and turns the result into Meta's response envelope.
 */
export class MessageService {
	readonly #repositories: Repositories;
	readonly #events: OutboundMessageEvents;
	readonly #random: RandomBytes;

	constructor(options: MessageServiceOptions) {
		this.#repositories = options.repositories;
		this.#events = options.events;
		this.#random = options.random ?? defaultRandomBytes;
	}

	/**
	 * A `template` send only goes through when the template exists for the WABA that owns the
	 * sending phone number, is approved, and its parameters line up (SPEC §2).
	 */
	async #assertTemplateSendable(wabaId: string, request: SendMessageRequest): Promise<void> {
		if (request.type !== "template") {
			return;
		}

		const { name, language, components } = request.template;
		const template = await this.#repositories.templates.findByNameAndLanguage(wabaId, name, language.code);

		assertTemplateIsSendable(template, name, language.code);
		assertTemplateParameters(template, components);
	}

	/**
	 * A send to someone whaloc has never seen creates the contact, so the conversation shows
	 * up in the UI (SPEC §2). The profile name starts out as the MSISDN itself.
	 */
	async #ensureContact(waId: string): Promise<void> {
		if ((await this.#repositories.contacts.findByWaId(waId)) === null) {
			await this.#repositories.contacts.insert({ waId, profileName: waId });
		}
	}

	/**
	 * Who the message is for (SPEC §1.15). `to` is an MSISDN and needs nobody to exist; a
	 * `recipient` that is a **business-scoped user id** has to be *resolved*, because the id says
	 * nothing about the number behind it — whaloc cannot invent a person for it, and a consumer
	 * that sent the wrong BSUID would otherwise get a silent success and a conversation with a
	 * contact whose `wa_id` is not a phone number at all. An unknown one is therefore Meta's
	 * missing-object envelope (400 / 100 / 33, SPEC §1.4).
	 *
	 * A `recipient` that is *not* BSUID-shaped keeps the old lenient behavior: it is treated
	 * exactly like a `to`.
	 */
	async #resolveRecipient(request: SendMessageRequest): Promise<{ input: string; waId: string }> {
		if (request.to !== undefined) {
			return { input: request.to, waId: toWaId(request.to) };
		}

		// The schema guarantees one of the two is there.
		const recipient = request.recipient ?? "";

		if (!BSUID_PATTERN.test(recipient)) {
			return { input: recipient, waId: toWaId(recipient) };
		}

		const contact = await this.#repositories.contacts.findByUserId(recipient);

		if (contact === null) {
			throw unknownObjectError(recipient);
		}

		return { input: recipient, waId: contact.waId };
	}

	async send(phoneNumberId: string, request: SendMessageRequest): Promise<SendMessageResult> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(phoneNumberId);

		if (phoneNumber === null) {
			throw unknownObjectError(phoneNumberId);
		}

		// The registration gate (SPEC §4): only a `CONNECTED` number is on the Cloud API. Seeded
		// numbers and numbers created through the control plane are `CONNECTED` from the start,
		// so this only ever stops a number that has not finished — or has left — the ladder.
		if (phoneNumber.status !== "CONNECTED") {
			throw phoneNumberNotRegisteredError(phoneNumber.displayPhoneNumber);
		}

		const { input, waId } = await this.#resolveRecipient(request);

		await this.#assertTemplateSendable(phoneNumber.wabaId, request);
		await this.#ensureContact(waId);

		const message = await this.#repositories.messages.insert({
			id: createWamid(waId, this.#random),
			direction: "outbound",
			phoneNumberId,
			contactWaId: waId,
			type: request.type,
			payload: messagePayloadOf(request),
			status: "accepted",
			replyTo: request.context?.message_id ?? null,
			// Stored rather than echoed on the send response, because Meta only ever gives it back
			// on the status webhooks of this message (SPEC §2.5).
			bizOpaqueCallbackData: request.biz_opaque_callback_data ?? null,
		});

		this.#events.onOutboundAccepted(message);

		return { input, waId, message };
	}
}
