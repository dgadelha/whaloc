import type { AccountUpdateRequest, BusinessCapabilityUpdateRequest } from "@whaloc/shared";
import type { PhoneNumberRecord, Repositories, WebhookDeliveryRecord } from "../db/index.ts";
import { controlBadRequest, controlNotFound } from "./control-plane-error.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";
import type { WebhookEmitter } from "./webhook-emitter.ts";
import { accountUpdateValue, businessCapabilityValue, webhookEnvelope, WEBHOOK_FIELDS } from "./webhook-payloads.ts";

/**
 * The two account-level webhooks (SPEC §3, §5): `account_update` and
 * `business_capability_update`.
 *
 * **Both are pure emissions.** Nothing in whaloc changes when one goes out — there is no
 * "restricted" flag behind `ACCOUNT_RESTRICTION`, no ban behind `ACCOUNT_VIOLATION`, and no quota
 * behind the capability numbers. That is deliberate: what a consumer has to get right is its
 * *handler*, and inventing state Meta would then contradict (a whaloc that refused to send while
 * "restricted" is a whaloc that lies about why) would cost more than it buys. Every other webhook
 * whaloc sends describes something it actually did; these two describe something Meta decided.
 *
 * They answer with the delivery attempts, like `POST /api/webhook/raw`, so the caller sees
 * whether the receiver took it without going back to the delivery log.
 */
export interface AccountEventServiceOptions {
	repositories: Repositories;
	webhooks: WebhookEmitter;
	scheduler?: Scheduler;
}

export class AccountEventService {
	readonly #repositories: Repositories;
	readonly #webhooks: WebhookEmitter;
	readonly #scheduler: Scheduler;

	constructor(options: AccountEventServiceOptions) {
		this.#repositories = options.repositories;
		this.#webhooks = options.webhooks;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	/** `entry.id` is the WABA, so it has to exist — an event about nothing is a typo, not a test. */
	async #assertWabaExists(wabaId: string): Promise<void> {
		if ((await this.#repositories.wabas.findById(wabaId)) === null) {
			throw controlNotFound(`no WABA with id ${wabaId}`, "unknown_waba");
		}
	}

	/** The number a notice names, checked against the WABA it is being sent for. */
	async #phoneNumber(wabaId: string, phoneNumberId: string): Promise<PhoneNumberRecord> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(phoneNumberId);

		if (phoneNumber === null) {
			throw controlNotFound(`no phone number with id ${phoneNumberId}`, "unknown_phone_number");
		}

		if (phoneNumber.wabaId !== wabaId) {
			throw controlBadRequest(
				`phone number ${phoneNumberId} belongs to another WABA than ${wabaId}`,
				"phone_number_waba_mismatch",
			);
		}

		return phoneNumber;
	}

	async emitAccountUpdate(request: AccountUpdateRequest): Promise<WebhookDeliveryRecord[]> {
		await this.#assertWabaExists(request.wabaId);

		const phoneNumber =
			request.phoneNumberId === undefined ? undefined : await this.#phoneNumber(request.wabaId, request.phoneNumberId);
		const value = accountUpdateValue({
			...(phoneNumber !== undefined && { phoneNumber }),
			event: request.event,
			...(request.restrictionInfo !== undefined && {
				restrictionInfo: request.restrictionInfo.map(entry => {
					return {
						restrictionType: entry.restrictionType,
						...(entry.expiration !== undefined && { expiration: entry.expiration }),
					};
				}),
			}),
		});

		return this.#webhooks.emit(
			WEBHOOK_FIELDS.accountUpdate,
			webhookEnvelope({
				wabaId: request.wabaId,
				field: WEBHOOK_FIELDS.accountUpdate,
				value,
				time: this.#scheduler.now(),
			}),
		);
	}

	async emitBusinessCapabilityUpdate(request: BusinessCapabilityUpdateRequest): Promise<WebhookDeliveryRecord[]> {
		await this.#assertWabaExists(request.wabaId);

		const value = businessCapabilityValue({
			maxDailyConversationPerPhone: request.maxDailyConversationPerPhone,
			maxPhoneNumbersPerBusiness: request.maxPhoneNumbersPerBusiness,
		});

		return this.#webhooks.emit(
			WEBHOOK_FIELDS.businessCapabilityUpdate,
			webhookEnvelope({
				wabaId: request.wabaId,
				field: WEBHOOK_FIELDS.businessCapabilityUpdate,
				value,
				time: this.#scheduler.now(),
			}),
		);
	}
}
