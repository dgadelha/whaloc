import type { Kysely } from "kysely";
import { nowIso } from "../../timestamps.ts";
import type { ContactTable, Database } from "../schema.ts";

export interface ContactRecord {
	waId: string;
	profileName: string;
	/** The contact's business-scoped user id (SPEC §1.15), `null` when it has none. */
	userId: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface InsertContactInput {
	waId: string;
	profileName: string;
	userId?: string | null;
	createdAt?: string;
}

/** `PATCH /api/contacts/:waId`: whichever of the two is present changes. */
export interface UpdateContactInput {
	profileName?: string;
	/** `null` clears the BSUID; `undefined` leaves it alone. */
	userId?: string | null;
	updatedAt?: string;
}

function toRecord(row: ContactTable): ContactRecord {
	return {
		waId: row.wa_id,
		profileName: row.profile_name,
		userId: row.user_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * The people on the user side of a conversation, keyed by `wa_id` (SPEC §1.15): the same
 * contact can talk to several business numbers, so contacts are not scoped to one.
 *
 * A contact may also carry a **business-scoped user id** — unique when set, which is what makes
 * a send addressed by `recipient` resolvable to exactly one person.
 */
export class ContactRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertContactInput): Promise<ContactRecord> {
		const timestamp = input.createdAt ?? nowIso();
		const row = await this.#db
			.insertInto("contacts")
			.values({
				wa_id: input.waId,
				profile_name: input.profileName,
				user_id: input.userId ?? null,
				created_at: timestamp,
				updated_at: timestamp,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findByWaId(waId: string): Promise<ContactRecord | null> {
		const row = await this.#db.selectFrom("contacts").selectAll().where("wa_id", "=", waId).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** The contact that owns a business-scoped user id — how `recipient` is resolved (SPEC §2.5). */
	async findByUserId(userId: string): Promise<ContactRecord | null> {
		const row = await this.#db.selectFrom("contacts").selectAll().where("user_id", "=", userId).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async list(): Promise<ContactRecord[]> {
		const rows = await this.#db.selectFrom("contacts").selectAll().orderBy("created_at").orderBy("wa_id").execute();

		return rows.map(row => toRecord(row));
	}

	async update(waId: string, input: UpdateContactInput): Promise<ContactRecord | null> {
		if (input.profileName === undefined && input.userId === undefined) {
			return this.findByWaId(waId);
		}

		const row = await this.#db
			.updateTable("contacts")
			.set({
				...(input.profileName !== undefined && { profile_name: input.profileName }),
				...(input.userId !== undefined && { user_id: input.userId }),
				updated_at: input.updatedAt ?? nowIso(),
			})
			.where("wa_id", "=", waId)
			.returningAll()
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/**
	 * Moves a contact to a new `wa_id`, taking its messages with it — the row behind Meta's
	 * `user_changed_number` system event (SPEC §5). `null` when there is no such contact.
	 *
	 * `messages.contact_wa_id` references this table's primary key with no `on update cascade`,
	 * so the key cannot simply be updated in place: the new row is inserted, the messages are
	 * moved across, and only then does the old row go — which is also why the BSUID is parked on
	 * the way through, since exactly one row may hold it at a time. All four statements share one
	 * transaction, so a conversation is never left pointing at a contact that does not exist.
	 */
	async changeWaId(waId: string, nextWaId: string, updatedAt?: string): Promise<ContactRecord | null> {
		const timestamp = updatedAt ?? nowIso();

		return this.#db.transaction().execute(async trx => {
			const existing = await trx.selectFrom("contacts").selectAll().where("wa_id", "=", waId).executeTakeFirst();

			if (existing === undefined) {
				return null;
			}

			if (existing.user_id !== null) {
				await trx.updateTable("contacts").set({ user_id: null }).where("wa_id", "=", waId).execute();
			}

			const row = await trx
				.insertInto("contacts")
				.values({ ...existing, wa_id: nextWaId, updated_at: timestamp })
				.returningAll()
				.executeTakeFirstOrThrow();

			await trx.updateTable("messages").set({ contact_wa_id: nextWaId }).where("contact_wa_id", "=", waId).execute();
			await trx.deleteFrom("contacts").where("wa_id", "=", waId).execute();

			return toRecord(row);
		});
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("contacts").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
