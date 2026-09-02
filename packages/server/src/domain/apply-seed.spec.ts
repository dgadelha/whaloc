import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SEED, type Seed, type SeedTemplate } from "../config/index.ts";
import {
	createDatabase,
	createRepositories,
	runMigrations,
	type DatabaseHandle,
	type Repositories,
} from "../db/index.ts";
import { stringMatching } from "../testing/expectations.ts";
import { applySeed } from "./apply-seed.ts";
import { META_ID_PATTERN } from "./ids.ts";
import { templatePlaceholders } from "./template-placeholders.ts";

const CUSTOM_SEED: Seed = [
	{
		id: "102290129340398",
		name: "Acme",
		phoneNumbers: [{ id: "15550000100", displayPhoneNumber: "+1 555 000 0100", qualityRating: "YELLOW" }],
		contacts: [{ waId: "15550000101", name: "Jane" }],
		templates: [],
	},
];

describe("applySeed", () => {
	let handle: DatabaseHandle;
	let repositories: Repositories;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		repositories = createRepositories(handle.db);
	});

	afterEach(async () => {
		await handle.close();
	});

	async function countRows(): Promise<{
		wabas: number;
		phoneNumbers: number;
		contacts: number;
		templates: number;
	}> {
		const wabas = await repositories.wabas.list();
		const phoneNumbers = await repositories.phoneNumbers.list();
		const contacts = await repositories.contacts.list();
		const templates = await repositories.templates.listAll();

		return {
			wabas: wabas.length,
			phoneNumbers: phoneNumbers.length,
			contacts: contacts.length,
			templates: templates.length,
		};
	}

	it("applies the built-in seed", async () => {
		const result = await applySeed({ repositories, seed: DEFAULT_SEED });

		expect(result.created).toEqual({ wabas: 1, phoneNumbers: 1, contacts: 2, templates: 1 });
		expect(await countRows()).toEqual({ wabas: 1, phoneNumbers: 1, contacts: 2, templates: 1 });
	});

	it("reports the ids it resolved so they can be logged", async () => {
		const result = await applySeed({ repositories, seed: DEFAULT_SEED });
		const [waba] = result.wabas;

		expect(waba?.id).toMatch(META_ID_PATTERN);
		expect(waba?.name).toBe("whaloc Test Business");
		expect(waba?.phoneNumbers[0]?.id).toMatch(META_ID_PATTERN);
		expect(waba?.phoneNumbers[0]).toMatchObject({
			displayPhoneNumber: "+55 11 91234-5678",
			verifiedName: "whaloc Test Business",
		});
		expect(waba?.contacts).toEqual([
			{ waId: "5571990000001", profileName: "Ana Souza", userId: "BR.ENT.AnaSouza01" },
			{ waId: "5571990000002", profileName: "Bruno Lima", userId: "BR.BrunoLima01" },
		]);
		expect(waba?.templates).toEqual([{ id: stringMatching(META_ID_PATTERN), name: "hello_whaloc", language: "en" }]);
	});

	/**
	 * The derived ids of the built-in seed are a published contract: downstream compose seeds pin
	 * them (docs/integrating.md), so a change to a natural key here has to be a deliberate,
	 * documented one rather than a surprise at the consumer's next send.
	 */
	it("derives the ids the default seed's consumers hardcode", async () => {
		const result = await applySeed({ repositories, seed: DEFAULT_SEED });

		expect(result.wabas[0]).toMatchObject({
			id: "666635535888644",
			phoneNumbers: [{ id: "573542517421694" }],
			contacts: [{ waId: "5571990000001" }, { waId: "5571990000002" }],
			templates: [{ id: "355867425910125" }],
		});
	});

	it("seeds the default template APPROVED, ready to send", async () => {
		await applySeed({ repositories, seed: DEFAULT_SEED });

		const template = await repositories.templates.findById("355867425910125");

		expect(template).toMatchObject({
			wabaId: "666635535888644",
			name: "hello_whaloc",
			language: "en",
			category: "UTILITY",
			parameterFormat: "NAMED",
			status: "APPROVED",
			rejectedReason: null,
		});
		// Zero parameters, so `{name, language}` is a complete send (SPEC §2.5).
		expect(templatePlaceholders(template?.components ?? [])).toEqual({ header: [], body: [] });
	});

	it("keeps the ids given in the seed", async () => {
		const result = await applySeed({ repositories, seed: CUSTOM_SEED });
		const phoneNumber = await repositories.phoneNumbers.findById("15550000100");

		expect(result.wabas[0]).toMatchObject({
			id: "102290129340398",
			phoneNumbers: [{ id: "15550000100" }],
		});
		expect(phoneNumber?.qualityRating).toBe("YELLOW");
	});

	it("derives the same ids on every run of the same seed", async () => {
		const first = await applySeed({ repositories, seed: DEFAULT_SEED });

		const other = createDatabase({ dbPath: ":memory:" });

		try {
			await runMigrations({ db: other.db });

			const second = await applySeed({ repositories: createRepositories(other.db), seed: DEFAULT_SEED });

			expect(second.wabas).toEqual(first.wabas);
		} finally {
			await other.close();
		}
	});

	it("derives different ids for different businesses", async () => {
		const seed: Seed = [
			{ name: "Acme", phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100" }], contacts: [], templates: [] },
			{ name: "Other", phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0200" }], contacts: [], templates: [] },
		];

		const result = await applySeed({ repositories, seed });
		const [first, second] = result.wabas;

		expect(first?.id).not.toBe(second?.id);
		expect(first?.phoneNumbers[0]?.id).not.toBe(second?.phoneNumbers[0]?.id);
	});

	it("derives a template id per WABA and per language, the way phone numbers derive theirs", async () => {
		const template = {
			name: "order_update",
			category: "UTILITY",
			parameterFormat: "NAMED",
			components: [{ type: "BODY", text: "Hi" }],
		} satisfies Omit<SeedTemplate, "language">;
		const seed: Seed = [
			{
				name: "Acme",
				phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100" }],
				contacts: [],
				templates: [
					{ ...template, language: "en" },
					{ ...template, language: "pt_BR" },
				],
			},
			{
				name: "Other",
				phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0200" }],
				contacts: [],
				templates: [{ ...template, language: "en" }],
			},
		];

		const result = await applySeed({ repositories, seed });
		const ids = result.wabas.flatMap(waba => waba.templates.map(seeded => seeded.id));
		const distinct = new Set(ids);

		expect(distinct.size).toBe(3);
		expect(ids.every(id => META_ID_PATTERN.test(id))).toBe(true);
	});

	it("inserts nothing on a second run against the same database", async () => {
		const first = await applySeed({ repositories, seed: DEFAULT_SEED });
		const second = await applySeed({ repositories, seed: DEFAULT_SEED });

		expect(second.created).toEqual({ wabas: 0, phoneNumbers: 0, contacts: 0, templates: 0 });
		expect(second.wabas).toEqual(first.wabas);
		expect(await countRows()).toEqual({ wabas: 1, phoneNumbers: 1, contacts: 2, templates: 1 });
	});

	it("matches an existing template by name and language, whatever id the seed asks for", async () => {
		await applySeed({ repositories, seed: DEFAULT_SEED });

		const renumbered: Seed = [{ ...DEFAULT_SEED[0]!, templates: [{ ...DEFAULT_SEED[0]!.templates[0]!, id: "999" }] }];
		const result = await applySeed({ repositories, seed: renumbered });

		expect(result.created.templates).toBe(0);
		expect(result.wabas[0]?.templates[0]?.id).toBe("355867425910125");
		expect(await countRows()).toMatchObject({ templates: 1 });
	});

	it("leaves a moderated template alone", async () => {
		await applySeed({ repositories, seed: DEFAULT_SEED });
		await repositories.templates.update("355867425910125", { status: "PAUSED", qualityScore: "RED" });

		await applySeed({ repositories, seed: DEFAULT_SEED });

		expect(await repositories.templates.findById("355867425910125")).toMatchObject({
			status: "PAUSED",
			qualityScore: "RED",
		});
	});

	it("matches an existing phone number by its display number, whatever id the seed asks for", async () => {
		await applySeed({ repositories, seed: CUSTOM_SEED });

		const renumbered: Seed = [
			{ ...CUSTOM_SEED[0]!, phoneNumbers: [{ id: "999", displayPhoneNumber: "+1 555 000 0100" }] },
		];
		const result = await applySeed({ repositories, seed: renumbered });

		expect(result.created.phoneNumbers).toBe(0);
		expect(result.wabas[0]?.phoneNumbers[0]?.id).toBe("15550000100");
		expect(await countRows()).toMatchObject({ phoneNumbers: 1 });
	});

	it("leaves state the user changed alone", async () => {
		await applySeed({ repositories, seed: CUSTOM_SEED });
		await repositories.contacts.update("15550000101", { profileName: "Jane Doe" });
		await repositories.phoneNumbers.update("15550000100", { qualityRating: "RED" });

		await applySeed({ repositories, seed: CUSTOM_SEED });

		const contact = await repositories.contacts.findByWaId("15550000101");
		const phoneNumber = await repositories.phoneNumbers.findById("15550000100");

		expect(contact?.profileName).toBe("Jane Doe");
		expect(phoneNumber?.qualityRating).toBe("RED");
	});

	it("names an unnamed business after its verified name and keys it on its number", async () => {
		const seed: Seed = [
			{
				phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100", verifiedName: "Acme Inc" }],
				contacts: [],
				templates: [],
			},
		];

		const result = await applySeed({ repositories, seed });
		const [waba] = result.wabas;

		expect(waba?.name).toBe("Acme Inc");
		expect(waba?.phoneNumbers[0]?.verifiedName).toBe("Acme Inc");
	});

	it("shares a contact between two businesses", async () => {
		const seed: Seed = [
			{
				name: "Acme",
				phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0100" }],
				contacts: [{ waId: "1", name: "Ana" }],
				templates: [],
			},
			{
				name: "Other",
				phoneNumbers: [{ displayPhoneNumber: "+1 555 000 0200" }],
				contacts: [{ waId: "1", name: "Ana" }],
				templates: [],
			},
		];

		const result = await applySeed({ repositories, seed });

		expect(result.created.contacts).toBe(1);
		expect(await countRows()).toMatchObject({ contacts: 1 });
	});
});
