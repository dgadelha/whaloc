import type { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { createMigrationProvider } from "./migrations.ts";
import type { Database } from "./schema.ts";

export interface RunMigrationsOptions {
	db: Kysely<Database>;
}

export interface MigrationsResult {
	/** Names of the migrations this run applied — empty when the schema was already current. */
	applied: string[];
}

/**
 * Brings the schema up to date at boot (SPEC §6). Running it again is a no-op: the migrator
 * skips everything already recorded in `kysely_migration`.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationsResult> {
	const migrator = new Migrator({ db: options.db, provider: createMigrationProvider() });
	const { error, results } = await migrator.migrateToLatest();

	if (error !== undefined) {
		const failed = results?.find(result => result.status === "Error")?.migrationName;
		const context = failed === undefined ? "" : ` while running "${failed}"`;

		throw new Error(`database migration failed${context}`, { cause: error });
	}

	return { applied: (results ?? []).filter(result => result.status === "Success").map(result => result.migrationName) };
}
