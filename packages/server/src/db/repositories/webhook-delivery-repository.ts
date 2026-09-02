import type { Kysely } from "kysely";
import { z } from "zod";
import { nowIso } from "../../timestamps.ts";
import { decodeJsonColumn, encodeJsonColumn } from "../json-column.ts";
import type { Database, WebhookDeliveryTable } from "../schema.ts";

const headersSchema = z.record(z.string(), z.string());

export type WebhookDeliveryHeaders = z.infer<typeof headersSchema>;

export interface WebhookDeliveryRecord {
	id: string;
	eventType: string;
	url: string;
	requestBody: string;
	requestHeaders: WebhookDeliveryHeaders;
	responseStatus: number | null;
	responseBody: string | null;
	error: string | null;
	attempt: number;
	durationMs: number | null;
	createdAt: string;
}

export interface InsertWebhookDeliveryInput {
	id: string;
	eventType: string;
	url: string;
	requestBody: string;
	requestHeaders: WebhookDeliveryHeaders;
	responseStatus?: number | null;
	responseBody?: string | null;
	error?: string | null;
	attempt?: number;
	durationMs?: number | null;
	createdAt?: string;
}

export interface ListWebhookDeliveriesQuery {
	limit?: number;
	/** Exclusive upper bound on `createdAt` — the `before` cursor of the control plane (SPEC §5). */
	before?: string;
}

const DEFAULT_LIST_LIMIT = 50;

function toRecord(row: WebhookDeliveryTable): WebhookDeliveryRecord {
	return {
		id: row.id,
		eventType: row.event_type,
		url: row.url,
		requestBody: row.request_body,
		requestHeaders: decodeJsonColumn(headersSchema, row.request_headers, "webhook_deliveries.request_headers"),
		responseStatus: row.response_status,
		responseBody: row.response_body,
		error: row.error,
		attempt: row.attempt,
		durationMs: row.duration_ms,
		createdAt: row.created_at,
	};
}

/**
 * The webhook delivery log — every attempt, including retries, is its own row (SPEC §3).
 * Rows are immutable: an attempt is inserted once its outcome is known.
 */
export class WebhookDeliveryRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertWebhookDeliveryInput): Promise<WebhookDeliveryRecord> {
		const row = await this.#db
			.insertInto("webhook_deliveries")
			.values({
				id: input.id,
				event_type: input.eventType,
				url: input.url,
				request_body: input.requestBody,
				request_headers: encodeJsonColumn(input.requestHeaders),
				response_status: input.responseStatus ?? null,
				response_body: input.responseBody ?? null,
				error: input.error ?? null,
				attempt: input.attempt ?? 1,
				duration_ms: input.durationMs ?? null,
				created_at: input.createdAt ?? nowIso(),
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<WebhookDeliveryRecord | null> {
		const row = await this.#db.selectFrom("webhook_deliveries").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Newest first, the order the delivery log is browsed in. */
	async list(query: ListWebhookDeliveriesQuery = {}): Promise<WebhookDeliveryRecord[]> {
		let builder = this.#db.selectFrom("webhook_deliveries").selectAll();

		if (query.before !== undefined) {
			builder = builder.where("created_at", "<", query.before);
		}

		const rows = await builder
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(query.limit ?? DEFAULT_LIST_LIMIT)
			.execute();

		return rows.map(row => toRecord(row));
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("webhook_deliveries").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
