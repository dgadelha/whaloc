import { sql, type Kysely, type SqlBool } from "kysely";
import type { QualityRating, TemplateCategory, TemplateParameterFormat } from "../../config/index.ts";
import { nowIso } from "../../timestamps.ts";
import { decodeJsonColumn, encodeJsonColumn, jsonObjectArraySchema, type JsonObject } from "../json-column.ts";
import type { Database, TemplateStatus, TemplateTable } from "../schema.ts";

/** What `escape` names in the `like` predicates below. */
const LIKE_ESCAPE_CHARACTER = "\\";

/** Makes a user-supplied substring literal: `_` and `%` are wildcards in `like`, not letters. */
function likeEscape(value: string): string {
	return value.replaceAll(/[\\%_]/g, character => `${LIKE_ESCAPE_CHARACTER}${character}`);
}

export interface TemplateRecord {
	id: string;
	wabaId: string;
	name: string;
	language: string;
	category: TemplateCategory;
	parameterFormat: TemplateParameterFormat;
	components: JsonObject[];
	status: TemplateStatus;
	rejectedReason: string | null;
	qualityScore: QualityRating | null;
	createdAt: string;
	updatedAt: string;
}

export interface InsertTemplateInput {
	id: string;
	wabaId: string;
	name: string;
	language: string;
	category: TemplateCategory;
	parameterFormat?: TemplateParameterFormat;
	components: JsonObject[];
	status?: TemplateStatus;
	createdAt?: string;
}

export interface UpdateTemplateInput {
	category?: TemplateCategory;
	parameterFormat?: TemplateParameterFormat;
	components?: JsonObject[];
	status?: TemplateStatus;
	rejectedReason?: string | null;
	qualityScore?: QualityRating | null;
	updatedAt?: string;
}

/**
 * The filters Meta's `GET /{wabaId}/message_templates` accepts (SPEC §2.8).
 *
 * `nameOrContent` is Meta's `name_or_content`: a substring of the name **or** of the template's
 * text. whaloc matches it against the name and the serialized `components` column — a documented
 * simplification (searching `BODY` matches every template that has a body) that keeps the search
 * inside SQL, which is what lets the keyset cursors keep working under a filter.
 */
export interface TemplateFilters {
	/** Exact match, like Meta's `name`. */
	name?: string;
	nameOrContent?: string;
	status?: TemplateStatus;
	category?: TemplateCategory;
	language?: string;
}

export interface ListTemplatesQuery extends TemplateFilters {
	wabaId: string;
	limit?: number;
	/** Exclusive cursor: only templates created after this id are returned (SPEC §1.5). */
	afterId?: string;
	/** Exclusive cursor the other way: only templates created before this id (SPEC §1.5). */
	beforeId?: string;
}

/** Unpaginated listing for the control plane (SPEC §5), with the same filters. */
export interface ListAllTemplatesQuery extends TemplateFilters {
	wabaId?: string;
}

const DEFAULT_LIST_LIMIT = 25;

function toRecord(row: TemplateTable): TemplateRecord {
	return {
		id: row.id,
		wabaId: row.waba_id,
		name: row.name,
		language: row.language,
		category: row.category,
		parameterFormat: row.parameter_format,
		components: decodeJsonColumn(jsonObjectArraySchema, row.components, "templates.components"),
		status: row.status,
		rejectedReason: row.rejected_reason,
		qualityScore: row.quality_score,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Message templates, unique per WABA by name + language (SPEC §2.7). */
export class TemplateRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	/**
	 * `select * from templates` with {@link TemplateFilters} applied — the one place the filter
	 * vocabulary turns into SQL, shared by the Graph listing and the control plane's.
	 */
	#filtered(filters: TemplateFilters) {
		let builder = this.#db.selectFrom("templates").selectAll();

		if (filters.name !== undefined) {
			builder = builder.where("name", "=", filters.name);
		}

		if (filters.status !== undefined) {
			builder = builder.where("status", "=", filters.status);
		}

		if (filters.category !== undefined) {
			builder = builder.where("category", "=", filters.category);
		}

		if (filters.language !== undefined) {
			builder = builder.where("language", "=", filters.language);
		}

		if (filters.nameOrContent !== undefined) {
			// `_` and `%` are ordinary characters in a template name, so the pattern is escaped
			// and SQLite is told what the escape character is. LIKE is already case-insensitive
			// for ASCII, which is the case-folding Meta's own search does.
			const pattern = `%${likeEscape(filters.nameOrContent)}%`;

			builder = builder.where(eb => {
				return eb.or([
					sql<SqlBool>`name like ${pattern} escape ${LIKE_ESCAPE_CHARACTER}`,
					sql<SqlBool>`components like ${pattern} escape ${LIKE_ESCAPE_CHARACTER}`,
				]);
			});
		}

		return builder;
	}

	/** The (created_at, id) key a cursor id points at, or `undefined` when it names nothing. */
	async #cursorKey(id: string | undefined): Promise<{ created_at: string; id: string } | undefined> {
		if (id === undefined) {
			return undefined;
		}

		return this.#db.selectFrom("templates").select(["created_at", "id"]).where("id", "=", id).executeTakeFirst();
	}

	async insert(input: InsertTemplateInput): Promise<TemplateRecord> {
		const timestamp = input.createdAt ?? nowIso();
		const row = await this.#db
			.insertInto("templates")
			.values({
				id: input.id,
				waba_id: input.wabaId,
				name: input.name,
				language: input.language,
				category: input.category,
				parameter_format: input.parameterFormat ?? "POSITIONAL",
				components: encodeJsonColumn(input.components),
				status: input.status ?? "PENDING",
				rejected_reason: null,
				quality_score: null,
				created_at: timestamp,
				updated_at: timestamp,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<TemplateRecord | null> {
		const row = await this.#db.selectFrom("templates").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async findByNameAndLanguage(wabaId: string, name: string, language: string): Promise<TemplateRecord | null> {
		const row = await this.#db
			.selectFrom("templates")
			.selectAll()
			.where("waba_id", "=", wabaId)
			.where("name", "=", name)
			.where("language", "=", language)
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Every language of a template name, which is what a send validates against (SPEC §2). */
	async findByName(wabaId: string, name: string): Promise<TemplateRecord[]> {
		const rows = await this.#db
			.selectFrom("templates")
			.selectAll()
			.where("waba_id", "=", wabaId)
			.where("name", "=", name)
			.orderBy("language")
			.execute();

		return rows.map(row => toRecord(row));
	}

	/**
	 * One page of templates, filtered and keyset-paginated (SPEC §1.5, §2.8).
	 *
	 * The order is always (created_at, id) ascending, whichever direction the page was asked
	 * for: a `beforeId` query walks **backwards** in SQL — the rows nearest the cursor, newest
	 * first — and the page is reversed on the way out, so the caller always sees oldest first.
	 */
	async list(query: ListTemplatesQuery): Promise<TemplateRecord[]> {
		const isBackwards = query.beforeId !== undefined && query.afterId === undefined;
		const cursor = await this.#cursorKey(isBackwards ? query.beforeId : query.afterId);
		let builder = this.#filtered(query)
			.where("waba_id", "=", query.wabaId)
			.orderBy("created_at", isBackwards ? "desc" : "asc")
			.orderBy("id", isBackwards ? "desc" : "asc")
			.limit(query.limit ?? DEFAULT_LIST_LIMIT);

		if (cursor !== undefined) {
			// Keyset pagination on (created_at, id): two templates created in the same
			// millisecond still get a total order.
			const beyond = isBackwards ? "<" : ">";

			builder = builder.where(eb => {
				return eb.or([
					eb("created_at", beyond, cursor.created_at),
					eb.and([eb("created_at", "=", cursor.created_at), eb("id", beyond, cursor.id)]),
				]);
			});
		}

		const rows = await builder.execute();
		const ordered = isBackwards ? rows.toReversed() : rows;

		return ordered.map(row => toRecord(row));
	}

	/**
	 * Every template, optionally narrowed — what the control plane's moderation view lists
	 * (SPEC §5). The Graph API's paginated {@link list} is a different question.
	 */
	async listAll(query: ListAllTemplatesQuery = {}): Promise<TemplateRecord[]> {
		let builder = this.#filtered(query);

		if (query.wabaId !== undefined) {
			builder = builder.where("waba_id", "=", query.wabaId);
		}

		const rows = await builder.orderBy("created_at").orderBy("id").execute();

		return rows.map(row => toRecord(row));
	}

	async update(id: string, input: UpdateTemplateInput): Promise<TemplateRecord | null> {
		const row = await this.#db
			.updateTable("templates")
			.set({
				...(input.category !== undefined && { category: input.category }),
				...(input.parameterFormat !== undefined && { parameter_format: input.parameterFormat }),
				...(input.components !== undefined && { components: encodeJsonColumn(input.components) }),
				...(input.status !== undefined && { status: input.status }),
				...(input.rejectedReason !== undefined && { rejected_reason: input.rejectedReason }),
				...(input.qualityScore !== undefined && { quality_score: input.qualityScore }),
				updated_at: input.updatedAt ?? nowIso(),
			})
			.where("id", "=", id)
			.returningAll()
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async deleteById(id: string): Promise<boolean> {
		const result = await this.#db.deleteFrom("templates").where("id", "=", id).executeTakeFirst();

		return result.numDeletedRows > 0n;
	}

	/** `DELETE /{wabaId}/message_templates?name=` removes every language (SPEC §2.10). */
	async deleteByName(wabaId: string, name: string): Promise<number> {
		const result = await this.#db
			.deleteFrom("templates")
			.where("waba_id", "=", wabaId)
			.where("name", "=", name)
			.executeTakeFirst();

		return Number(result.numDeletedRows);
	}

	/** Everything a deleted WABA owned (SPEC §5); the schema would cascade, this counts them. */
	async deleteByWabaId(wabaId: string): Promise<number> {
		const result = await this.#db.deleteFrom("templates").where("waba_id", "=", wabaId).executeTakeFirst();

		return Number(result.numDeletedRows);
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("templates").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
