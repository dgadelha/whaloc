import type { MediaRecord, PhoneNumberRecord, Repositories, TemplateRecord, WabaRecord } from "../db/index.ts";
import { unknownObjectError } from "./meta-errors.ts";

/**
 * The Graph API has one path for every kind of object — `GET /{id}` — and works out what the
 * id is by looking it up. whaloc does the same across its four stores (SPEC §2), which is why
 * this is a service and not four routes.
 */
export type GraphObject =
	| { kind: "phoneNumber"; phoneNumber: PhoneNumberRecord }
	| { kind: "waba"; waba: WabaRecord }
	| { kind: "media"; media: MediaRecord }
	| { kind: "template"; template: TemplateRecord };

export interface ObjectServiceOptions {
	repositories: Repositories;
}

export class ObjectService {
	readonly #repositories: Repositories;

	constructor(options: ObjectServiceOptions) {
		this.#repositories = options.repositories;
	}

	/**
	 * Resolves an id against every store, in the order SPEC §2 lists them. Nothing found is
	 * the "object missing" envelope — HTTP 400 with `code:100, error_subcode:33`, never a 404
	 * (SPEC §1.4).
	 */
	async resolve(id: string): Promise<GraphObject> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(id);

		if (phoneNumber !== null) {
			return { kind: "phoneNumber", phoneNumber };
		}

		const waba = await this.#repositories.wabas.findById(id);

		if (waba !== null) {
			return { kind: "waba", waba };
		}

		const media = await this.#repositories.media.findById(id);

		if (media !== null) {
			return { kind: "media", media };
		}

		const template = await this.#repositories.templates.findById(id);

		if (template !== null) {
			return { kind: "template", template };
		}

		throw unknownObjectError(id);
	}

	/** `GET /{wabaId}/phone_numbers` (SPEC §2.11). */
	async listPhoneNumbers(wabaId: string): Promise<PhoneNumberRecord[]> {
		if ((await this.#repositories.wabas.findById(wabaId)) === null) {
			throw unknownObjectError(wabaId);
		}

		return this.#repositories.phoneNumbers.listByWabaId(wabaId);
	}
}
