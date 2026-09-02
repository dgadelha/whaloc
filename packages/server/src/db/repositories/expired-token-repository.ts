import type { Kysely } from "kysely";
import { nowIso } from "../../timestamps.ts";
import type { Database } from "../schema.ts";

/**
 * Which registered bearer tokens are currently expired (SPEC §1.9).
 *
 * The registry itself is `WHALOC_TOKENS`; this table only remembers the ones the control plane
 * invalidated, keyed by the token's derived id so no credential is ever written to disk. A token
 * with no row here is valid.
 */
export class ExpiredTokenRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	/** When the token was marked expired, or `null` while it is valid. */
	async findExpiredAt(tokenId: string): Promise<string | null> {
		const row = await this.#db
			.selectFrom("expired_tokens")
			.select("expired_at")
			.where("token_id", "=", tokenId)
			.executeTakeFirst();

		return row?.expired_at ?? null;
	}

	async listExpired(): Promise<Map<string, string>> {
		const rows = await this.#db.selectFrom("expired_tokens").selectAll().execute();

		return new Map(rows.map(row => [row.token_id, row.expired_at]));
	}

	/** Idempotent: expiring an already-expired token keeps the moment it first expired. */
	async expire(tokenId: string, expiredAt: string = nowIso()): Promise<string> {
		const existing = await this.findExpiredAt(tokenId);

		if (existing !== null) {
			return existing;
		}

		await this.#db.insertInto("expired_tokens").values({ token_id: tokenId, expired_at: expiredAt }).execute();

		return expiredAt;
	}

	/** Idempotent: restoring a valid token does nothing. */
	async restore(tokenId: string): Promise<boolean> {
		const result = await this.#db.deleteFrom("expired_tokens").where("token_id", "=", tokenId).executeTakeFirst();

		return Number(result.numDeletedRows) > 0;
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("expired_tokens").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
