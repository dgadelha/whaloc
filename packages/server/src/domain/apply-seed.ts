import type { Seed, SeedWaba } from "../config/index.ts";
import type { Repositories } from "../db/index.ts";
import { nowIso } from "../timestamps.ts";
import { deriveNumericId } from "./ids.ts";
import { phoneNumberDigits } from "./phone-number-format.ts";

export interface SeededPhoneNumber {
	id: string;
	displayPhoneNumber: string;
	verifiedName: string;
}

export interface SeededContact {
	waId: string;
	profileName: string;
	userId: string | null;
}

export interface SeededTemplate {
	id: string;
	name: string;
	language: string;
}

export interface SeededWaba {
	id: string;
	name: string;
	phoneNumbers: SeededPhoneNumber[];
	contacts: SeededContact[];
	templates: SeededTemplate[];
}

export interface SeedResult {
	/** Every seeded entity with the id it resolved to — logged at boot so it can be copied. */
	wabas: SeededWaba[];
	/** Rows this run actually inserted; all zeroes when the seed was already applied. */
	created: { wabas: number; phoneNumbers: number; contacts: number; templates: number };
}

export interface ApplySeedOptions {
	repositories: Repositories;
	seed: Seed;
	/** ISO timestamp stamped on the rows this run creates; defaults to now. */
	createdAt?: string;
}

const DEFAULT_BUSINESS_NAME = "whaloc Business";

/**
 * What identifies a WABA when the seed leaves its id out: its name, or — for an unnamed one —
 * the first phone number it owns.
 */
function wabaNaturalKey(waba: SeedWaba): string {
	return waba.name ?? phoneNumberDigits(waba.phoneNumbers[0]?.displayPhoneNumber ?? "");
}

function wabaName(waba: SeedWaba): string {
	return waba.name ?? waba.phoneNumbers[0]?.verifiedName ?? DEFAULT_BUSINESS_NAME;
}

/**
 * Applies `WHALOC_SEED` after the migrations (SPEC §7).
 *
 * Two properties matter, and both are tested:
 *
 * - **Idempotent.** Rows are matched by natural key (a WABA by id or derived id, a phone
 *   number by its display number within the WABA, a contact by `wa_id`, a template by its name
 *   and language within the WABA) and only inserted when missing, so restarting against a
 *   persisted `WHALOC_DB_PATH` never duplicates anything and never overwrites state the UI has
 *   changed since.
 * - **Deterministic.** Ids omitted from the seed are derived from that same natural key, so
 *   a `:memory:` database hands out the same ids on every boot.
 *
 * Seeded templates are written straight to `APPROVED` (SPEC §7). A seed describes templates
 * that exist already, the way it describes numbers that are already registered: no `PENDING`
 * window, no `message_template_status_update`, no auto-approval timer — the rows go in through
 * the repository, so {@link TemplateLifecycle} never hears about them.
 */
export async function applySeed(options: ApplySeedOptions): Promise<SeedResult> {
	const { repositories, seed } = options;
	const createdAt = options.createdAt ?? nowIso();
	const result: SeedResult = { wabas: [], created: { wabas: 0, phoneNumbers: 0, contacts: 0, templates: 0 } };

	for (const seedWaba of seed) {
		const id = seedWaba.id ?? deriveNumericId(`waba:${wabaNaturalKey(seedWaba)}`);
		const name = wabaName(seedWaba);

		if ((await repositories.wabas.findById(id)) === null) {
			await repositories.wabas.insert({ id, name, createdAt });
			result.created.wabas += 1;
		}

		const waba: SeededWaba = { id, name, phoneNumbers: [], contacts: [], templates: [] };

		for (const seedPhoneNumber of seedWaba.phoneNumbers) {
			const phoneNumberId =
				seedPhoneNumber.id ??
				deriveNumericId(`phone_number:${id}:${phoneNumberDigits(seedPhoneNumber.displayPhoneNumber)}`);
			const verifiedName = seedPhoneNumber.verifiedName ?? name;
			const existing =
				(await repositories.phoneNumbers.findById(phoneNumberId)) ??
				(await repositories.phoneNumbers.findByDisplayPhoneNumber(id, seedPhoneNumber.displayPhoneNumber));

			if (existing === null) {
				await repositories.phoneNumbers.insert({
					id: phoneNumberId,
					wabaId: id,
					displayPhoneNumber: seedPhoneNumber.displayPhoneNumber,
					verifiedName,
					qualityRating: seedPhoneNumber.qualityRating,
					throughputLevel: seedPhoneNumber.throughputLevel,
					createdAt,
				});
				result.created.phoneNumbers += 1;
			}

			waba.phoneNumbers.push({
				id: existing?.id ?? phoneNumberId,
				displayPhoneNumber: existing?.displayPhoneNumber ?? seedPhoneNumber.displayPhoneNumber,
				verifiedName: existing?.verifiedName ?? verifiedName,
			});
		}

		for (const seedContact of seedWaba.contacts) {
			const existing = await repositories.contacts.findByWaId(seedContact.waId);

			if (existing === null) {
				await repositories.contacts.insert({
					waId: seedContact.waId,
					profileName: seedContact.name,
					userId: seedContact.userId ?? null,
					createdAt,
				});
				result.created.contacts += 1;
			}

			waba.contacts.push({
				waId: seedContact.waId,
				profileName: existing?.profileName ?? seedContact.name,
				userId: existing === null ? (seedContact.userId ?? null) : existing.userId,
			});
		}

		for (const seedTemplate of seedWaba.templates) {
			const templateId =
				seedTemplate.id ?? deriveNumericId(`template:${id}:${seedTemplate.name}:${seedTemplate.language}`);
			const existing =
				(await repositories.templates.findById(templateId)) ??
				(await repositories.templates.findByNameAndLanguage(id, seedTemplate.name, seedTemplate.language));

			if (existing === null) {
				await repositories.templates.insert({
					id: templateId,
					wabaId: id,
					name: seedTemplate.name,
					language: seedTemplate.language,
					category: seedTemplate.category,
					parameterFormat: seedTemplate.parameterFormat,
					components: seedTemplate.components,
					// Approved from the first instant: a seeded template is one that exists.
					status: "APPROVED",
					createdAt,
				});
				result.created.templates += 1;
			}

			waba.templates.push({
				id: existing?.id ?? templateId,
				name: existing?.name ?? seedTemplate.name,
				language: existing?.language ?? seedTemplate.language,
			});
		}

		result.wabas.push(waba);
	}

	return result;
}
