import type { Kysely, Transaction } from "kysely";
import type { Database } from "../schema.ts";

/**
 * Whole-database reads and writes, for `GET /api/export` and `POST /api/import` (SPEC §5).
 *
 * Every other repository serves one entity in the shape the domain wants; this one serves the
 * **rows**, exactly as SQLite holds them — snake_case columns, JSON still encoded as TEXT. A
 * snapshot is a database dump, not an API resource, and going through the typed repositories
 * would mean an insert-then-update dance for every column they do not accept at creation (a
 * WABA's subscription, a number's rung on the ladder, a message's status…).
 *
 * SQL stays here all the same: `SnapshotService` decides *what* a snapshot is, this decides how
 * it is read and written.
 */

/** Every table a snapshot carries, **parents first** — which is the order they are inserted in. */
export const SNAPSHOT_TABLES = [
	"wabas",
	"phone_numbers",
	"contacts",
	"templates",
	"messages",
	"media",
	"upload_sessions",
	"webhook_deliveries",
	"injection_rules",
	"expired_tokens",
] as const;

export type SnapshotTableName = (typeof SNAPSHOT_TABLES)[number];

/** The rows of every snapshot table, keyed by table name. */
export type SnapshotTables = { [Table in SnapshotTableName]: Database[Table][] };

/**
 * SQLite caps the parameters one statement may bind, and a busy whaloc has thousands of
 * messages; 100 rows an insert stays far under it whatever the widest table is.
 */
const INSERT_CHUNK_ROWS = 100;

async function inChunks<TRow>(rows: readonly TRow[], insert: (chunk: TRow[]) => Promise<void>): Promise<void> {
	for (let index = 0; index < rows.length; index += INSERT_CHUNK_ROWS) {
		await insert(rows.slice(index, index + INSERT_CHUNK_ROWS));
	}
}

/**
 * Empties every snapshot table, children first. The mirror image of `deleteAllRows`, inside
 * the transaction the replacement runs in — the two orders are each other's reverse, which is
 * why {@link SNAPSHOT_TABLES} is written parents-first and walked backwards here.
 */
async function deleteEverything(trx: Transaction<Database>): Promise<void> {
	for (const table of SNAPSHOT_TABLES.toReversed()) {
		await trx.deleteFrom(table).execute();
	}
}

export class SnapshotRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	/**
	 * Every row of every table, in a **deterministic** order (SPEC's golden rule): two exports
	 * of the same state are byte-identical apart from the timestamp in their envelope.
	 *
	 * The delivery log is opt-in: it is the biggest table by far and it describes traffic
	 * rather than state, so `GET /api/export` leaves it out unless asked.
	 */
	async readAll(options: { includeDeliveries: boolean }): Promise<SnapshotTables> {
		return {
			wabas: await this.#db.selectFrom("wabas").selectAll().orderBy("created_at").orderBy("id").execute(),
			phone_numbers: await this.#db
				.selectFrom("phone_numbers")
				.selectAll()
				.orderBy("created_at")
				.orderBy("id")
				.execute(),
			contacts: await this.#db.selectFrom("contacts").selectAll().orderBy("created_at").orderBy("wa_id").execute(),
			templates: await this.#db.selectFrom("templates").selectAll().orderBy("created_at").orderBy("id").execute(),
			messages: await this.#db.selectFrom("messages").selectAll().orderBy("created_at").orderBy("id").execute(),
			media: await this.#db.selectFrom("media").selectAll().orderBy("created_at").orderBy("id").execute(),
			upload_sessions: await this.#db
				.selectFrom("upload_sessions")
				.selectAll()
				.orderBy("created_at")
				.orderBy("id")
				.execute(),
			webhook_deliveries: options.includeDeliveries
				? await this.#db.selectFrom("webhook_deliveries").selectAll().orderBy("created_at").orderBy("id").execute()
				: [],
			injection_rules: await this.#db
				.selectFrom("injection_rules")
				.selectAll()
				.orderBy("created_at")
				.orderBy("id")
				.execute(),
			expired_tokens: await this.#db.selectFrom("expired_tokens").selectAll().orderBy("token_id").execute(),
		};
	}

	/**
	 * Wipes every table and loads these rows instead, **in one transaction**: an import that
	 * fails halfway leaves the database it started from rather than a half-loaded snapshot.
	 * Foreign keys are on, so the insert order is the one {@link SNAPSHOT_TABLES} declares.
	 */
	async replaceAll(tables: SnapshotTables): Promise<void> {
		await this.#db.transaction().execute(async trx => {
			await deleteEverything(trx);

			await inChunks(tables.wabas, async chunk => {
				await trx.insertInto("wabas").values(chunk).execute();
			});
			await inChunks(tables.phone_numbers, async chunk => {
				await trx.insertInto("phone_numbers").values(chunk).execute();
			});
			await inChunks(tables.contacts, async chunk => {
				await trx.insertInto("contacts").values(chunk).execute();
			});
			await inChunks(tables.templates, async chunk => {
				await trx.insertInto("templates").values(chunk).execute();
			});
			await inChunks(tables.messages, async chunk => {
				await trx.insertInto("messages").values(chunk).execute();
			});
			await inChunks(tables.media, async chunk => {
				await trx.insertInto("media").values(chunk).execute();
			});
			await inChunks(tables.upload_sessions, async chunk => {
				await trx.insertInto("upload_sessions").values(chunk).execute();
			});
			await inChunks(tables.webhook_deliveries, async chunk => {
				await trx.insertInto("webhook_deliveries").values(chunk).execute();
			});
			await inChunks(tables.injection_rules, async chunk => {
				await trx.insertInto("injection_rules").values(chunk).execute();
			});
			await inChunks(tables.expired_tokens, async chunk => {
				await trx.insertInto("expired_tokens").values(chunk).execute();
			});
		});
	}
}
