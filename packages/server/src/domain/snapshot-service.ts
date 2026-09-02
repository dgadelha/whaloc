import type { ImportSummary, StateResponse } from "@whaloc/shared";
import { buffer } from "node:stream/consumers";
import type { Repositories } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import { MediaObjectNotFoundError, type MediaStorage } from "../storage/index.ts";
import { WHALOC_VERSION } from "../version.ts";
import { controlBadRequest, ControlPlaneError } from "./control-plane-error.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { deleteStoredMedia } from "./media-cleanup.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";
import {
	SNAPSHOT_SCHEMA_VERSION,
	stateSnapshotSchema,
	type SnapshotMediaObject,
	type StateSnapshot,
} from "./state-snapshot.ts";
import type { StateService } from "./state-service.ts";
import type { StatusLadder } from "./status-ladder.ts";
import type { TemplateLifecycle } from "./template-lifecycle.ts";
import type { TypingService } from "./typing-service.ts";

/**
 * State export and import (SPEC §5) — one JSON file that is a whole whaloc.
 *
 * `GET /api/export` writes every domain table plus the media bytes; `POST /api/import` wipes
 * everything and loads such a file back. Together they make a scenario shareable: a colleague
 * reproducing a bug sends the file, and the whaloc it lands in *is* the one it left.
 *
 * Three properties are what make it trustworthy:
 *
 * 1. **Validate before destroying.** The snapshot is parsed in full — every row, every enum —
 *    before a single row is deleted, and the database swap itself is one transaction.
 * 2. **The bytes go through the storage adapter**, never near a filesystem, so a snapshot taken
 *    from a local-backed whaloc imports into an S3-backed one and back (SPEC §6).
 * 3. **The seed does not run afterwards.** An import is not a reset: the snapshot *is* the
 *    state, seeded ids included. `POST /api/reset` is still the way back to `WHALOC_SEED`.
 */
export interface SnapshotServiceOptions {
	repositories: Repositories;
	mediaStorage: MediaStorage;
	logger: Logger;
	state: StateService;
	/** Cancelled on import, exactly as a reset does: they would fire against deleted rows. */
	statusLadder: StatusLadder;
	templateLifecycle: TemplateLifecycle;
	typing: TypingService;
	events?: EventPublisher;
	/** Injected by tests so `exportedAt` is not the wall clock. */
	scheduler?: Scheduler;
}

export interface ExportOptions {
	/** `?include=deliveries`: the delivery log is traffic, not state, so it is opt-in. */
	includeDeliveries?: boolean;
}

export interface ImportResult {
	summary: ImportSummary;
	state: StateResponse;
}

/** What `POST /api/import` refuses, in the words the caller sees. */
function tooNewError(schemaVersion: number): ControlPlaneError {
	return controlBadRequest(
		`this snapshot has schema version ${String(schemaVersion)}, and this whaloc understands up to ${String(
			SNAPSHOT_SCHEMA_VERSION,
		)} — it was written by a newer whaloc, so upgrade this one to import it`,
		"snapshot_too_new",
	);
}

export class SnapshotService {
	readonly #repositories: Repositories;
	readonly #mediaStorage: MediaStorage;
	readonly #logger: Logger;
	readonly #state: StateService;
	readonly #statusLadder: StatusLadder;
	readonly #templateLifecycle: TemplateLifecycle;
	readonly #typing: TypingService;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;

	constructor(options: SnapshotServiceOptions) {
		this.#repositories = options.repositories;
		this.#mediaStorage = options.mediaStorage;
		this.#logger = options.logger;
		this.#state = options.state;
		this.#statusLadder = options.statusLadder;
		this.#templateLifecycle = options.templateLifecycle;
		this.#typing = options.typing;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	/** One media object's bytes, or `null` when storage no longer has them. */
	async #readObject(storageKey: string): Promise<SnapshotMediaObject> {
		try {
			const object = await this.#mediaStorage.get(storageKey);
			const bytes = await buffer(object.stream);

			return { storageKey, bytes: bytes.toString("base64") };
		} catch (error) {
			if (error instanceof MediaObjectNotFoundError) {
				// The row still travels: a message pointing at it keeps resolving, and the import
				// reports how many objects came back empty.
				this.#logger.warn({ storageKey }, "media object is missing from storage, exporting its row without bytes");

				return { storageKey, bytes: null };
			}

			throw error;
		}
	}

	/** Writes the snapshot's bytes back through whichever backend is configured now (SPEC §6). */
	async #restoreObjects(snapshot: StateSnapshot): Promise<{ restored: number; missing: number; bytes: number }> {
		let restored = 0;
		let missing = 0;
		let bytes = 0;

		for (const object of snapshot.mediaObjects) {
			if (object.bytes === null) {
				missing += 1;

				continue;
			}

			const decoded = Buffer.from(object.bytes, "base64");

			await this.#mediaStorage.put(decoded, { key: object.storageKey });
			restored += 1;
			bytes += decoded.byteLength;
		}

		return { restored, missing, bytes };
	}

	async exportState(options: ExportOptions = {}): Promise<StateSnapshot> {
		const tables = await this.#repositories.snapshots.readAll({
			includeDeliveries: options.includeDeliveries ?? false,
		});
		const mediaObjects: SnapshotMediaObject[] = [];

		// One entry per media row, in the rows' own (deterministic) order.
		for (const media of tables.media) {
			mediaObjects.push(await this.#readObject(media.storage_key));
		}

		// …then the bytes behind every completed upload handle (SPEC §2.21), so a template whose
		// header names one still previews after the snapshot lands somewhere else.
		for (const session of tables.upload_sessions) {
			if (session.storage_key !== null) {
				mediaObjects.push(await this.#readObject(session.storage_key));
			}
		}

		return {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			whalocVersion: WHALOC_VERSION,
			exportedAt: this.#scheduler.now().toISOString(),
			tables,
			mediaObjects,
		};
	}

	/**
	 * Parses and version-gates a candidate snapshot. Kept separate from {@link importState} so
	 * that everything which can be rejected *is* rejected before any state is touched.
	 */
	parse(candidate: unknown): StateSnapshot {
		const result = stateSnapshotSchema.safeParse(candidate);

		if (!result.success) {
			const issues = result.error.issues
				.slice(0, 5)
				.map(issue => `${issue.path.map(String).join(".")}: ${issue.message}`)
				.join("; ");

			throw controlBadRequest(`this is not a whaloc state snapshot — ${issues}`, "invalid_snapshot");
		}

		if (result.data.schemaVersion > SNAPSHOT_SCHEMA_VERSION) {
			throw tooNewError(result.data.schemaVersion);
		}

		if (result.data.schemaVersion < SNAPSHOT_SCHEMA_VERSION) {
			throw controlBadRequest(
				`this snapshot has schema version ${String(result.data.schemaVersion)}, which this whaloc can no longer read`,
				"snapshot_too_old",
			);
		}

		return result.data;
	}

	/**
	 * Replaces every piece of state with the snapshot's, then announces it.
	 *
	 * The order matters: timers first (they would fire against rows that are about to go), then
	 * the atomic database swap, then the bytes — stale objects the snapshot does not bring back
	 * are deleted, and the ones it does are overwritten in place, so re-importing the same
	 * snapshot is a no-op rather than a delete-then-write.
	 */
	async importState(candidate: unknown): Promise<ImportResult> {
		const snapshot = this.parse(candidate);

		this.#statusLadder.cancelAll();
		this.#templateLifecycle.cancelAll();
		this.#typing.clearAll();

		const previous = await this.#repositories.media.listAll();
		const previousUploads = await this.#repositories.uploadSessions.listAll();
		const arriving = new Set(snapshot.mediaObjects.map(object => object.storageKey));

		await this.#repositories.snapshots.replaceAll(snapshot.tables);
		await deleteStoredMedia({
			storageKeys: [
				...previous.map(media => media.storageKey),
				...previousUploads.flatMap(session => (session.storageKey === null ? [] : [session.storageKey])),
			],
			keep: arriving,
			mediaStorage: this.#mediaStorage,
			logger: this.#logger,
		});

		const media = await this.#restoreObjects(snapshot);
		const { tables } = snapshot;
		const summary: ImportSummary = {
			schemaVersion: snapshot.schemaVersion,
			whalocVersion: snapshot.whalocVersion,
			exportedAt: snapshot.exportedAt,
			counts: {
				wabas: tables.wabas.length,
				phoneNumbers: tables.phone_numbers.length,
				contacts: tables.contacts.length,
				templates: tables.templates.length,
				messages: tables.messages.length,
				media: tables.media.length,
				uploadSessions: tables.upload_sessions.length,
				webhookDeliveries: tables.webhook_deliveries.length,
				injectionRules: tables.injection_rules.length,
				expiredTokens: tables.expired_tokens.length,
			},
			mediaObjects: media,
		};
		const state = await this.#state.snapshot();

		this.#logger.info({ summary }, "state imported");
		// The same shape `state.reset` carries: a connected UI reloads either way (SPEC §5).
		this.#events.publish({ type: "state.imported", payload: { state } });

		return { summary, state };
	}
}
