import type { StateResponse, WabaState } from "@whaloc/shared";
import type { AppConfig } from "../config/index.ts";
import type { Repositories } from "../db/index.ts";
import { toPhoneNumberDto } from "./control-dto.ts";
import type { SubscribedAppService } from "./subscribed-app-service.ts";
import type { WebhookEmitter } from "./webhook-emitter.ts";

/**
 * `GET /api/state` (SPEC §5): the WABAs and phone numbers whaloc is emulating, the behavior
 * knobs that decide what happens next, and whether the webhook target is usable.
 *
 * Secrets are reported as configured or not, never served — the UI has no reason to know
 * `WHALOC_APP_SECRET`, and the state endpoint has no authentication in front of it.
 */
export interface StateServiceOptions {
	repositories: Repositories;
	config: AppConfig;
	webhooks: WebhookEmitter;
	/** Names the one app `subscribed_apps` reports (SPEC §2.20). */
	subscribedApps: SubscribedAppService;
}

export class StateService {
	readonly #repositories: Repositories;
	readonly #config: AppConfig;
	readonly #webhooks: WebhookEmitter;
	readonly #subscribedApps: SubscribedAppService;

	constructor(options: StateServiceOptions) {
		this.#repositories = options.repositories;
		this.#config = options.config;
		this.#webhooks = options.webhooks;
		this.#subscribedApps = options.subscribedApps;
	}

	async snapshot(): Promise<StateResponse> {
		const wabas = await this.#repositories.wabas.list();
		const state: WabaState[] = [];

		for (const waba of wabas) {
			const phoneNumbers = await this.#repositories.phoneNumbers.listByWabaId(waba.id);

			state.push({
				id: waba.id,
				name: waba.name,
				subscribedAt: waba.subscribedAt,
				phoneNumbers: phoneNumbers.map(phoneNumber => toPhoneNumberDto(phoneNumber)),
			});
		}

		return {
			publicUrl: this.#config.publicUrl,
			app: this.#subscribedApps.identity,
			wabas: state,
			behavior: {
				statusDelays: this.#config.statusDelays,
				templateAutoApproveMs: this.#config.templateAutoApproveMs,
				// Whether the registry exists, never what is in it: the UI needs the flag to know
				// if it should render the token section at all (SPEC §1.9).
				strictTokens: this.#config.tokens !== undefined,
				mediaTtlSeconds: this.#config.mediaTtlSeconds ?? null,
			},
			webhook: {
				url: this.#config.webhookUrl ?? null,
				appSecretConfigured: this.#config.appSecret !== undefined,
				verifyTokenConfigured: this.#config.webhookVerifyToken !== undefined,
				verifyOnStart: this.#config.verifyOnStart,
				lastHandshake: this.#webhooks.lastHandshake,
			},
		};
	}
}
