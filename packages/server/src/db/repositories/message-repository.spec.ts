import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../create-database.ts";
import { runMigrations } from "../migrator.ts";
import { ContactRepository } from "./contact-repository.ts";
import { MessageRepository, type InsertMessageInput } from "./message-repository.ts";
import { PhoneNumberRepository } from "./phone-number-repository.ts";
import { WabaRepository } from "./waba-repository.ts";

const WABA_ID = "102290129340398";
const PHONE_NUMBER_ID = "15550000100";
const CONTACT_WA_ID = "5511912345678";
const WAMID = "wamid.HBgNNTUxMTkxMjM0NTY3OBUCABEYEjYzNEQzNzJFQjhDMkNENzU5OQA=";

describe("MessageRepository", () => {
	let handle: DatabaseHandle;
	let repository: MessageRepository;
	let contacts: ContactRepository;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });

		const wabas = new WabaRepository(handle.db);
		const phoneNumbers = new PhoneNumberRepository(handle.db);

		contacts = new ContactRepository(handle.db);
		repository = new MessageRepository(handle.db);

		await wabas.insert({ id: WABA_ID, name: "Acme" });
		await phoneNumbers.insert({
			id: PHONE_NUMBER_ID,
			wabaId: WABA_ID,
			displayPhoneNumber: "+55 11 91234-5678",
			verifiedName: "Acme",
		});
		await contacts.insert({ waId: CONTACT_WA_ID, profileName: "Ana" });
	});

	afterEach(async () => {
		await handle.close();
	});

	function insertDefault(overrides: Partial<InsertMessageInput> = {}) {
		return repository.insert({
			id: WAMID,
			direction: "outbound",
			phoneNumberId: PHONE_NUMBER_ID,
			contactWaId: CONTACT_WA_ID,
			type: "text",
			payload: { text: { body: "olá" } },
			...overrides,
		});
	}

	it("stores an outbound message as accepted", async () => {
		const inserted = await insertDefault({ createdAt: "2026-01-01T00:00:00.000Z" });

		expect(inserted).toEqual({
			id: WAMID,
			direction: "outbound",
			phoneNumberId: PHONE_NUMBER_ID,
			contactWaId: CONTACT_WA_ID,
			type: "text",
			payload: { text: { body: "olá" } },
			status: "accepted",
			error: null,
			bizOpaqueCallbackData: null,
			replyTo: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("round-trips a nested payload through the JSON column", async () => {
		const payload = {
			image: { id: "1234567890", mime_type: "image/jpeg", caption: "olá 🌍" },
			context: { message_id: "wamid.previous" },
		};

		await insertDefault({ payload });

		const found = await repository.findById(WAMID);

		expect(found?.payload).toEqual(payload);
	});

	it("defaults the message timestamp to its creation time", async () => {
		const message = await insertDefault({ createdAt: "2026-01-01T00:00:00.000Z" });

		expect(message.timestamp).toBe("2026-01-01T00:00:00.000Z");
	});

	it("rejects a duplicate wamid", async () => {
		await insertDefault();

		await expect(insertDefault()).rejects.toThrow(/unique/i);
	});

	it("requires the phone number and the contact to exist", async () => {
		await expect(insertDefault({ phoneNumberId: "missing" })).rejects.toThrow(/foreign key/i);
		await expect(insertDefault({ contactWaId: "missing" })).rejects.toThrow(/foreign key/i);
	});

	it("advances a message along the status ladder", async () => {
		await insertDefault();

		expect(await repository.updateStatus(WAMID, { status: "delivered" })).toMatchObject({
			status: "delivered",
			error: null,
		});
	});

	it("stores the Meta error node of a failed message", async () => {
		await insertDefault();

		const error = {
			code: 131_049,
			title: "This message was not delivered to maintain healthy ecosystem engagement.",
			error_data: { details: "..." },
		};

		expect(await repository.updateStatus(WAMID, { status: "failed", error })).toMatchObject({
			status: "failed",
			error,
		});
		expect(await repository.updateStatus(WAMID, { status: "delivered", error: null })).toMatchObject({ error: null });
	});

	it("answers with null for unknown messages", async () => {
		expect(await repository.findById("wamid.nope")).toBeNull();
		expect(await repository.updateStatus("wamid.nope", { status: "read" })).toBeNull();
	});

	it("lists a conversation newest last", async () => {
		for (const index of [1, 2, 3]) {
			await insertDefault({
				id: `wamid.${String(index)}`,
				timestamp: `2026-01-0${String(index)}T00:00:00.000Z`,
			});
		}

		const conversation = await repository.listConversation({
			phoneNumberId: PHONE_NUMBER_ID,
			contactWaId: CONTACT_WA_ID,
		});

		expect(conversation.map(message => message.id)).toEqual(["wamid.1", "wamid.2", "wamid.3"]);
	});

	it("takes the newest page and pages backwards with a before cursor", async () => {
		for (const index of [1, 2, 3]) {
			await insertDefault({
				id: `wamid.${String(index)}`,
				timestamp: `2026-01-0${String(index)}T00:00:00.000Z`,
			});
		}

		const query = { phoneNumberId: PHONE_NUMBER_ID, contactWaId: CONTACT_WA_ID, limit: 2 };
		const newest = await repository.listConversation(query);

		expect(newest.map(message => message.id)).toEqual(["wamid.2", "wamid.3"]);

		const older = await repository.listConversation({ ...query, before: newest[0]!.timestamp });

		expect(older.map(message => message.id)).toEqual(["wamid.1"]);
	});

	it("keeps conversations of different contacts apart", async () => {
		await contacts.insert({ waId: "5571990000002", profileName: "Bruno" });
		await insertDefault({ id: "wamid.ana" });
		await insertDefault({ id: "wamid.bruno", contactWaId: "5571990000002" });

		const conversation = await repository.listConversation({
			phoneNumberId: PHONE_NUMBER_ID,
			contactWaId: CONTACT_WA_ID,
		});

		expect(conversation.map(message => message.id)).toEqual(["wamid.ana"]);
	});
});
