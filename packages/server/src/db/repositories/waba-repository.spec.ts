import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../create-database.ts";
import { runMigrations } from "../migrator.ts";
import { WabaRepository } from "./waba-repository.ts";

describe("WabaRepository", () => {
	let handle: DatabaseHandle;
	let repository: WabaRepository;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		repository = new WabaRepository(handle.db);
	});

	afterEach(async () => {
		await handle.close();
	});

	it("stores a WABA and reads it back", async () => {
		const inserted = await repository.insert({
			id: "102290129340398",
			name: "Acme",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		expect(inserted).toEqual({
			id: "102290129340398",
			name: "Acme",
			// Nothing is subscribed to a brand new WABA's webhooks (SPEC §2.20).
			subscribedAt: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		expect(await repository.findById("102290129340398")).toEqual(inserted);
	});

	it("stamps a row with the current time when none is given", async () => {
		const inserted = await repository.insert({ id: "1", name: "Acme" });

		expect(inserted.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
	});

	it("answers with null for an unknown id", async () => {
		expect(await repository.findById("404")).toBeNull();
	});

	it("rejects a duplicate id", async () => {
		await repository.insert({ id: "1", name: "Acme" });

		await expect(repository.insert({ id: "1", name: "Other" })).rejects.toThrow(/unique/i);
	});

	it("lists WABAs oldest first", async () => {
		await repository.insert({ id: "2", name: "Second", createdAt: "2026-01-02T00:00:00.000Z" });
		await repository.insert({ id: "1", name: "First", createdAt: "2026-01-01T00:00:00.000Z" });

		const wabas = await repository.list();

		expect(wabas.map(waba => waba.name)).toEqual(["First", "Second"]);
	});
});
