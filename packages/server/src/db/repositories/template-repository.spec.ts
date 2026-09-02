import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../create-database.ts";
import { JsonColumnError } from "../json-column.ts";
import { runMigrations } from "../migrator.ts";
import { TemplateRepository, type InsertTemplateInput } from "./template-repository.ts";
import { WabaRepository } from "./waba-repository.ts";

const WABA_ID = "102290129340398";

const COMPONENTS = [
	{ type: "HEADER", format: "TEXT", text: "Olá {{1}}" },
	{ type: "BODY", text: "Seu pedido {{1}} está a caminho", example: { body_text: [["123"]] } },
];

describe("TemplateRepository", () => {
	let handle: DatabaseHandle;
	let repository: TemplateRepository;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		const wabas = new WabaRepository(handle.db);

		await wabas.insert({ id: WABA_ID, name: "Acme" });
		repository = new TemplateRepository(handle.db);
	});

	afterEach(async () => {
		await handle.close();
	});

	function insertDefault(overrides: Partial<InsertTemplateInput> = {}) {
		return repository.insert({
			id: "944444444444444",
			wabaId: WABA_ID,
			name: "order_update",
			language: "pt_BR",
			category: "UTILITY",
			components: COMPONENTS,
			...overrides,
		});
	}

	it("stores a template as PENDING with positional parameters", async () => {
		const inserted = await insertDefault({ createdAt: "2026-01-01T00:00:00.000Z" });

		expect(inserted).toEqual({
			id: "944444444444444",
			wabaId: WABA_ID,
			name: "order_update",
			language: "pt_BR",
			category: "UTILITY",
			parameterFormat: "POSITIONAL",
			components: COMPONENTS,
			status: "PENDING",
			rejectedReason: null,
			qualityScore: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("round-trips the components through the JSON column", async () => {
		await insertDefault();

		const found = await repository.findById("944444444444444");

		expect(found?.components).toEqual(COMPONENTS);
		expect(found?.components).not.toBe(COMPONENTS);
	});

	it("fails loudly when a JSON column does not hold what it promises", async () => {
		await insertDefault();
		await handle.db.updateTable("templates").set({ components: "{oops" }).execute();

		await expect(repository.findById("944444444444444")).rejects.toThrow(JsonColumnError);
	});

	it("refuses a duplicate name + language in one WABA", async () => {
		await insertDefault();

		await expect(insertDefault({ id: "944444444444445" })).rejects.toThrow(/unique/i);
	});

	it("allows the same name in another language", async () => {
		await insertDefault();

		expect(await insertDefault({ id: "944444444444445", language: "en_US" })).toMatchObject({ language: "en_US" });
	});

	it("finds a template by name and language, and every language of a name", async () => {
		await insertDefault();
		await insertDefault({ id: "944444444444445", language: "en_US" });

		expect(await repository.findByNameAndLanguage(WABA_ID, "order_update", "pt_BR")).toMatchObject({
			id: "944444444444444",
		});
		expect(await repository.findByNameAndLanguage(WABA_ID, "order_update", "es_ES")).toBeNull();
		const languages = await repository.findByName(WABA_ID, "order_update");

		expect(languages.map(template => template.language)).toEqual(["en_US", "pt_BR"]);
	});

	it("applies an edit and keeps the untouched columns", async () => {
		await insertDefault();

		const updated = await repository.update("944444444444444", {
			status: "REJECTED",
			rejectedReason: "INCORRECT_CATEGORY",
			components: [{ type: "BODY", text: "Novo" }],
			updatedAt: "2026-02-02T00:00:00.000Z",
		});

		expect(updated).toMatchObject({
			name: "order_update",
			status: "REJECTED",
			rejectedReason: "INCORRECT_CATEGORY",
			components: [{ type: "BODY", text: "Novo" }],
			updatedAt: "2026-02-02T00:00:00.000Z",
		});
	});

	it("answers with null when updating an unknown template", async () => {
		expect(await repository.update("404", { status: "APPROVED" })).toBeNull();
	});

	it("deletes by id and by name across languages", async () => {
		await insertDefault();
		await insertDefault({ id: "944444444444445", language: "en_US" });

		expect(await repository.deleteById("944444444444444")).toBe(true);
		expect(await repository.deleteById("944444444444444")).toBe(false);

		await insertDefault();

		expect(await repository.deleteByName(WABA_ID, "order_update")).toBe(2);
		expect(await repository.deleteByName(WABA_ID, "order_update")).toBe(0);
	});

	it("pages through templates with a keyset cursor", async () => {
		for (const [index, language] of ["pt_BR", "en_US", "es_ES"].entries()) {
			await insertDefault({
				id: `94444444444444${String(index)}`,
				language,
				createdAt: `2026-01-0${String(index + 1)}T00:00:00.000Z`,
			});
		}

		const firstPage = await repository.list({ wabaId: WABA_ID, limit: 2 });

		expect(firstPage.map(template => template.language)).toEqual(["pt_BR", "en_US"]);

		const secondPage = await repository.list({ wabaId: WABA_ID, limit: 2, afterId: firstPage[1]!.id });

		expect(secondPage.map(template => template.language)).toEqual(["es_ES"]);
		expect(await repository.list({ wabaId: WABA_ID, limit: 2, afterId: secondPage[0]!.id })).toEqual([]);
	});
});
