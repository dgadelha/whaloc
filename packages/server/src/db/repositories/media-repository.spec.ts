import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../create-database.ts";
import { runMigrations } from "../migrator.ts";
import { MediaRepository, type InsertMediaInput } from "./media-repository.ts";
import { PhoneNumberRepository } from "./phone-number-repository.ts";
import { WabaRepository } from "./waba-repository.ts";

const WABA_ID = "102290129340398";
const PHONE_NUMBER_ID = "15550000100";

describe("MediaRepository", () => {
	let handle: DatabaseHandle;
	let repository: MediaRepository;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		const wabas = new WabaRepository(handle.db);

		await wabas.insert({ id: WABA_ID, name: "Acme" });
		const phoneNumbers = new PhoneNumberRepository(handle.db);

		await phoneNumbers.insert({
			id: PHONE_NUMBER_ID,
			wabaId: WABA_ID,
			displayPhoneNumber: "+55 11 91234-5678",
			verifiedName: "Acme",
		});
		repository = new MediaRepository(handle.db);
	});

	afterEach(async () => {
		await handle.close();
	});

	function insertDefault(overrides: Partial<InsertMediaInput> = {}) {
		return repository.insert({
			id: "1234567890123456",
			phoneNumberId: PHONE_NUMBER_ID,
			mimeType: "image/jpeg",
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			fileSize: 2048,
			storageKey: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
			urlToken: "GgUqL2sJZ8kTn3pQwXyZ0A",
			...overrides,
		});
	}

	it("stores the metadata of an upload", async () => {
		const inserted = await insertDefault({ createdAt: "2026-01-01T00:00:00.000Z" });

		expect(inserted).toEqual({
			id: "1234567890123456",
			phoneNumberId: PHONE_NUMBER_ID,
			mimeType: "image/jpeg",
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			fileSize: 2048,
			storageKey: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
			urlToken: "GgUqL2sJZ8kTn3pQwXyZ0A",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("keeps the file size a number", async () => {
		const inserted = await insertDefault({ fileSize: 104_857_600 });

		const found = await repository.findById(inserted.id);

		expect(found?.fileSize).toBe(104_857_600);
	});

	it("resolves the public URL token", async () => {
		const inserted = await insertDefault();

		expect(await repository.findByUrlToken("GgUqL2sJZ8kTn3pQwXyZ0A")).toEqual(inserted);
		expect(await repository.findByUrlToken("nope")).toBeNull();
	});

	it("refuses to reuse a URL token", async () => {
		await insertDefault();

		await expect(insertDefault({ id: "9999999999999999" })).rejects.toThrow(/unique/i);
	});

	it("requires the phone number to exist", async () => {
		await expect(insertDefault({ phoneNumberId: "missing" })).rejects.toThrow(/foreign key/i);
	});

	it("lists the media of one phone number and deletes by id", async () => {
		await insertDefault({ id: "1", urlToken: "token-1" });
		await insertDefault({ id: "2", urlToken: "token-2" });

		expect(await repository.listByPhoneNumberId(PHONE_NUMBER_ID)).toHaveLength(2);
		expect(await repository.deleteById("1")).toBe(true);
		expect(await repository.deleteById("1")).toBe(false);
		expect(await repository.listByPhoneNumberId(PHONE_NUMBER_ID)).toHaveLength(1);
	});
});
