import type {
	ChangeEvent,
	MessagingLimit,
	PhoneNumberCreateRequest,
	PhoneNumberQualityEvent,
	PhoneNumberQualityRequest,
	PhoneNumberUpdateRequest,
} from "@whaloc/shared";
import type { PhoneNumberRecord, Repositories, UpdatePhoneNumberInput } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import type { MediaStorage } from "../storage/index.ts";
import type { BackgroundTasks } from "./background-tasks.ts";
import { toPhoneNumberDto } from "./control-dto.ts";
import { controlBadRequest, controlConflict, controlNotFound } from "./control-plane-error.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createPhoneNumberId, defaultRandomBytes, deriveVerificationCode, type RandomBytes } from "./ids.ts";
import { assertIdIsFree } from "./meta-id-registry.ts";
import {
	invalidParameterError,
	invalidPhoneNumberError,
	phoneNumberAlreadyExistsError,
	phoneNumberNotVerifiedError,
	unknownObjectError,
} from "./meta-errors.ts";
import { formatDisplayPhoneNumber, phoneNumberDigits } from "./phone-number-format.ts";
import { E164_PATTERN, type GraphPhoneNumberCreateRequest, type RequestCodeRequest } from "./phone-number-requests.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";
import type { WebhookEmitter } from "./webhook-emitter.ts";
import { phoneNumberQualityValue, webhookEnvelope, WEBHOOK_FIELDS } from "./webhook-payloads.ts";

/**
 * Business phone numbers: the registration ladder the Graph API walks them up (SPEC §4), the
 * runtime management the control plane offers (SPEC §5), and the `phone_number_quality_update`
 * webhook. Quality never changes by itself in whaloc — a user asks for it.
 *
 * **The two halves start from opposite ends.** A number created through
 * `POST /{wabaId}/phone_numbers` is `UNVERIFIED` and cannot send until it has been through
 * `request_code` → `verify_code` → `register`; a number that is seeded or created through the
 * control plane is `CONNECTED` from the start, because those are the "someone already onboarded
 * this" paths and every existing flow has to keep working unchanged.
 */
export interface PhoneNumberServiceOptions {
	repositories: Repositories;
	webhooks: WebhookEmitter;
	tasks: BackgroundTasks;
	/** Deleting a number deletes its media bytes, not just the rows (SPEC §5). */
	mediaStorage: MediaStorage;
	logger: Logger;
	events?: EventPublisher;
	scheduler?: Scheduler;
	random?: RandomBytes;
}

/**
 * The `event` a quality change reports when the caller does not name one. Meta picks from the
 * change itself, and so does whaloc: a throughput change is a throughput event, otherwise the
 * new rating decides.
 */
function defaultEvent(request: PhoneNumberQualityRequest): PhoneNumberQualityEvent {
	if (request.throughputLevel !== undefined) {
		return request.throughputLevel === "HIGH" ? "THROUGHPUT_UPGRADE" : "THROUGHPUT_DOWNGRADE";
	}

	switch (request.qualityRating) {
		case "GREEN": {
			return "UNFLAGGED";
		}
		case "YELLOW": {
			return "DOWNGRADE";
		}
		case "RED": {
			return "FLAGGED";
		}
		default: {
			return "ONBOARDING";
		}
	}
}

/** `current_limit` follows the throughput level unless the caller says otherwise. */
function defaultLimit(phoneNumber: PhoneNumberRecord): MessagingLimit {
	return phoneNumber.throughputLevel === "HIGH" ? "TIER_UNLIMITED" : "TIER_1K";
}

/**
 * The digits whaloc stores for a Graph create — `phone_number` has already been checked against
 * {@link E164_PATTERN}, so it is digits only by the time this runs.
 *
 * Meta takes the country code separately while its own examples pass a `phone_number` that
 * already carries it, so `cc` is prepended only when it is missing: `{cc:"1",
 * phone_number:"16315551000"}` and `{cc:"1", phone_number:"6315551000"}` land on the same digits,
 * and therefore on the same duplicate check.
 */
function e164Digits(request: GraphPhoneNumberCreateRequest): string {
	const { cc, phone_number: phoneNumber } = request;

	return cc === undefined || phoneNumber.startsWith(cc) ? phoneNumber : cc + phoneNumber;
}

export class PhoneNumberService {
	readonly #repositories: Repositories;
	readonly #webhooks: WebhookEmitter;
	readonly #tasks: BackgroundTasks;
	readonly #mediaStorage: MediaStorage;
	readonly #logger: Logger;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #random: RandomBytes;

	constructor(options: PhoneNumberServiceOptions) {
		this.#repositories = options.repositories;
		this.#webhooks = options.webhooks;
		this.#tasks = options.tasks;
		this.#mediaStorage = options.mediaStorage;
		this.#logger = options.logger;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#random = options.random ?? defaultRandomBytes;
	}

	/** Announces a change so the UI (Settings, the phone-number picker) follows along live. */
	#announce(phoneNumber: PhoneNumberRecord, event: ChangeEvent): void {
		this.#events.publish({
			type: "phone_number.changed",
			payload: { phoneNumber: toPhoneNumberDto(phoneNumber), event },
		});
	}

	/** Every route below resolves the id the same way: a miss is Meta's "object missing". */
	async #findOrThrow(phoneNumberId: string): Promise<PhoneNumberRecord> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(phoneNumberId);

		if (phoneNumber === null) {
			throw unknownObjectError(phoneNumberId);
		}

		return phoneNumber;
	}

	/** A patch that must land, announced once it has. */
	async #patch(phoneNumberId: string, patch: UpdatePhoneNumberInput): Promise<PhoneNumberRecord> {
		const updated = await this.#repositories.phoneNumbers.update(phoneNumberId, patch);

		if (updated === null) {
			throw unknownObjectError(phoneNumberId);
		}

		this.#announce(updated, "updated");

		return updated;
	}

	/**
	 * The number already holding these digits, if any — in this WABA or any other, because one
	 * MSISDN is one WhatsApp account. The comparison is on digits, so `+1 631-555-5555` and
	 * `16315555555` are the same number; the table is tiny in a dev tool, so it is read whole
	 * rather than pushed into SQL that cannot strip punctuation. `exceptId` lets an edit keep
	 * its own number.
	 */
	async #findByDigits(digits: string, exceptId?: string): Promise<PhoneNumberRecord | null> {
		const existing = await this.#repositories.phoneNumbers.list();

		return (
			existing.find(
				candidate => candidate.id !== exceptId && phoneNumberDigits(candidate.displayPhoneNumber) === digits,
			) ?? null
		);
	}

	/** The digits of a display number the control plane was handed, refusing one with none. */
	#digitsOrThrow(displayPhoneNumber: string): string {
		const digits = phoneNumberDigits(displayPhoneNumber);

		if (digits === "") {
			throw controlBadRequest(`${displayPhoneNumber} has no digits to dial`, "invalid_phone_number");
		}

		return digits;
	}

	/** Best effort: a byte file that is already gone is not a reason to fail the delete. */
	async #deleteMediaObjects(phoneNumberId: string): Promise<void> {
		const objects = await this.#repositories.media.listByPhoneNumberId(phoneNumberId);

		for (const media of objects) {
			try {
				await this.#mediaStorage.delete(media.storageKey);
			} catch (error) {
				this.#logger.warn({ err: error, storageKey: media.storageKey }, "could not delete a media object");
			}
		}
	}

	/** Same rule as the Graph 409, reported in the control plane's own error shape. */
	async #assertDigitsAreFree(digits: string, exceptId?: string): Promise<void> {
		if ((await this.#findByDigits(digits, exceptId)) !== null) {
			throw controlConflict(`${digits} is already registered on another phone number`, "duplicate_phone_number");
		}
	}

	/** {@link #patch}, for the control plane: the same update, reported in its error shape. */
	async #patchControl(phoneNumberId: string, patch: UpdatePhoneNumberInput): Promise<PhoneNumberRecord> {
		const updated = await this.#repositories.phoneNumbers.update(phoneNumberId, patch);

		if (updated === null) {
			throw controlNotFound(`no phone number with id ${phoneNumberId}`, "unknown_phone_number");
		}

		this.#announce(updated, "updated");

		return updated;
	}

	async list(): Promise<PhoneNumberRecord[]> {
		return this.#repositories.phoneNumbers.list();
	}

	// --- Graph API: the registration ladder (SPEC §2.13-§2.17, §4) --------------------------

	/**
	 * `POST /{wabaId}/phone_numbers` — a brand-new, unverified number.
	 *
	 * An unknown WABA is whaloc's uniform "object missing" envelope (400 / 100 / 33) rather than
	 * the vendored spec's 404 / 803: SPEC §1.4 makes that shape a consumer contract for *every*
	 * unknown id, and one route disagreeing would be a worse surprise than the deviation.
	 */
	async addToWaba(wabaId: string, request: GraphPhoneNumberCreateRequest): Promise<PhoneNumberRecord> {
		if ((await this.#repositories.wabas.findById(wabaId)) === null) {
			throw unknownObjectError(wabaId);
		}

		if (!E164_PATTERN.test(request.phone_number)) {
			throw invalidPhoneNumberError();
		}

		const digits = e164Digits(request);

		if (!E164_PATTERN.test(digits)) {
			throw invalidPhoneNumberError();
		}

		if ((await this.#findByDigits(digits)) !== null) {
			throw phoneNumberAlreadyExistsError();
		}

		// A pre-verified number arrives with its code already confirmed, so it starts one rung
		// up the ladder: `register` is all that is left. Everything else has to be texted a code.
		const isPreverified = request.preverified_id !== undefined;
		const created = await this.#repositories.phoneNumbers.insert({
			id: createPhoneNumberId(this.#random),
			wabaId,
			displayPhoneNumber: formatDisplayPhoneNumber(digits),
			verifiedName: request.verified_name,
			qualityRating: "UNKNOWN",
			status: isPreverified ? "PENDING" : "UNVERIFIED",
			codeVerificationStatus: isPreverified ? "VERIFIED" : "NOT_VERIFIED",
			nameStatus: "PENDING_REVIEW",
		});

		this.#announce(created, "created");

		return created;
	}

	/**
	 * `POST /{phoneNumberId}/request_code` — "texts" the code. whaloc is the phone, so the code
	 * is stored and served by the control plane instead (`GET /api/state`, the Settings view).
	 *
	 * It is accepted for a number at any rung, including a `CONNECTED` one: asking is harmless,
	 * and it is the shortest way to see the flow in the UI. Only `verify_code` moves anything.
	 */
	async requestCode(phoneNumberId: string, request: RequestCodeRequest): Promise<PhoneNumberRecord> {
		await this.#findOrThrow(phoneNumberId);

		return this.#patch(phoneNumberId, {
			pendingVerification: {
				code: deriveVerificationCode(phoneNumberId),
				method: request.code_method,
				language: request.language,
			},
		});
	}

	/**
	 * `POST /{phoneNumberId}/verify_code` — confirms the code, which takes an `UNVERIFIED`
	 * number to `PENDING`: verified, waiting to be registered.
	 */
	async verifyCode(phoneNumberId: string, code: string): Promise<PhoneNumberRecord> {
		const phoneNumber = await this.#findOrThrow(phoneNumberId);
		const { pendingVerification } = phoneNumber;

		if (pendingVerification === null) {
			throw invalidParameterError(
				"Param code has no verification to confirm: request one with POST /{phone-number-id}/request_code",
			);
		}

		if (pendingVerification.code !== code) {
			throw invalidParameterError("Param code is not the verification code sent to this phone number");
		}

		return this.#patch(phoneNumberId, {
			codeVerificationStatus: "VERIFIED",
			pendingVerification: null,
			...(phoneNumber.status === "UNVERIFIED" && { status: "PENDING" }),
		});
	}

	/**
	 * `POST /{phoneNumberId}/register` — the last rung: `CONNECTED`, and the display name is
	 * approved along with it. A number whose code was never confirmed is refused (133006).
	 */
	async register(phoneNumberId: string): Promise<PhoneNumberRecord> {
		const phoneNumber = await this.#findOrThrow(phoneNumberId);

		if (phoneNumber.codeVerificationStatus !== "VERIFIED") {
			throw phoneNumberNotVerifiedError();
		}

		return this.#patch(phoneNumberId, { status: "CONNECTED", nameStatus: "APPROVED" });
	}

	/**
	 * `POST /{phoneNumberId}/deregister` — off the Cloud API. `DISCONNECTED` is the closest of
	 * the vendored spec's statuses: the number still exists and stays verified, it just cannot
	 * send until it is registered again (sends answer 133010 meanwhile).
	 */
	async deregister(phoneNumberId: string): Promise<PhoneNumberRecord> {
		await this.#findOrThrow(phoneNumberId);

		return this.#patch(phoneNumberId, { status: "DISCONNECTED" });
	}

	// --- Control plane (SPEC §5) ------------------------------------------------------------

	/**
	 * `POST /api/phone-numbers` — adds a number to a WABA at runtime, ready to use:
	 * `CONNECTED` and `VERIFIED`, like a seeded one.
	 *
	 * An explicit `id` is honored, the way {@link WabaService.create} honors one: an app whose
	 * configuration already names a phone number id can be pointed at whaloc without editing it.
	 * The Graph-side `POST /{wabaId}/phone_numbers` deliberately gains nothing of the sort — it is
	 * Meta's own request shape, and Meta assigns the id.
	 */
	async create(input: PhoneNumberCreateRequest): Promise<PhoneNumberRecord> {
		if ((await this.#repositories.wabas.findById(input.wabaId)) === null) {
			throw controlNotFound(`no WABA with id ${input.wabaId}`, "unknown_waba");
		}

		await this.#assertDigitsAreFree(this.#digitsOrThrow(input.displayPhoneNumber));

		const id = input.id ?? createPhoneNumberId(this.#random);

		await assertIdIsFree(this.#repositories, id, "duplicate_phone_number");

		const created = await this.#repositories.phoneNumbers.insert({
			id,
			wabaId: input.wabaId,
			displayPhoneNumber: input.displayPhoneNumber,
			verifiedName: input.verifiedName,
			...(input.qualityRating !== undefined && { qualityRating: input.qualityRating }),
			...(input.throughputLevel !== undefined && { throughputLevel: input.throughputLevel }),
		});

		this.#announce(created, "created");

		return created;
	}

	/** `PATCH /api/phone-numbers/:id` — fix a display number or a verified name. */
	async update(phoneNumberId: string, input: PhoneNumberUpdateRequest): Promise<PhoneNumberRecord> {
		if ((await this.#repositories.phoneNumbers.findById(phoneNumberId)) === null) {
			throw controlNotFound(`no phone number with id ${phoneNumberId}`, "unknown_phone_number");
		}

		if (input.displayPhoneNumber !== undefined) {
			await this.#assertDigitsAreFree(this.#digitsOrThrow(input.displayPhoneNumber), phoneNumberId);
		}

		return this.#patchControl(phoneNumberId, input);
	}

	/**
	 * `DELETE /api/phone-numbers/:id` — the number and everything hanging off it.
	 *
	 * The schema cascades the message and media *rows*; the media **bytes** are deleted here,
	 * for the same reason `POST /api/reset` deletes them: a delete that left files behind in
	 * `WHALOC_MEDIA_DIR` would be quietly untrue. Called by {@link WabaService} too, so a WABA
	 * delete reaches the same corners.
	 */
	async delete(phoneNumberId: string): Promise<PhoneNumberRecord> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(phoneNumberId);

		if (phoneNumber === null) {
			throw controlNotFound(`no phone number with id ${phoneNumberId}`, "unknown_phone_number");
		}

		await this.#deleteMediaObjects(phoneNumberId);
		await this.#repositories.phoneNumbers.deleteById(phoneNumberId);
		this.#announce(phoneNumber, "deleted");

		return phoneNumber;
	}

	/**
	 * Sets the stored quality rating and throughput, and — when asked — announces it with the
	 * webhook Meta sends when it changes its mind about a number.
	 */
	async updateQuality(phoneNumberId: string, request: PhoneNumberQualityRequest): Promise<PhoneNumberRecord> {
		const previous = await this.#repositories.phoneNumbers.findById(phoneNumberId);

		if (previous === null) {
			throw controlNotFound(`no phone number with id ${phoneNumberId}`, "unknown_phone_number");
		}

		const updated = await this.#patchControl(phoneNumberId, {
			...(request.qualityRating !== undefined && { qualityRating: request.qualityRating }),
			...(request.throughputLevel !== undefined && { throughputLevel: request.throughputLevel }),
		});

		if (request.emitWebhook) {
			const currentLimit = request.currentLimit ?? defaultLimit(updated);
			// `old_limit` rides only on an actual messaging-limit change, which is what Meta says
			// about it — a quality-only update leaves the tier alone and sends no `old_limit`.
			const previousLimit = defaultLimit(previous);
			const value = phoneNumberQualityValue({
				phoneNumber: updated,
				event: request.event ?? defaultEvent(request),
				currentLimit,
				...(previousLimit !== currentLimit && { oldLimit: previousLimit }),
				// The portfolio limit Meta is migrating to; same tier, sent alongside the field it
				// replaces so a consumer reading either spelling gets the same answer.
				maxDailyConversationsPerBusiness: currentLimit,
			});

			this.#tasks.run(() => {
				return this.#webhooks.emit(
					WEBHOOK_FIELDS.phoneNumberQuality,
					webhookEnvelope({
						wabaId: updated.wabaId,
						field: WEBHOOK_FIELDS.phoneNumberQuality,
						value,
						time: this.#scheduler.now(),
					}),
				);
			});
		}

		return updated;
	}
}
