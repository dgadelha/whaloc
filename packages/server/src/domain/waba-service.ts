import type { ChangeEvent, WabaCreateRequest, WabaUpdateRequest } from "@whaloc/shared";
import type { Repositories, WabaRecord } from "../db/index.ts";
import { toWabaDto } from "./control-dto.ts";
import { controlNotFound } from "./control-plane-error.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createWabaId, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { assertIdIsFree } from "./meta-id-registry.ts";
import type { PhoneNumberService } from "./phone-number-service.ts";

/**
 * WhatsApp Business Accounts at runtime (SPEC §5).
 *
 * `WHALOC_SEED` describes the world whaloc boots with; this is how a dev adds a second WABA to
 * an already-running container — the case the seed cannot cover, and the one an app that manages
 * several accounts needs to be tested against.
 *
 * Deleting the *last* WABA is allowed. An empty whaloc is a legal state (the UI says so and the
 * Chats view explains itself), and refusing would mean the only way back from a mistyped WABA is
 * a reset.
 */
export interface WabaServiceOptions {
	repositories: Repositories;
	/** The cascade goes through the phone numbers, so their media bytes go too. */
	phoneNumbers: PhoneNumberService;
	events?: EventPublisher;
	random?: RandomBytes;
}

export class WabaService {
	readonly #repositories: Repositories;
	readonly #phoneNumbers: PhoneNumberService;
	readonly #events: EventPublisher;
	readonly #random: RandomBytes;

	constructor(options: WabaServiceOptions) {
		this.#repositories = options.repositories;
		this.#phoneNumbers = options.phoneNumbers;
		this.#events = options.events ?? noopEventPublisher;
		this.#random = options.random ?? defaultRandomBytes;
	}

	#announce(waba: WabaRecord, event: ChangeEvent): void {
		this.#events.publish({ type: "waba.changed", payload: { waba: toWabaDto(waba), event } });
	}

	async list(): Promise<WabaRecord[]> {
		return this.#repositories.wabas.list();
	}

	/** `POST /api/wabas`. An explicit id is honored so a fixed configuration can be reproduced. */
	async create(input: WabaCreateRequest): Promise<WabaRecord> {
		const id = input.id ?? createWabaId(this.#random);

		await assertIdIsFree(this.#repositories, id, "duplicate_waba");

		const created = await this.#repositories.wabas.insert({ id, name: input.name });

		this.#announce(created, "created");

		return created;
	}

	/** `PATCH /api/wabas/:id`. */
	async rename(wabaId: string, input: WabaUpdateRequest): Promise<WabaRecord> {
		const updated = await this.#repositories.wabas.update(wabaId, { name: input.name });

		if (updated === null) {
			throw controlNotFound(`no WABA with id ${wabaId}`, "unknown_waba");
		}

		this.#announce(updated, "updated");

		return updated;
	}

	/**
	 * `DELETE /api/wabas/:id` — the account and everything under it: phone numbers (each with
	 * its conversations, messages and media, bytes included) and templates.
	 *
	 * The schema's cascades would take the rows anyway; walking the children explicitly is what
	 * gets the media files deleted and every `phone_number.changed` announced, so a UI watching
	 * the socket ends up in the same state as one that reloads.
	 */
	async delete(wabaId: string): Promise<WabaRecord> {
		const waba = await this.#repositories.wabas.findById(wabaId);

		if (waba === null) {
			throw controlNotFound(`no WABA with id ${wabaId}`, "unknown_waba");
		}

		const phoneNumbers = await this.#repositories.phoneNumbers.listByWabaId(wabaId);

		for (const phoneNumber of phoneNumbers) {
			await this.#phoneNumbers.delete(phoneNumber.id);
		}

		await this.#repositories.templates.deleteByWabaId(wabaId);
		await this.#repositories.wabas.deleteById(wabaId);
		this.#announce(waba, "deleted");

		return waba;
	}
}
