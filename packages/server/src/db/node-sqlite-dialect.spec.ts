import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "./create-database.ts";
import { runMigrations } from "./migrator.ts";

const WABA = { id: "1", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" };

describe("NodeSqliteDialect", () => {
	let handle: DatabaseHandle;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
	});

	afterEach(async () => {
		await handle.close();
	});

	it("reports how many rows a statement affected", async () => {
		await handle.db.insertInto("wabas").values(WABA).execute();

		const [updated] = await handle.db.updateTable("wabas").set({ name: "Other" }).execute();

		expect(updated?.numUpdatedRows).toBe(1n);

		const [deleted] = await handle.db.deleteFrom("wabas").execute();

		expect(deleted?.numDeletedRows).toBe(1n);
	});

	it("commits a transaction", async () => {
		await handle.db.transaction().execute(async trx => {
			await trx.insertInto("wabas").values(WABA).execute();
		});

		expect(await handle.db.selectFrom("wabas").selectAll().execute()).toHaveLength(1);
	});

	it("rolls a failed transaction back", async () => {
		await expect(
			handle.db.transaction().execute(async trx => {
				await trx.insertInto("wabas").values(WABA).execute();

				throw new Error("nope");
			}),
		).rejects.toThrow("nope");

		expect(await handle.db.selectFrom("wabas").selectAll().execute()).toEqual([]);
	});

	it("rolls part of a transaction back to a savepoint", async () => {
		const trx = await handle.db.startTransaction().execute();

		await trx.insertInto("wabas").values(WABA).execute();

		const afterFirst = await trx.savepoint("after_first").execute();

		await afterFirst
			.insertInto("wabas")
			.values({ ...WABA, id: "2" })
			.execute();

		const rolledBack = await afterFirst.rollbackToSavepoint("after_first").execute();

		await rolledBack.releaseSavepoint("after_first").execute();
		await trx.commit().execute();

		const rows = await handle.db.selectFrom("wabas").select("id").execute();

		expect(rows.map(row => row.id)).toEqual(["1"]);
	});

	it("streams a select query", async () => {
		await handle.db
			.insertInto("wabas")
			.values([WABA, { ...WABA, id: "2" }, { ...WABA, id: "3" }])
			.execute();

		const streamed: string[] = [];

		for await (const row of handle.db.selectFrom("wabas").select("id").orderBy("id").stream()) {
			streamed.push(row.id);
		}

		expect(streamed).toEqual(["1", "2", "3"]);
	});

	it("refuses to stream anything but a select", async () => {
		const stream = handle.db.insertInto("wabas").values(WABA).stream();

		await expect(stream.next()).rejects.toThrow(/stream select queries/);
	});

	it("binds booleans as the integers SQLite stores", async () => {
		const { rows } = await sql<{ flag: number }>`select ${true} as flag`.execute(handle.db);

		expect(rows[0]?.flag).toBe(1);
	});

	it("returns plain objects, not the null-prototype rows node:sqlite hands out", async () => {
		await handle.db.insertInto("wabas").values(WABA).execute();

		const row = await handle.db.selectFrom("wabas").selectAll().executeTakeFirstOrThrow();

		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
	});
});
