import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "./create-database.ts";
import { MIGRATIONS } from "./migrations.ts";
import { runMigrations } from "./migrator.ts";

const TABLES = [
	"contacts",
	"expired_tokens",
	"injection_rules",
	"media",
	"messages",
	"phone_numbers",
	"templates",
	"upload_sessions",
	"wabas",
	"webhook_deliveries",
];

describe("runMigrations", () => {
	let handle: DatabaseHandle | undefined;

	function openDatabase(dbPath = ":memory:"): DatabaseHandle {
		handle = createDatabase({ dbPath });

		return handle;
	}

	afterEach(async () => {
		await handle?.close();
		handle = undefined;
	});

	it("creates every table the data model describes", async () => {
		const { db } = openDatabase();

		await runMigrations({ db });

		const tables = await db.introspection.getTables();

		expect(tables.map(table => table.name).toSorted((left, right) => left.localeCompare(right))).toEqual(TABLES);
	});

	it("reports the migrations it applied", async () => {
		const { db } = openDatabase();

		expect(await runMigrations({ db })).toEqual({ applied: Object.keys(MIGRATIONS) });
	});

	it("is a no-op when the schema is already current", async () => {
		const { db } = openDatabase();

		await runMigrations({ db });

		expect(await runMigrations({ db })).toEqual({ applied: [] });
	});

	/**
	 * The compatibility contract of `0002_phone_number_lifecycle`: a database that predates the
	 * registration ladder comes up with its numbers fully onboarded, so the send gate stays open
	 * for everything a consumer had configured (SPEC §4).
	 */
	it("brings a pre-lifecycle phone number up as CONNECTED and VERIFIED", async () => {
		const { db } = openDatabase();
		const first = Object.keys(MIGRATIONS)[0]!;
		const migrator = new Migrator({
			db,
			provider: { getMigrations: () => Promise.resolve({ [first]: MIGRATIONS[first]! }) },
		});

		await migrator.migrateToLatest();
		await db.insertInto("wabas").values({ id: "1", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" }).execute();

		// Raw SQL on purpose: this is the row shape of the *old* schema, which the current
		// `Database` type cannot express (its lifecycle columns are not nullable).
		await sql`insert into phone_numbers
			(id, waba_id, display_phone_number, verified_name, quality_rating, throughput_level, created_at)
			values ('2', '1', '+55 11 91234-5678', 'Acme', 'GREEN', 'STANDARD', '2026-01-01T00:00:00.000Z')`.execute(db);

		expect(await runMigrations({ db })).toEqual({ applied: Object.keys(MIGRATIONS).slice(1) });

		const row = await db.selectFrom("phone_numbers").selectAll().executeTakeFirstOrThrow();

		expect(row).toMatchObject({
			status: "CONNECTED",
			code_verification_status: "VERIFIED",
			name_status: "APPROVED",
			verification_code: null,
			verification_code_method: null,
			verification_code_language: null,
			// `0003_business_profile_and_subscribed_apps`: an old row comes up publishing nothing
			// (SPEC §2.19) with no app subscribed (SPEC §2.20), which needs no backfill.
			business_profile: "{}",
		});
		expect(await db.selectFrom("wabas").selectAll().executeTakeFirstOrThrow()).toMatchObject({ subscribed_at: null });
	});

	it("leaves a persisted database untouched on the next boot", async ({ onTestFinished }) => {
		const directory = await mkdtemp(path.join(tmpdir(), "whaloc-migrator-"));

		onTestFinished(async () => {
			await rm(directory, { recursive: true, force: true });
		});

		const dbPath = path.join(directory, "whaloc.db");
		const first = openDatabase(dbPath);

		await runMigrations({ db: first.db });
		await first.db
			.insertInto("wabas")
			.values({ id: "1", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" })
			.execute();
		await first.close();

		const second = openDatabase(dbPath);

		expect(await runMigrations({ db: second.db })).toEqual({ applied: [] });
		expect(await second.db.selectFrom("wabas").selectAll().execute()).toHaveLength(1);
	});
});
