import type { StateResponse } from "@whaloc/shared";
import type { AppConfig } from "../config/index.ts";
import { deleteAllRows, type Repositories } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import type { MediaStorage } from "../storage/index.ts";
import { applySeed, type SeedResult } from "./apply-seed.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { deleteStoredMedia } from "./media-cleanup.ts";
import type { StateService } from "./state-service.ts";
import type { StatusLadder } from "./status-ladder.ts";
import type { TemplateLifecycle } from "./template-lifecycle.ts";
import type { TypingService } from "./typing-service.ts";

/**
 * `POST /api/reset` — back to a freshly booted whaloc (SPEC §5).
 *
 * Three things happen, in this order:
 *
 * 1. **Pending timers are cancelled.** A status ladder or a template approval left running
 *    would otherwise fire against rows that no longer exist.
 * 2. **Media bytes are deleted, then every table is wiped.** The stored files go too: their
 *    `media` rows are about to disappear, and leaving orphans behind in `WHALOC_MEDIA_DIR`
 *    would make a "reset" quietly untrue. A reset is a clean slate, bytes included.
 * 3. **The seed is applied again**, so the WABA and phone number ids a caller has in its
 *    configuration keep working (they are derived deterministically, SPEC §7).
 *
 * The delivery log is wiped as well: it describes traffic that no longer has any state behind
 * it, and keeping it would make the UI's timeline nonsense.
 */
export interface ResetServiceOptions {
	repositories: Repositories;
	mediaStorage: MediaStorage;
	config: AppConfig;
	logger: Logger;
	state: StateService;
	statusLadder: StatusLadder;
	templateLifecycle: TemplateLifecycle;
	typing: TypingService;
	events?: EventPublisher;
}

export interface ResetResult {
	state: StateResponse;
	seed: SeedResult;
}

export class ResetService {
	readonly #repositories: Repositories;
	readonly #mediaStorage: MediaStorage;
	readonly #config: AppConfig;
	readonly #logger: Logger;
	readonly #state: StateService;
	readonly #statusLadder: StatusLadder;
	readonly #templateLifecycle: TemplateLifecycle;
	readonly #typing: TypingService;
	readonly #events: EventPublisher;

	constructor(options: ResetServiceOptions) {
		this.#repositories = options.repositories;
		this.#mediaStorage = options.mediaStorage;
		this.#config = options.config;
		this.#logger = options.logger;
		this.#state = options.state;
		this.#statusLadder = options.statusLadder;
		this.#templateLifecycle = options.templateLifecycle;
		this.#typing = options.typing;
		this.#events = options.events ?? noopEventPublisher;
	}

	/**
	 * Best effort: a byte file that is already gone is not a reason to fail the reset.
	 *
	 * The upload sessions' bytes go with the media objects': a handle is reached from a template
	 * or a business profile, and both are about to be wiped (SPEC §2.21).
	 */
	async #deleteMediaObjects(): Promise<void> {
		const objects = await this.#repositories.media.listAll();
		const uploads = await this.#repositories.uploadSessions.listAll();

		await deleteStoredMedia({
			storageKeys: [
				...objects.map(media => media.storageKey),
				...uploads.flatMap(session => (session.storageKey === null ? [] : [session.storageKey])),
			],
			mediaStorage: this.#mediaStorage,
			logger: this.#logger,
		});
	}

	async reset(): Promise<ResetResult> {
		this.#statusLadder.cancelAll();
		this.#templateLifecycle.cancelAll();
		// A typing indicator describes a conversation that is about to stop existing; the
		// `state.reset` event below is what tells the UI to forget it.
		this.#typing.clearAll();

		await this.#deleteMediaObjects();
		await deleteAllRows(this.#repositories);

		const seed = await applySeed({ repositories: this.#repositories, seed: this.#config.seed });
		const state = await this.#state.snapshot();

		this.#logger.info({ wabas: seed.wabas }, "state reset");
		this.#events.publish({ type: "state.reset", payload: { state } });

		return { state, seed };
	}
}
