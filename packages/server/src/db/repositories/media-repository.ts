import type { Kysely } from "kysely";
import { nowIso } from "../../timestamps.ts";
import type { Database, MediaTable } from "../schema.ts";

export interface MediaRecord {
	id: string;
	phoneNumberId: string;
	mimeType: string;
	sha256: string;
	fileSize: number;
	storageKey: string;
	urlToken: string;
	createdAt: string;
}

export interface InsertMediaInput {
	id: string;
	phoneNumberId: string;
	mimeType: string;
	sha256: string;
	fileSize: number;
	storageKey: string;
	urlToken: string;
	createdAt?: string;
}

function toRecord(row: MediaTable): MediaRecord {
	return {
		id: row.id,
		phoneNumberId: row.phone_number_id,
		mimeType: row.mime_type,
		sha256: row.sha256,
		fileSize: row.file_size,
		storageKey: row.storage_key,
		urlToken: row.url_token,
		createdAt: row.created_at,
	};
}

/**
 * Media metadata; the bytes themselves live behind the `MediaStorage` interface and are
 * reached through `storage_key` (SPEC §6).
 */
export class MediaRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertMediaInput): Promise<MediaRecord> {
		const row = await this.#db
			.insertInto("media")
			.values({
				id: input.id,
				phone_number_id: input.phoneNumberId,
				mime_type: input.mimeType,
				sha256: input.sha256,
				file_size: input.fileSize,
				storage_key: input.storageKey,
				url_token: input.urlToken,
				created_at: input.createdAt ?? nowIso(),
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<MediaRecord | null> {
		const row = await this.#db.selectFrom("media").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Resolves the opaque token in a `/whaloc-media/:token` URL (SPEC §2.12). */
	async findByUrlToken(urlToken: string): Promise<MediaRecord | null> {
		const row = await this.#db.selectFrom("media").selectAll().where("url_token", "=", urlToken).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Every object, oldest first — what a reset deletes and what an export inlines (SPEC §5). */
	async listAll(): Promise<MediaRecord[]> {
		const rows = await this.#db.selectFrom("media").selectAll().orderBy("created_at").orderBy("id").execute();

		return rows.map(row => toRecord(row));
	}

	async listByPhoneNumberId(phoneNumberId: string): Promise<MediaRecord[]> {
		const rows = await this.#db
			.selectFrom("media")
			.selectAll()
			.where("phone_number_id", "=", phoneNumberId)
			.orderBy("created_at")
			.orderBy("id")
			.execute();

		return rows.map(row => toRecord(row));
	}

	async deleteById(id: string): Promise<boolean> {
		const result = await this.#db.deleteFrom("media").where("id", "=", id).executeTakeFirst();

		return result.numDeletedRows > 0n;
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("media").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
