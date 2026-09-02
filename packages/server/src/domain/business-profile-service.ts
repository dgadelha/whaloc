import { businessProfileSchema, type BusinessProfile } from "@whaloc/shared";
import type { PhoneNumberRecord, Repositories } from "../db/index.ts";
import type { BusinessProfilePatch } from "./business-profile-requests.ts";
import { toPhoneNumberDto } from "./control-dto.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import type { MediaService } from "./media-service.ts";
import { invalidParameterError, unknownObjectError } from "./meta-errors.ts";
import type { UploadService } from "./upload-service.ts";

export interface BusinessProfileServiceOptions {
	repositories: Repositories;
	/** Resolves a `profile_picture_handle` given as a whaloc media id. */
	media: MediaService;
	/** Resolves one given as a **resumable-upload handle**, which is where Meta's come from. */
	uploads: UploadService;
	events?: EventPublisher;
}

/**
 * The business profile a phone number publishes (SPEC §2.19).
 *
 * Two decisions worth knowing about:
 *
 * - **An update is a merge.** Only the fields the request carries change, which is Meta's own
 *   behavior; an empty string (or empty array) **clears** a field, so the UI's form can post
 *   every input and end up with exactly what is on screen.
 * - **`profile_picture_handle` takes a real handle *or* a whaloc media id.** Meta's handle comes
 *   from the Resumable Upload API, which whaloc now models (SPEC §2.21), so a consumer that runs
 *   the real three-call flow works unchanged. A **media id** from
 *   `POST /{phoneNumberId}/media` keeps being accepted alongside it: it is one call instead of
 *   three, it is what whaloc's own docs and scripts have always used, and refusing it now would
 *   break setups for nothing. Either way `profile_picture_url` points at whaloc's own byte
 *   endpoint (SPEC §1.7, §2.22) so the app under test can fetch the picture. A value that
 *   resolves to neither — or to another number's media — is refused rather than silently
 *   dropped: a profile picture that does not exist is exactly the bug this emulator is for.
 */
export class BusinessProfileService {
	readonly #repositories: Repositories;
	readonly #media: MediaService;
	readonly #uploads: UploadService;
	readonly #events: EventPublisher;

	constructor(options: BusinessProfileServiceOptions) {
		this.#repositories = options.repositories;
		this.#media = options.media;
		this.#uploads = options.uploads;
		this.#events = options.events ?? noopEventPublisher;
	}

	async #phoneNumber(phoneNumberId: string): Promise<PhoneNumberRecord> {
		const phoneNumber = await this.#repositories.phoneNumbers.findById(phoneNumberId);

		if (phoneNumber === null) {
			throw unknownObjectError(phoneNumberId);
		}

		return phoneNumber;
	}

	/**
	 * The URL a `profile_picture_handle` publishes, or `undefined` when it clears the picture.
	 *
	 * A resumable-upload handle is tried first — it is Meta's own currency here, and it is not
	 * scoped to a phone number, because an upload session belongs to the *app* rather than to a
	 * number. A whaloc media id still resolves, and still only for the number that uploaded it.
	 */
	async #profilePictureUrl(phoneNumberId: string, handle: string): Promise<string | undefined> {
		if (handle === "") {
			return undefined;
		}

		const upload = await this.#uploads.findByHandle(handle);

		if (upload !== null) {
			return this.#uploads.url(upload) ?? undefined;
		}

		const media = await this.#media.find(handle);

		if (media === null || media.phoneNumberId !== phoneNumberId) {
			throw invalidParameterError(
				`Param profile_picture_handle (${handle}) is neither an upload handle nor a media object ` +
					"uploaded to this phone number",
			);
		}

		// `descriptor`, not `describe`: this only needs the byte URL, and a handle is accepted on
		// the strength of who uploaded it, not on how long ago (SPEC §4's media TTL).
		return this.#media.descriptor(media).url;
	}

	/**
	 * Folds a patch into the stored profile.
	 *
	 * Two rules, applied to every field the same way: `??` means **absent leaves it alone**, and
	 * a value that is empty — `""` or `[]` — is dropped rather than stored, which is what makes
	 * a blank field a *clear*.
	 */
	async #merge(phoneNumber: PhoneNumberRecord, patch: BusinessProfilePatch): Promise<Record<string, unknown>> {
		const current = phoneNumber.businessProfile;
		const profilePictureUrl =
			patch.profilePictureHandle === undefined
				? current.profilePictureUrl
				: await this.#profilePictureUrl(phoneNumber.id, patch.profilePictureHandle);
		const fields: [string, string | string[] | undefined][] = [
			["about", patch.about ?? current.about],
			["address", patch.address ?? current.address],
			["description", patch.description ?? current.description],
			["email", patch.email ?? current.email],
			["vertical", patch.vertical ?? current.vertical],
			["websites", patch.websites?.filter(website => website !== "") ?? current.websites],
			["profilePictureUrl", profilePictureUrl],
		];
		const merged: Record<string, unknown> = {};

		for (const [field, value] of fields) {
			const isEmpty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

			if (!isEmpty) {
				merged[field] = value;
			}
		}

		return merged;
	}

	/** `GET /{phoneNumberId}/whatsapp_business_profile`; `{}` for a number that has no profile. */
	async get(phoneNumberId: string): Promise<BusinessProfile> {
		const phoneNumber = await this.#phoneNumber(phoneNumberId);

		return phoneNumber.businessProfile;
	}

	/**
	 * `POST /{phoneNumberId}/whatsapp_business_profile`, and the control plane's form behind it.
	 * The updated number is announced as `phone_number.changed`, so the UI reflects a profile the
	 * app under test posted without being asked.
	 */
	async update(phoneNumberId: string, patch: BusinessProfilePatch): Promise<PhoneNumberRecord> {
		const phoneNumber = await this.#phoneNumber(phoneNumberId);
		const merged = await this.#merge(phoneNumber, patch);
		const parsed = businessProfileSchema.safeParse(merged);

		if (!parsed.success) {
			// The route's schema already checked every field, so this only fires on a value the
			// stored profile could not hold — a vertical whaloc does not know, say.
			throw invalidParameterError(parsed.error.issues.map(issue => issue.message).join("; "));
		}

		const updated = await this.#repositories.phoneNumbers.update(phoneNumberId, { businessProfile: parsed.data });

		if (updated === null) {
			throw unknownObjectError(phoneNumberId);
		}

		this.#events.publish({
			type: "phone_number.changed",
			payload: { phoneNumber: toPhoneNumberDto(updated), event: "updated" },
		});

		return updated;
	}
}
