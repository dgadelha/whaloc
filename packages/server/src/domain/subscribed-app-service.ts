import type { AppIdentity, ChangeEvent } from "@whaloc/shared";
import type { Repositories, WabaRecord } from "../db/index.ts";
import { toWabaDto } from "./control-dto.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { deriveNumericId } from "./ids.ts";
import { unknownObjectError } from "./meta-errors.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";

/**
 * `subscribed_apps` on a WABA (SPEC §2.20).
 *
 * In production this endpoint is how an app registers itself for a WABA's webhooks, and a WABA
 * can have several apps subscribed. whaloc models **one** app — itself — because it *is* the
 * webhook target: `WHALOC_WEBHOOK_URL` decides where deliveries go, so a second subscription
 * would have nowhere to point. The subscription is therefore a single per-WABA fact, and the
 * documented divergences are:
 *
 * - Whether an app is subscribed **does not gate delivery**. whaloc keeps posting webhooks to
 *   `WHALOC_WEBHOOK_URL` either way, because a dev tool that silently stopped delivering after
 *   a `DELETE` would be a support question, not a feature. Consumers that call `subscribed_apps`
 *   at startup get the round trip they expect; nothing else changes.
 * - `DELETE` on a WABA nothing is subscribed to answers `{success:true}` rather than an error:
 *   the call is idempotent, which is how a consumer's teardown wants to behave.
 *
 * An unknown WABA keeps whaloc's uniform missing-object envelope (SPEC §1.4).
 */

/** The name whaloc reports as the subscribed app; Meta reports the app's display name. */
export const APP_NAME = "whaloc";

/** What the app id is derived from when `WHALOC_APP_ID` is unset — stable across restarts. */
const DERIVED_APP_ID_KEY = "app:whaloc";

export interface SubscribedAppServiceOptions {
	repositories: Repositories;
	/** `WHALOC_APP_ID`; derived deterministically when unset. */
	appId?: string;
	/** `WHALOC_PUBLIC_URL`, reported as the app's `link`. */
	publicUrl: string;
	events?: EventPublisher;
	scheduler?: Scheduler;
}

/** One entry of `GET /{wabaId}/subscribed_apps`. */
export interface SubscribedApp {
	id: string;
	name: string;
	link: string;
}

export class SubscribedAppService {
	readonly #repositories: Repositories;
	readonly #app: SubscribedApp;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;

	constructor(options: SubscribedAppServiceOptions) {
		this.#repositories = options.repositories;
		this.#app = {
			id: options.appId ?? deriveNumericId(DERIVED_APP_ID_KEY),
			name: APP_NAME,
			link: options.publicUrl,
		};
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	async #waba(wabaId: string): Promise<WabaRecord> {
		const waba = await this.#repositories.wabas.findById(wabaId);

		if (waba === null) {
			throw unknownObjectError(wabaId);
		}

		return waba;
	}

	async #setSubscribedAt(wabaId: string, subscribedAt: string | null): Promise<WabaRecord> {
		const updated = await this.#repositories.wabas.update(wabaId, { subscribedAt });

		if (updated === null) {
			throw unknownObjectError(wabaId);
		}

		this.#announce(updated, "updated");

		return updated;
	}

	#announce(waba: WabaRecord, event: ChangeEvent): void {
		this.#events.publish({ type: "waba.changed", payload: { waba: toWabaDto(waba), event } });
	}

	/** The app whaloc plays, for `GET /api/state` and the UI. */
	get identity(): AppIdentity {
		return { id: this.#app.id, name: this.#app.name };
	}

	/** `POST /{wabaId}/subscribed_apps`. Re-subscribing refreshes the timestamp. */
	async subscribe(wabaId: string): Promise<WabaRecord> {
		await this.#waba(wabaId);

		return this.#setSubscribedAt(wabaId, this.#scheduler.now().toISOString());
	}

	/** `GET /{wabaId}/subscribed_apps` — one entry, or none. */
	async list(wabaId: string): Promise<SubscribedApp[]> {
		const waba = await this.#waba(wabaId);

		return waba.subscribedAt === null ? [] : [{ ...this.#app }];
	}

	/** `DELETE /{wabaId}/subscribed_apps`, idempotent. */
	async unsubscribe(wabaId: string): Promise<WabaRecord> {
		const waba = await this.#waba(wabaId);

		return waba.subscribedAt === null ? waba : this.#setSubscribedAt(wabaId, null);
	}
}
