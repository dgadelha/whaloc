import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../create-database.ts";
import { runMigrations } from "../migrator.ts";
import { ContactRepository } from "./contact-repository.ts";
import { createRepositories, type Repositories } from "./index.ts";

describe("ContactRepository", () => {
	let handle: DatabaseHandle;
	let repository: ContactRepository;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		repository = new ContactRepository(handle.db);
	});

	afterEach(async () => {
		await handle.close();
	});

	it("stores a contact and reads it back", async () => {
		const inserted = await repository.insert({ waId: "5571990000001", profileName: "Ana Souza" });

		expect(inserted).toMatchObject({ waId: "5571990000001", profileName: "Ana Souza", userId: null });
		expect(inserted.createdAt).toBe(inserted.updatedAt);
		expect(await repository.findByWaId("5571990000001")).toEqual(inserted);
	});

	it("rejects a second contact with the same wa_id", async () => {
		await repository.insert({ waId: "5571990000001", profileName: "Ana" });

		await expect(repository.insert({ waId: "5571990000001", profileName: "Ana again" })).rejects.toThrow(/unique/i);
	});

	it("renames a contact and moves its updated timestamp", async () => {
		await repository.insert({ waId: "1", profileName: "Ana", createdAt: "2026-01-01T00:00:00.000Z" });

		const renamed = await repository.update("1", {
			profileName: "Ana Souza",
			updatedAt: "2026-01-02T00:00:00.000Z",
		});

		expect(renamed).toMatchObject({
			profileName: "Ana Souza",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
	});

	it("answers with null for an unknown contact", async () => {
		expect(await repository.findByWaId("404")).toBeNull();
		expect(await repository.update("404", { profileName: "Nobody" })).toBeNull();
	});

	it("lists contacts oldest first", async () => {
		await repository.insert({ waId: "2", profileName: "Bruno", createdAt: "2026-01-02T00:00:00.000Z" });
		await repository.insert({ waId: "1", profileName: "Ana", createdAt: "2026-01-01T00:00:00.000Z" });

		const contacts = await repository.list();

		expect(contacts.map(contact => contact.profileName)).toEqual(["Ana", "Bruno"]);
	});

	describe("business-scoped user ids (SPEC §1.15)", () => {
		it("stores one and looks the contact up by it", async () => {
			const inserted = await repository.insert({ waId: "1", profileName: "Ana", userId: "BR.ENT.4KgQ2wJ8" });

			expect(inserted.userId).toBe("BR.ENT.4KgQ2wJ8");
			expect(await repository.findByUserId("BR.ENT.4KgQ2wJ8")).toEqual(inserted);
			expect(await repository.findByUserId("BR.ENT.nobody")).toBeNull();
		});

		it("keeps them unique, but lets every contact go without one", async () => {
			await repository.insert({ waId: "1", profileName: "Ana", userId: "BR.ENT.4KgQ2wJ8" });
			await repository.insert({ waId: "2", profileName: "Bruno" });
			await repository.insert({ waId: "3", profileName: "Carla" });

			await expect(repository.insert({ waId: "4", profileName: "Dora", userId: "BR.ENT.4KgQ2wJ8" })).rejects.toThrow(
				/unique/i,
			);
		});

		it("sets and clears one on an existing contact", async () => {
			await repository.insert({ waId: "1", profileName: "Ana" });

			expect(await repository.update("1", { userId: "US.4KgQ2wJ8" })).toMatchObject({ userId: "US.4KgQ2wJ8" });
			expect(await repository.update("1", { userId: null })).toMatchObject({ userId: null });
		});

		it("leaves the BSUID alone when only the profile name changes", async () => {
			await repository.insert({ waId: "1", profileName: "Ana", userId: "US.4KgQ2wJ8" });

			expect(await repository.update("1", { profileName: "Ana Souza" })).toMatchObject({
				profileName: "Ana Souza",
				userId: "US.4KgQ2wJ8",
			});
		});
	});

	/** The row behind `user_changed_number` (SPEC §5): the person moves, the history follows. */
	describe("changeWaId", () => {
		let repositories: Repositories;

		beforeEach(async () => {
			repositories = createRepositories(handle.db);

			await repositories.wabas.insert({ id: "10", name: "Acme" });
			await repositories.phoneNumbers.insert({
				id: "20",
				wabaId: "10",
				displayPhoneNumber: "+55 11 91234-5678",
				verifiedName: "Acme",
			});
		});

		async function insertMessage(id: string, contactWaId: string): Promise<void> {
			await repositories.messages.insert({
				id,
				direction: "inbound",
				phoneNumberId: "20",
				contactWaId,
				type: "text",
				payload: { text: { body: "hi" } },
			});
		}

		it("moves the contact, its BSUID and its messages to the new number", async () => {
			await repository.insert({
				waId: "16505551234",
				profileName: "Sheena Nelson",
				userId: "US.13491208655302741918",
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			await insertMessage("wamid.one", "16505551234");
			await insertMessage("wamid.two", "16505551234");

			const moved = await repository.changeWaId("16505551234", "12195555358", "2026-01-02T00:00:00.000Z");

			expect(moved).toEqual({
				waId: "12195555358",
				profileName: "Sheena Nelson",
				userId: "US.13491208655302741918",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
			});
			expect(await repository.findByWaId("16505551234")).toBeNull();
			expect(await repository.findByUserId("US.13491208655302741918")).toEqual(moved);
			expect(
				await repositories.messages.listConversation({ phoneNumberId: "20", contactWaId: "12195555358" }),
			).toHaveLength(2);
			// The wamids do not change, so a reaction or a read receipt naming an old message
			// still finds it (SPEC §5).
			expect(await repositories.messages.findById("wamid.one")).toMatchObject({ contactWaId: "12195555358" });
		});

		it("answers with null for an unknown contact", async () => {
			expect(await repository.changeWaId("404", "12195555358")).toBeNull();
		});

		it("rolls the whole move back when the new number is taken", async () => {
			await repository.insert({ waId: "1", profileName: "Ana", userId: "BR.ENT.4KgQ2wJ8" });
			await repository.insert({ waId: "2", profileName: "Bruno" });
			await insertMessage("wamid.one", "1");

			await expect(repository.changeWaId("1", "2")).rejects.toThrow(/unique/i);

			expect(await repository.findByWaId("1")).toMatchObject({ userId: "BR.ENT.4KgQ2wJ8" });
			expect(await repositories.messages.findById("wamid.one")).toMatchObject({ contactWaId: "1" });
		});
	});
});
