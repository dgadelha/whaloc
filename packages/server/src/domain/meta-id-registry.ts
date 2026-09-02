import type { Repositories } from "../db/index.ts";
import { controlConflict } from "./control-plane-error.ts";

/**
 * Meta object ids are one namespace, not four.
 *
 * `GET /{id}` dispatches by whichever store holds the id (SPEC §2), so two objects sharing one
 * would leave the second permanently shadowed by whatever the resolver checks first. Generated
 * ids never collide in practice; the **explicit** ones the control plane accepts —
 * `POST /api/wabas` and `POST /api/phone-numbers`, so a dev can reproduce the ids their
 * production configuration already names — very much can, which is what this guards.
 *
 * It lives here rather than on either service because both need exactly the same answer: a WABA
 * that took a phone number's id and a phone number that took a WABA's id are the same bug.
 */
export async function findIdHolder(
	repositories: Repositories,
	id: string,
): Promise<"WABA" | "phone number" | "media object" | "template" | null> {
	if ((await repositories.wabas.findById(id)) !== null) {
		return "WABA";
	}

	if ((await repositories.phoneNumbers.findById(id)) !== null) {
		return "phone number";
	}

	if ((await repositories.media.findById(id)) !== null) {
		return "media object";
	}

	return (await repositories.templates.findById(id)) === null ? null : "template";
}

/**
 * Refuses an id another object already holds, naming **which kind** of object holds it: the
 * message is shown in the dialog that asked for the id, and "already taken" alone leaves a dev
 * hunting through four listings for it.
 */
export async function assertIdIsFree(repositories: Repositories, id: string, code: string): Promise<void> {
	const holder = await findIdHolder(repositories, id);

	if (holder !== null) {
		throw controlConflict(`the ID ${id} is already taken by a ${holder}`, code);
	}
}
