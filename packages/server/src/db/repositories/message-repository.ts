import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { TEMPLATE_PARAMETER_FORMATS } from "../../config/index.ts";
import {
	decodeJsonColumn,
	decodeNullableJsonColumn,
	encodeJsonColumn,
	jsonObjectArraySchema,
	jsonObjectSchema,
	type JsonObject,
} from "../json-column.ts";
import { nowIso } from "../../timestamps.ts";
import type { TemplateRecord } from "./template-repository.ts";
import type { Database, MessageDirection, MessageStatus, MessageTable, MessageType } from "../schema.ts";

/** The template a `template` send was validated against, as it stood at send time (SPEC §2.5). */
export type TemplateSnapshotRecord = Pick<TemplateRecord, "parameterFormat" | "components">;

/** The column spells its keys the way the `templates` table does. */
const templateSnapshotColumnSchema = z.object({
	parameter_format: z.enum(TEMPLATE_PARAMETER_FORMATS),
	components: jsonObjectArraySchema,
});

function decodeTemplateSnapshot(raw: string | null): TemplateSnapshotRecord | null {
	const column = decodeNullableJsonColumn(templateSnapshotColumnSchema, raw, "messages.template_snapshot");

	return column === null ? null : { parameterFormat: column.parameter_format, components: column.components };
}

function encodeTemplateSnapshot(snapshot: TemplateSnapshotRecord): string {
	return encodeJsonColumn({ parameter_format: snapshot.parameterFormat, components: snapshot.components });
}

export interface MessageRecord {
	id: string;
	direction: MessageDirection;
	phoneNumberId: string;
	contactWaId: string;
	type: MessageType;
	payload: JsonObject;
	status: MessageStatus;
	error: JsonObject | null;
	replyTo: string | null;
	/** The `biz_opaque_callback_data` of the send, echoed on its status webhooks (SPEC §2.5). */
	bizOpaqueCallbackData: string | null;
	/** What a `template` send was validated against; `null` for anything else (SPEC §2.5). */
	templateSnapshot: TemplateSnapshotRecord | null;
	timestamp: string;
	createdAt: string;
	updatedAt: string;
}

export interface InsertMessageInput {
	id: string;
	direction: MessageDirection;
	phoneNumberId: string;
	contactWaId: string;
	type: MessageType;
	payload: JsonObject;
	status?: MessageStatus;
	replyTo?: string | null;
	bizOpaqueCallbackData?: string | null;
	templateSnapshot?: TemplateSnapshotRecord | null;
	/** When the message was sent or received; defaults to now. */
	timestamp?: string;
	createdAt?: string;
}

export interface UpdateMessageStatusInput {
	status: MessageStatus;
	/** Meta's error node for a `failed` status; `null` clears it. */
	error?: JsonObject | null;
	updatedAt?: string;
}

/** One (phone number, contact) pair, aggregated from the messages between them. */
export interface ConversationSummary {
	phoneNumberId: string;
	contactWaId: string;
	messageCount: number;
	lastMessageAt: string;
}

export interface ListConversationQuery {
	phoneNumberId: string;
	contactWaId: string;
	limit?: number;
	/** Exclusive upper bound on `timestamp`, for paging backwards through history. */
	before?: string;
}

const DEFAULT_LIST_LIMIT = 50;

function toRecord(row: MessageTable): MessageRecord {
	return {
		id: row.id,
		direction: row.direction,
		phoneNumberId: row.phone_number_id,
		contactWaId: row.contact_wa_id,
		type: row.type,
		payload: decodeJsonColumn(jsonObjectSchema, row.payload, "messages.payload"),
		status: row.status,
		error: decodeNullableJsonColumn(jsonObjectSchema, row.error, "messages.error"),
		replyTo: row.reply_to,
		bizOpaqueCallbackData: row.biz_opaque_callback_data,
		templateSnapshot: decodeTemplateSnapshot(row.template_snapshot),
		timestamp: row.timestamp,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Messages in both directions, the conversation the UI renders (SPEC §5). */
export class MessageRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertMessageInput): Promise<MessageRecord> {
		const now = nowIso();
		const createdAt = input.createdAt ?? now;
		const row = await this.#db
			.insertInto("messages")
			.values({
				id: input.id,
				direction: input.direction,
				phone_number_id: input.phoneNumberId,
				contact_wa_id: input.contactWaId,
				type: input.type,
				payload: encodeJsonColumn(input.payload),
				status: input.status ?? "accepted",
				error: null,
				reply_to: input.replyTo ?? null,
				biz_opaque_callback_data: input.bizOpaqueCallbackData ?? null,
				template_snapshot: input.templateSnapshot ? encodeTemplateSnapshot(input.templateSnapshot) : null,
				timestamp: input.timestamp ?? createdAt,
				created_at: createdAt,
				updated_at: createdAt,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<MessageRecord | null> {
		const row = await this.#db.selectFrom("messages").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** One conversation, newest last (SPEC §5). */
	async listConversation(query: ListConversationQuery): Promise<MessageRecord[]> {
		let builder = this.#db
			.selectFrom("messages")
			.selectAll()
			.where("phone_number_id", "=", query.phoneNumberId)
			.where("contact_wa_id", "=", query.contactWaId);

		if (query.before !== undefined) {
			builder = builder.where("timestamp", "<", query.before);
		}

		// Take the newest page, then hand it back oldest first. The tie-break is SQLite's
		// implicit `rowid`, i.e. insertion order: two messages stored in the same millisecond
		// keep the order they arrived in, where the (random) wamid would shuffle them.
		const rows = await builder
			.orderBy("timestamp", "desc")
			.orderBy(sql`rowid`, "desc")
			.limit(query.limit ?? DEFAULT_LIST_LIMIT)
			.execute();

		return rows.toReversed().map(row => toRecord(row));
	}

	/**
	 * The conversation list the UI opens on (SPEC §5): one row per (phone number, contact)
	 * pair that has ever exchanged a message, newest activity first. whaloc stores no
	 * conversation entity — this grouping *is* the conversation.
	 */
	async listConversations(phoneNumberId?: string): Promise<ConversationSummary[]> {
		let builder = this.#db.selectFrom("messages");

		if (phoneNumberId !== undefined) {
			builder = builder.where("phone_number_id", "=", phoneNumberId);
		}

		const rows = await builder
			.select(eb => {
				return [
					"phone_number_id",
					"contact_wa_id",
					eb.fn.countAll().as("message_count"),
					eb.fn.max("timestamp").as("last_message_at"),
				];
			})
			.groupBy(["phone_number_id", "contact_wa_id"])
			.orderBy("last_message_at", "desc")
			.execute();

		return rows.map(row => {
			return {
				phoneNumberId: row.phone_number_id,
				contactWaId: row.contact_wa_id,
				messageCount: Number(row.message_count),
				lastMessageAt: row.last_message_at,
			};
		});
	}

	/** Advances a message along the status ladder (SPEC §4). */
	async updateStatus(id: string, input: UpdateMessageStatusInput): Promise<MessageRecord | null> {
		const row = await this.#db
			.updateTable("messages")
			.set({
				status: input.status,
				...(input.error !== undefined && { error: input.error === null ? null : encodeJsonColumn(input.error) }),
				updated_at: input.updatedAt ?? nowIso(),
			})
			.where("id", "=", id)
			.returningAll()
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("messages").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
