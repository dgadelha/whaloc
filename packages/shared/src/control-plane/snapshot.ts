import { z } from "zod";
import { stateResponseSchema } from "./state.ts";

/**
 * State export and import (SPEC §5).
 *
 * The snapshot *file* is the server's business — it is a database dump, and its shape lives in
 * `packages/server/src/domain/state-snapshot.ts`. What the UI needs, and what belongs here, is
 * the answer to `POST /api/import`: how much came back, and the state to render afterwards.
 */

/** Where the export lives, and how a download of it is named. */
export const EXPORT_PATH = "/api/export";

export const importCountsSchema = z.object({
	wabas: z.number().int().nonnegative(),
	phoneNumbers: z.number().int().nonnegative(),
	contacts: z.number().int().nonnegative(),
	templates: z.number().int().nonnegative(),
	messages: z.number().int().nonnegative(),
	media: z.number().int().nonnegative(),
	/** Resumable Upload API sessions, completed or not (SPEC §2.21). */
	uploadSessions: z.number().int().nonnegative(),
	/** Zero unless the snapshot was exported with `?include=deliveries`. */
	webhookDeliveries: z.number().int().nonnegative(),
	injectionRules: z.number().int().nonnegative(),
	expiredTokens: z.number().int().nonnegative(),
});

export type ImportCounts = z.infer<typeof importCountsSchema>;

export const importSummarySchema = z.object({
	/** The snapshot's own schema version — equal to the one this whaloc writes, or it was refused. */
	schemaVersion: z.number().int().positive(),
	/** Which whaloc wrote the file; informational. */
	whalocVersion: z.string(),
	exportedAt: z.iso.datetime(),
	counts: importCountsSchema,
	mediaObjects: z.object({
		/** Objects whose bytes were written back through the current storage backend (SPEC §6). */
		restored: z.number().int().nonnegative(),
		/** Rows whose bytes were already gone when the snapshot was taken. */
		missing: z.number().int().nonnegative(),
		bytes: z.number().int().nonnegative(),
	}),
});

export type ImportSummary = z.infer<typeof importSummarySchema>;

/** The state comes back with it, so the UI can render the imported world without a round trip. */
export const importResponseSchema = z.object({
	data: z.object({ summary: importSummarySchema, state: stateResponseSchema }),
});

export type ImportResponse = z.infer<typeof importResponseSchema>;
