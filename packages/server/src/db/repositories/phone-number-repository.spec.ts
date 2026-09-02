import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../create-database.ts";
import { runMigrations } from "../migrator.ts";
import { PhoneNumberRepository } from "./phone-number-repository.ts";
import { WabaRepository } from "./waba-repository.ts";

const WABA_ID = "102290129340398";

describe("PhoneNumberRepository", () => {
	let handle: DatabaseHandle;
	let repository: PhoneNumberRepository;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		const wabas = new WabaRepository(handle.db);

		await wabas.insert({ id: WABA_ID, name: "Acme" });
		repository = new PhoneNumberRepository(handle.db);
	});

	afterEach(async () => {
		await handle.close();
	});

	function insertDefault(overrides: { id?: string; displayPhoneNumber?: string } = {}) {
		return repository.insert({
			id: overrides.id ?? "15550000100",
			wabaId: WABA_ID,
			displayPhoneNumber: overrides.displayPhoneNumber ?? "+55 11 91234-5678",
			verifiedName: "Acme",
		});
	}

	it("defaults the quality rating, throughput level and lifecycle to a fully onboarded number", async () => {
		const inserted = await repository.insert({
			id: "15550000100",
			wabaId: WABA_ID,
			displayPhoneNumber: "+55 11 91234-5678",
			verifiedName: "Acme",
			createdAt: "2026-01-01T00:00:00.000Z",
		});

		expect(inserted).toEqual({
			id: "15550000100",
			wabaId: WABA_ID,
			displayPhoneNumber: "+55 11 91234-5678",
			verifiedName: "Acme",
			qualityRating: "GREEN",
			throughputLevel: "STANDARD",
			status: "CONNECTED",
			codeVerificationStatus: "VERIFIED",
			nameStatus: "APPROVED",
			pendingVerification: null,
			// A number publishes no business profile until one is posted (SPEC §2.19).
			businessProfile: {},
			createdAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("stores a number that still has to be verified", async () => {
		const inserted = await repository.insert({
			id: "15550000101",
			wabaId: WABA_ID,
			displayPhoneNumber: "+1 631-555-5555",
			verifiedName: "Acme",
			status: "UNVERIFIED",
			codeVerificationStatus: "NOT_VERIFIED",
			nameStatus: "PENDING_REVIEW",
		});

		expect(inserted).toMatchObject({
			status: "UNVERIFIED",
			codeVerificationStatus: "NOT_VERIFIED",
			nameStatus: "PENDING_REVIEW",
			pendingVerification: null,
		});
	});

	it("round-trips a pending verification, and clears it with null", async () => {
		const inserted = await insertDefault();
		const pending = { code: "123456", method: "SMS", language: "en_US" } as const;

		expect(await repository.update(inserted.id, { pendingVerification: pending })).toMatchObject({
			pendingVerification: pending,
		});
		expect(await repository.update(inserted.id, { pendingVerification: null })).toMatchObject({
			pendingVerification: null,
		});
	});

	it("deletes one number, and says whether there was one", async () => {
		const inserted = await insertDefault();

		expect(await repository.deleteById(inserted.id)).toBe(true);
		expect(await repository.deleteById(inserted.id)).toBe(false);
		expect(await repository.findById(inserted.id)).toBeNull();
	});

	it("finds a number by the display number it is seeded with", async () => {
		const inserted = await insertDefault();

		expect(await repository.findByDisplayPhoneNumber(WABA_ID, "+55 11 91234-5678")).toEqual(inserted);
		expect(await repository.findByDisplayPhoneNumber("999", "+55 11 91234-5678")).toBeNull();
	});

	it("refuses two numbers with the same display number in one WABA", async () => {
		await insertDefault();

		await expect(insertDefault({ id: "other" })).rejects.toThrow(/unique/i);
	});

	it("requires the WABA to exist", async () => {
		await expect(
			repository.insert({ id: "1", wabaId: "missing", displayPhoneNumber: "+1 555", verifiedName: "Acme" }),
		).rejects.toThrow(/foreign key/i);
	});

	it("updates quality and throughput without touching the rest", async () => {
		await insertDefault();

		expect(await repository.update("15550000100", { qualityRating: "RED", throughputLevel: "HIGH" })).toMatchObject({
			verifiedName: "Acme",
			qualityRating: "RED",
			throughputLevel: "HIGH",
		});
	});

	it("returns the untouched number when there is nothing to update", async () => {
		const inserted = await insertDefault();

		expect(await repository.update(inserted.id, {})).toEqual(inserted);
	});

	it("answers with null when updating an unknown number", async () => {
		expect(await repository.update("404", { qualityRating: "RED" })).toBeNull();
	});

	it("lists the numbers of one WABA", async () => {
		await insertDefault({ id: "1", displayPhoneNumber: "+1 555 000 0100" });
		await insertDefault({ id: "2", displayPhoneNumber: "+1 555 000 0200" });

		expect(await repository.listByWabaId(WABA_ID)).toHaveLength(2);
		expect(await repository.listByWabaId("999")).toEqual([]);
		expect(await repository.list()).toHaveLength(2);
	});
});
