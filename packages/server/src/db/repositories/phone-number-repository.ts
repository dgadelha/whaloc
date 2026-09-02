import { businessProfileSchema, type BusinessProfile } from "@whaloc/shared";
import type { Kysely } from "kysely";
import type { QualityRating, ThroughputLevel } from "../../config/index.ts";
import { nowIso } from "../../timestamps.ts";
import { decodeJsonColumn, encodeJsonColumn } from "../json-column.ts";
import type {
	CodeVerificationStatus,
	Database,
	NameStatus,
	PhoneNumberStatus,
	PhoneNumberTable,
	VerificationCodeMethod,
} from "../schema.ts";

/** The verification a `request_code` started, `null` when none is pending. */
export interface PendingVerificationRecord {
	code: string;
	method: VerificationCodeMethod;
	language: string;
}

export interface PhoneNumberRecord {
	id: string;
	wabaId: string;
	displayPhoneNumber: string;
	verifiedName: string;
	qualityRating: QualityRating;
	throughputLevel: ThroughputLevel;
	status: PhoneNumberStatus;
	codeVerificationStatus: CodeVerificationStatus;
	nameStatus: NameStatus;
	pendingVerification: PendingVerificationRecord | null;
	/** The business profile this number publishes (SPEC §2.19); `{}` when it has none. */
	businessProfile: BusinessProfile;
	createdAt: string;
}

export interface InsertPhoneNumberInput {
	id: string;
	wabaId: string;
	displayPhoneNumber: string;
	verifiedName: string;
	qualityRating?: QualityRating;
	throughputLevel?: ThroughputLevel;
	/**
	 * Left out, a number is inserted as fully onboarded — which is what seeding and the control
	 * plane want (SPEC §4). The Graph create is the one caller that passes these.
	 */
	status?: PhoneNumberStatus;
	codeVerificationStatus?: CodeVerificationStatus;
	nameStatus?: NameStatus;
	createdAt?: string;
}

export interface UpdatePhoneNumberInput {
	displayPhoneNumber?: string;
	verifiedName?: string;
	qualityRating?: QualityRating;
	throughputLevel?: ThroughputLevel;
	status?: PhoneNumberStatus;
	codeVerificationStatus?: CodeVerificationStatus;
	nameStatus?: NameStatus;
	/** `null` clears the pending code — which is what verifying it does. */
	pendingVerification?: PendingVerificationRecord | null;
	/** Replaces the stored profile wholesale; merging is {@link BusinessProfileService}'s job. */
	businessProfile?: BusinessProfile;
}

/** A number is onboarded unless the caller says otherwise (see {@link InsertPhoneNumberInput}). */
const DEFAULT_STATUS: PhoneNumberStatus = "CONNECTED";
const DEFAULT_CODE_VERIFICATION_STATUS: CodeVerificationStatus = "VERIFIED";
const DEFAULT_NAME_STATUS: NameStatus = "APPROVED";

/** The three code columns travel together, so they are read back as one field or nothing. */
function toPendingVerification(row: PhoneNumberTable): PendingVerificationRecord | null {
	if (row.verification_code === null || row.verification_code_method === null) {
		return null;
	}

	return {
		code: row.verification_code,
		method: row.verification_code_method,
		language: row.verification_code_language ?? "",
	};
}

function toRecord(row: PhoneNumberTable): PhoneNumberRecord {
	return {
		id: row.id,
		wabaId: row.waba_id,
		displayPhoneNumber: row.display_phone_number,
		verifiedName: row.verified_name,
		qualityRating: row.quality_rating,
		throughputLevel: row.throughput_level,
		status: row.status,
		codeVerificationStatus: row.code_verification_status,
		nameStatus: row.name_status,
		pendingVerification: toPendingVerification(row),
		businessProfile: decodeJsonColumn(businessProfileSchema, row.business_profile, "phone_numbers.business_profile"),
		createdAt: row.created_at,
	};
}

/** The `verification_code*` columns for a pending verification, or the three nulls that clear it. */
function verificationColumns(pending: PendingVerificationRecord | null): Partial<PhoneNumberTable> {
	return {
		verification_code: pending?.code ?? null,
		verification_code_method: pending?.method ?? null,
		verification_code_language: pending?.language ?? null,
	};
}

/** Business phone numbers, the `phone_number_id` every Graph route is scoped by (SPEC §2). */
export class PhoneNumberRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertPhoneNumberInput): Promise<PhoneNumberRecord> {
		const row = await this.#db
			.insertInto("phone_numbers")
			.values({
				id: input.id,
				waba_id: input.wabaId,
				display_phone_number: input.displayPhoneNumber,
				verified_name: input.verifiedName,
				quality_rating: input.qualityRating ?? "GREEN",
				throughput_level: input.throughputLevel ?? "STANDARD",
				status: input.status ?? DEFAULT_STATUS,
				code_verification_status: input.codeVerificationStatus ?? DEFAULT_CODE_VERIFICATION_STATUS,
				name_status: input.nameStatus ?? DEFAULT_NAME_STATUS,
				...verificationColumns(null),
				// A new number publishes nothing until somebody posts a profile (SPEC §2.19).
				business_profile: encodeJsonColumn({}),
				created_at: input.createdAt ?? nowIso(),
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<PhoneNumberRecord | null> {
		const row = await this.#db.selectFrom("phone_numbers").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** The natural key seeding matches on: one display number per WABA (SPEC §7). */
	async findByDisplayPhoneNumber(wabaId: string, displayPhoneNumber: string): Promise<PhoneNumberRecord | null> {
		const row = await this.#db
			.selectFrom("phone_numbers")
			.selectAll()
			.where("waba_id", "=", wabaId)
			.where("display_phone_number", "=", displayPhoneNumber)
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async listByWabaId(wabaId: string): Promise<PhoneNumberRecord[]> {
		const rows = await this.#db
			.selectFrom("phone_numbers")
			.selectAll()
			.where("waba_id", "=", wabaId)
			.orderBy("created_at")
			.orderBy("id")
			.execute();

		return rows.map(row => toRecord(row));
	}

	async list(): Promise<PhoneNumberRecord[]> {
		const rows = await this.#db.selectFrom("phone_numbers").selectAll().orderBy("created_at").orderBy("id").execute();

		return rows.map(row => toRecord(row));
	}

	/** Used by the control plane and by the registration ladder (SPEC §4, §5). */
	async update(id: string, input: UpdatePhoneNumberInput): Promise<PhoneNumberRecord | null> {
		const patch = {
			...(input.displayPhoneNumber !== undefined && { display_phone_number: input.displayPhoneNumber }),
			...(input.verifiedName !== undefined && { verified_name: input.verifiedName }),
			...(input.qualityRating !== undefined && { quality_rating: input.qualityRating }),
			...(input.throughputLevel !== undefined && { throughput_level: input.throughputLevel }),
			...(input.status !== undefined && { status: input.status }),
			...(input.codeVerificationStatus !== undefined && { code_verification_status: input.codeVerificationStatus }),
			...(input.nameStatus !== undefined && { name_status: input.nameStatus }),
			...(input.pendingVerification !== undefined && verificationColumns(input.pendingVerification)),
			...(input.businessProfile !== undefined && { business_profile: encodeJsonColumn(input.businessProfile) }),
		};

		if (Object.keys(patch).length === 0) {
			return this.findById(id);
		}

		const row = await this.#db
			.updateTable("phone_numbers")
			.set(patch)
			.where("id", "=", id)
			.returningAll()
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/**
	 * Removes one number. Its messages and media rows go with it through the schema's cascades,
	 * but the *bytes* are the caller's problem — {@link PhoneNumberService} deletes them first.
	 */
	async deleteById(id: string): Promise<boolean> {
		const result = await this.#db.deleteFrom("phone_numbers").where("id", "=", id).executeTakeFirst();

		return Number(result.numDeletedRows) > 0;
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("phone_numbers").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
