import { Kysely } from "kysely";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDialect } from "./node-sqlite-dialect.ts";
import type { Database } from "./schema.ts";

/** `:memory:` keeps everything in RAM; any other value is a file path (SPEC §7). */
export const IN_MEMORY_DB_PATH = ":memory:";

export interface CreateDatabaseOptions {
	/** `WHALOC_DB_PATH`. */
	dbPath: string;
}

export interface DatabaseHandle {
	db: Kysely<Database>;
	/** Closes the underlying `DatabaseSync`; the handle is unusable afterwards. */
	close: () => Promise<void>;
}

/**
 * Opens the SQLite database behind a typed Kysely instance. The file (or its `:memory:`
 * stand-in) is the only state whaloc keeps besides the media bytes, and the directory it
 * lives in must already exist — the Docker image mounts `/data` as a volume.
 */
export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
	const database = new DatabaseSync(options.dbPath);

	// Foreign keys are on by default in `node:sqlite`, but say so explicitly: the schema
	// relies on them. WAL only makes sense (and only works) for a file-backed database.
	database.exec("pragma foreign_keys = on");

	if (options.dbPath !== IN_MEMORY_DB_PATH) {
		database.exec("pragma journal_mode = wal");
		database.exec("pragma busy_timeout = 5000");
	}

	const db = new Kysely<Database>({ dialect: new NodeSqliteDialect({ database }) });

	return {
		db,
		close: async () => {
			await db.destroy();
		},
	};
}
