import type { Readable } from "node:stream";
import type { MediaRecord, Repositories } from "../db/index.ts";
import type { MediaStorage } from "../storage/index.ts";
import { createMediaId, createMediaUrlToken, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { mediaTooLargeError, unknownObjectError } from "./meta-errors.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";

/** The upload cap (SPEC §2.6). Meta's own limits are per type; one ceiling is enough here. */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const MILLISECONDS_PER_SECOND = 1000;

/** What Meta hands back when a media id is resolved, before it is written out in snake_case. */
export interface MediaDescriptor {
	id: string;
	/** Points at whaloc's own byte endpoint, built from `WHALOC_PUBLIC_URL` (SPEC §1.7). */
	url: string;
	mimeType: string;
	sha256: string;
	fileSize: number;
}

export interface MediaServiceOptions {
	repositories: Repositories;
	storage: MediaStorage;
	/** `WHALOC_PUBLIC_URL`, already stripped of any trailing slash by the config parser. */
	publicUrl: string;
	maxBytes?: number;
	random?: RandomBytes;
	/** `WHALOC_MEDIA_TTL_SECONDS`; `undefined` — the default — means media never expires. */
	ttlSeconds?: number | undefined;
	/** The clock the TTL is measured against; injected so expiry is deterministic in tests. */
	scheduler?: Scheduler;
}

export interface UploadMediaInput {
	phoneNumberId: string;
	bytes: Uint8Array;
	mimeType: string;
}

/** The path the generated media URLs point at; mounted without a version prefix (SPEC §2.12). */
export const MEDIA_DOWNLOAD_PATH = "/whaloc-media";

/**
 * Media uploads, resolution and byte serving (SPEC §2.6, §2.12).
 *
 * The bytes go through the injected {@link MediaStorage} and the metadata through the
 * repository; nothing here knows where the files actually live.
 *
 * With `WHALOC_MEDIA_TTL_SECONDS` set, an object older than the TTL behaves like one Meta has
 * dropped (SPEC §4): the descriptor hop answers the missing-object envelope and the byte
 * endpoint 404s. The row and the bytes stay — a reset is what deletes those — so an expired id
 * keeps answering the same way instead of turning into "never existed" at some later point.
 */
export class MediaService {
	readonly #repositories: Repositories;
	readonly #storage: MediaStorage;
	readonly #publicUrl: string;
	readonly #maxBytes: number;
	readonly #random: RandomBytes;
	readonly #ttlSeconds: number | undefined;
	readonly #scheduler: Scheduler;

	constructor(options: MediaServiceOptions) {
		this.#repositories = options.repositories;
		this.#storage = options.storage;
		this.#publicUrl = options.publicUrl;
		this.#maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
		this.#random = options.random ?? defaultRandomBytes;
		this.#ttlSeconds = options.ttlSeconds;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	get maxBytes(): number {
		return this.#maxBytes;
	}

	/** `null` when media never expires. */
	get ttlSeconds(): number | null {
		return this.#ttlSeconds ?? null;
	}

	/**
	 * Whether an object has aged out. **The boundary is inclusive**: with a 5-second TTL an
	 * object is gone the moment its age reaches 5 seconds, so a test can move the clock to
	 * exactly the TTL and assert the failure.
	 */
	isExpired(media: MediaRecord): boolean {
		if (this.#ttlSeconds === undefined) {
			return false;
		}

		const uploadedAt = new Date(media.createdAt);
		const age = this.#scheduler.now().getTime() - uploadedAt.getTime();

		return age >= this.#ttlSeconds * MILLISECONDS_PER_SECOND;
	}

	/** Rejects an oversized upload (SPEC §2.6). Called twice: on `Content-Length`, then on the bytes. */
	assertWithinCap(byteLength: number): void {
		if (byteLength > this.#maxBytes) {
			throw mediaTooLargeError(this.#maxBytes);
		}
	}

	async upload(input: UploadMediaInput): Promise<MediaRecord> {
		if ((await this.#repositories.phoneNumbers.findById(input.phoneNumberId)) === null) {
			throw unknownObjectError(input.phoneNumberId);
		}

		this.assertWithinCap(input.bytes.byteLength);

		const stored = await this.#storage.put(input.bytes);

		return this.#repositories.media.insert({
			id: createMediaId(this.#random),
			phoneNumberId: input.phoneNumberId,
			mimeType: input.mimeType,
			sha256: stored.sha256,
			fileSize: stored.byteSize,
			storageKey: stored.storageKey,
			urlToken: createMediaUrlToken(this.#random),
		});
	}

	/**
	 * The descriptor with none of Meta's rules applied — no phone-number scoping, no TTL. This is
	 * the control plane's inspector view (`GET /api/media/:id`, SPEC §5): whaloc's own UI has to
	 * be able to say what a message's media id points at, including one the Graph surface has
	 * already aged out.
	 */
	descriptor(media: MediaRecord): MediaDescriptor {
		return {
			id: media.id,
			url: `${this.#publicUrl}${MEDIA_DOWNLOAD_PATH}/${media.urlToken}`,
			mimeType: media.mimeType,
			sha256: media.sha256,
			fileSize: media.fileSize,
		};
	}

	/**
	 * The two-hop download's first hop (SPEC §1.7): metadata plus a URL the consumer can fetch
	 * from another container. `phoneNumberId` is what the consumer passes as `?phone_number_id=`;
	 * media belonging to a different number is reported as missing, exactly like Meta does — and
	 * so is media past `WHALOC_MEDIA_TTL_SECONDS`, which is the **400 / code 100 / subcode 33**
	 * envelope consumers key expired-media detection on (SPEC §1.4).
	 */
	describe(media: MediaRecord, phoneNumberId?: string): MediaDescriptor {
		if (phoneNumberId !== undefined && phoneNumberId !== media.phoneNumberId) {
			throw unknownObjectError(media.id);
		}

		if (this.isExpired(media)) {
			throw unknownObjectError(media.id);
		}

		return this.descriptor(media);
	}

	/** Looks a media object up by id; `null` when nothing was ever uploaded under it. */
	async find(id: string): Promise<MediaRecord | null> {
		return this.#repositories.media.findById(id);
	}

	/**
	 * `DELETE /{mediaId}` (SPEC §2.6b) — the object is gone, bytes included.
	 *
	 * Scoped exactly like the descriptor hop: another number's media is reported missing, and so
	 * is an object past `WHALOC_MEDIA_TTL_SECONDS` — a caller cannot delete what the Graph surface
	 * has already told it does not exist. Afterwards every hop answers the same missing-object
	 * envelope (400 / 100 / 33) and the byte URL 404s, because the row and the token went with it.
	 *
	 * The bytes are deleted best-effort: a file that is already gone is not a reason to keep the
	 * row, and `MediaStorage.delete` is a no-op for a missing object anyway (SPEC §6).
	 */
	async delete(media: MediaRecord, phoneNumberId?: string): Promise<void> {
		if (phoneNumberId !== undefined && phoneNumberId !== media.phoneNumberId) {
			throw unknownObjectError(media.id);
		}

		if (this.isExpired(media)) {
			throw unknownObjectError(media.id);
		}

		await this.#storage.delete(media.storageKey);
		await this.#repositories.media.deleteById(media.id);
	}

	/**
	 * Resolves the opaque token in a public media URL; `null` when it is unknown **or expired**.
	 *
	 * The byte endpoint answers a plain 404 for `null` (SPEC §2.12) — it sits outside the Graph
	 * surface, so it carries no Meta envelope — which means an expired object and an unguessed
	 * token look the same there, exactly as they do on Meta's CDN.
	 */
	async findByUrlToken(urlToken: string): Promise<MediaRecord | null> {
		const media = await this.#repositories.media.findByUrlToken(urlToken);

		return media !== null && this.isExpired(media) ? null : media;
	}

	/** Opens the stored bytes, optionally narrowed to the inclusive range a `Range` header asked for. */
	async open(media: MediaRecord, range?: { start: number; end: number }): Promise<Readable> {
		const object = await this.#storage.get(media.storageKey, range === undefined ? {} : { range });

		return object.stream;
	}
}
