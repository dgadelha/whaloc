import type { Kysely } from "kysely";
import { nowIso } from "../../timestamps.ts";
import type { Database, UploadSessionTable } from "../schema.ts";

/**
 * Resumable Upload API sessions and the handles they produce (SPEC §2.21).
 *
 * One row is the whole life of an upload: opened by `POST /{appId}/uploads`, advanced by every
 * `POST /upload:<id>` chunk, and — once `receivedBytes` reaches `fileLength` — carrying the
 * handle, the storage key and the public token the bytes are served under. That is why the
 * handle survives a restart with a file database while nothing else about the flow needs to.
 */
export interface UploadSessionRecord {
	id: string;
	appId: string;
	fileName: string | null;
	fileType: string;
	fileLength: number;
	receivedBytes: number;
	handle: string | null;
	storageKey: string | null;
	sha256: string | null;
	urlToken: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface InsertUploadSessionInput {
	id: string;
	appId: string;
	fileName?: string | null;
	fileType: string;
	fileLength: number;
	createdAt?: string;
}

/** Everything a chunk can move: the offset, and — on the last one — the handle and its bytes. */
export interface UpdateUploadSessionInput {
	receivedBytes?: number;
	handle?: string | null;
	storageKey?: string | null;
	sha256?: string | null;
	urlToken?: string | null;
	updatedAt?: string;
}

function toRecord(row: UploadSessionTable): UploadSessionRecord {
	return {
		id: row.id,
		appId: row.app_id,
		fileName: row.file_name,
		fileType: row.file_type,
		fileLength: row.file_length,
		receivedBytes: row.received_bytes,
		handle: row.handle,
		storageKey: row.storage_key,
		sha256: row.sha256,
		urlToken: row.url_token,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class UploadSessionRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertUploadSessionInput): Promise<UploadSessionRecord> {
		const now = input.createdAt ?? nowIso();
		const row = await this.#db
			.insertInto("upload_sessions")
			.values({
				id: input.id,
				app_id: input.appId,
				file_name: input.fileName ?? null,
				file_type: input.fileType,
				file_length: input.fileLength,
				received_bytes: 0,
				handle: null,
				storage_key: null,
				sha256: null,
				url_token: null,
				created_at: now,
				updated_at: now,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<UploadSessionRecord | null> {
		const row = await this.#db.selectFrom("upload_sessions").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** What a `header_handle` or a `profile_picture_handle` resolves through (SPEC §2.19, §2.7). */
	async findByHandle(handle: string): Promise<UploadSessionRecord | null> {
		const row = await this.#db
			.selectFrom("upload_sessions")
			.selectAll()
			.where("handle", "=", handle)
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** What `/whaloc-upload/:token` serves its bytes by (SPEC §2.22). */
	async findByUrlToken(urlToken: string): Promise<UploadSessionRecord | null> {
		const row = await this.#db
			.selectFrom("upload_sessions")
			.selectAll()
			.where("url_token", "=", urlToken)
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async update(id: string, input: UpdateUploadSessionInput): Promise<UploadSessionRecord | null> {
		const row = await this.#db
			.updateTable("upload_sessions")
			.set({
				...(input.receivedBytes !== undefined && { received_bytes: input.receivedBytes }),
				...(input.handle !== undefined && { handle: input.handle }),
				...(input.storageKey !== undefined && { storage_key: input.storageKey }),
				...(input.sha256 !== undefined && { sha256: input.sha256 }),
				...(input.urlToken !== undefined && { url_token: input.urlToken }),
				updated_at: input.updatedAt ?? nowIso(),
			})
			.where("id", "=", id)
			.returningAll()
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Every session, oldest first — what a reset deletes and what an export carries. */
	async listAll(): Promise<UploadSessionRecord[]> {
		const rows = await this.#db.selectFrom("upload_sessions").selectAll().orderBy("created_at").orderBy("id").execute();

		return rows.map(row => toRecord(row));
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("upload_sessions").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
