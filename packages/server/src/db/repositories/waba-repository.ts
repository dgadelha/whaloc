import type { Kysely } from "kysely";
import { nowIso } from "../../timestamps.ts";
import type { Database, WabaTable } from "../schema.ts";

export interface WabaRecord {
	id: string;
	name: string;
	/** When an app subscribed to this WABA's webhooks; `null` when none has (SPEC §2.20). */
	subscribedAt: string | null;
	createdAt: string;
}

export interface InsertWabaInput {
	id: string;
	name: string;
	/** ISO timestamp; defaults to now. */
	createdAt?: string;
}

export interface UpdateWabaInput {
	name?: string;
	/** `null` unsubscribes; a timestamp records the subscription (SPEC §2.20). */
	subscribedAt?: string | null;
}

function toRecord(row: WabaTable): WabaRecord {
	return { id: row.id, name: row.name, subscribedAt: row.subscribed_at, createdAt: row.created_at };
}

/** WhatsApp Business Accounts — the root of every other entity (SPEC §6). */
export class WabaRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertWabaInput): Promise<WabaRecord> {
		const row = await this.#db
			.insertInto("wabas")
			.values({
				id: input.id,
				name: input.name,
				subscribed_at: null,
				created_at: input.createdAt ?? nowIso(),
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<WabaRecord | null> {
		const row = await this.#db.selectFrom("wabas").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async list(): Promise<WabaRecord[]> {
		const rows = await this.#db.selectFrom("wabas").selectAll().orderBy("created_at").orderBy("id").execute();

		return rows.map(row => toRecord(row));
	}

	/**
	 * A WABA's two mutable columns: the name the control plane renames (SPEC §5), and the
	 * subscription `POST|DELETE /{wabaId}/subscribed_apps` toggles (SPEC §2.20).
	 */
	async update(id: string, input: UpdateWabaInput): Promise<WabaRecord | null> {
		const patch = {
			...(input.name !== undefined && { name: input.name }),
			...(input.subscribedAt !== undefined && { subscribed_at: input.subscribedAt }),
		};

		if (Object.keys(patch).length === 0) {
			return this.findById(id);
		}

		const row = await this.#db.updateTable("wabas").set(patch).where("id", "=", id).returningAll().executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/**
	 * Removes one WABA. The schema cascades from here down to messages and media *rows*;
	 * {@link WabaService} walks the children first so the media bytes and the WebSocket events
	 * are not left behind.
	 */
	async deleteById(id: string): Promise<boolean> {
		const result = await this.#db.deleteFrom("wabas").where("id", "=", id).executeTakeFirst();

		return Number(result.numDeletedRows) > 0;
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("wabas").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
