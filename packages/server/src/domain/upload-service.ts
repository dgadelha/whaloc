import type { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { Repositories, UploadSessionRecord } from "../db/index.ts";
import { MediaObjectNotFoundError, type MediaStorage } from "../storage/index.ts";
import {
	createMediaUrlToken,
	createUploadHandle,
	createUploadSessionId,
	defaultRandomBytes,
	UPLOAD_SESSION_PREFIX,
	type RandomBytes,
} from "./ids.ts";
import {
	invalidParameterError,
	invalidUploadOffsetError,
	unknownObjectError,
	uploadTooLongError,
} from "./meta-errors.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";

/**
 * Meta's **Resumable Upload API** (SPEC §2.21) — where real `header_handle`s come from.
 *
 * Three calls, all under the version prefix:
 *
 * 1. `POST /{appId}/uploads?file_length=&file_type=&file_name=` opens a session and answers
 *    `{"id":"upload:<opaque>"}`.
 * 2. `POST /upload:<opaque>` with `file_offset: 0` and the raw bytes as the body stores them and
 *    answers `{"h":"<handle>"}`.
 * 3. `GET /upload:<opaque>` reports `{"id":"upload:<opaque>","file_offset":<received>}`, which is
 *    how a client that lost its connection finds out where to carry on.
 *
 * Two decisions worth knowing about:
 *
 * - **The offset is truthful, and a chunk must land exactly on it.** A session is only complete
 *   when `received_bytes` reaches the `file_length` it was opened with, and only then does it get
 *   a handle. A `file_offset` that is not the current one is `(#100)` rather than a silent
 *   overwrite, because a resumable upload that quietly loses a chunk is the bug this models.
 * - **A chunk that is not the whole file is stored by rewriting the object.** whaloc reads what
 *   it already has, concatenates, and puts the result back under the same storage key; the common
 *   case — one POST at offset 0 carrying everything — never does that, and the alternative
 *   (append-only storage) would mean a second interface on `MediaStorage` for a dev tool whose
 *   uploads are a handful of test images. It is O(n²) in the number of chunks, which is fine at
 *   these sizes, and it means a **partially** uploaded session survives a restart just like a
 *   completed one.
 */

/** Whatever the caller wrote when it opened a session; only the length and the type are load-bearing. */
export interface CreateUploadSessionInput {
	appId: string;
	fileLength: number;
	fileType: string;
	fileName?: string | undefined;
}

/** What `GET /upload:<id>` answers with. */
export interface UploadSessionStatus {
	id: string;
	fileOffset: number;
}

/** The upload behind a handle, as the control plane and the profile/template surfaces see it. */
export interface UploadDescriptor {
	handle: string;
	/** Points at whaloc's own byte endpoint, built from `WHALOC_PUBLIC_URL` (SPEC §2.22). */
	url: string;
	mimeType: string;
	sha256: string;
	fileSize: number;
	fileName: string | null;
	createdAt: string;
}

export interface UploadServiceOptions {
	repositories: Repositories;
	storage: MediaStorage;
	/** `WHALOC_PUBLIC_URL`, already stripped of any trailing slash by the config parser. */
	publicUrl: string;
	/** The id `subscribed_apps` reports; a session may also be opened under any other digit id. */
	appId: string;
	maxBytes: number;
	random?: RandomBytes;
	scheduler?: Scheduler;
}

/** The path a handle's bytes are served under; mounted without a version prefix (SPEC §2.22). */
export const UPLOAD_DOWNLOAD_PATH = "/whaloc-upload";

/** Meta app ids are digit-only, like every other object id. */
const APP_ID_PATTERN = /^\d{1,32}$/;

/** The session id in a `upload:<opaque>` path segment, or `null` when the segment is not one. */
export function parseUploadSessionId(segment: string): string | null {
	return segment.startsWith(UPLOAD_SESSION_PREFIX) ? segment.slice(UPLOAD_SESSION_PREFIX.length) : null;
}

/** The full id whaloc hands out and a caller puts back in the path. */
export function uploadSessionIdOf(session: UploadSessionRecord): string {
	return UPLOAD_SESSION_PREFIX + session.id;
}

export class UploadService {
	readonly #repositories: Repositories;
	readonly #storage: MediaStorage;
	readonly #publicUrl: string;
	readonly #appId: string;
	readonly #maxBytes: number;
	readonly #random: RandomBytes;
	readonly #scheduler: Scheduler;

	constructor(options: UploadServiceOptions) {
		this.#repositories = options.repositories;
		this.#storage = options.storage;
		this.#publicUrl = options.publicUrl;
		this.#appId = options.appId;
		this.#maxBytes = options.maxBytes;
		this.#random = options.random ?? defaultRandomBytes;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	/**
	 * Which `{appId}` may open a session.
	 *
	 * **whaloc's own app id, or any digit-only id** (SPEC §2.21). Meta scopes an upload to the
	 * Meta app that made it, and an app under test is configured with a `META_APP_ID` that has no
	 * reason to equal `WHALOC_APP_ID` — refusing it would be an obstacle with nothing behind it,
	 * since whaloc has one app and every session belongs to it either way. Anything that is *not*
	 * an id at all is still `(#100)`, so a path typo does not silently open a session.
	 */
	#assertAppId(appId: string): void {
		if (appId !== this.#appId && !APP_ID_PATTERN.test(appId)) {
			throw invalidParameterError(`Param app id (${appId}) must be a Meta app id, a string of 1-32 digits`);
		}
	}

	async #findOrThrow(sessionId: string): Promise<UploadSessionRecord> {
		const session = await this.#repositories.uploadSessions.findById(sessionId);

		if (session === null) {
			throw unknownObjectError(UPLOAD_SESSION_PREFIX + sessionId);
		}

		return session;
	}

	/** The bytes already stored under this session, or an empty buffer before the first chunk. */
	async #stored(session: UploadSessionRecord): Promise<Buffer> {
		if (session.storageKey === null || session.receivedBytes === 0) {
			return Buffer.alloc(0);
		}

		try {
			const object = await this.#storage.get(session.storageKey);

			return await buffer(object.stream);
		} catch (error) {
			if (error instanceof MediaObjectNotFoundError) {
				// The row says bytes arrived and storage disagrees — a `WHALOC_MEDIA_DIR` someone
				// emptied by hand. Starting over is the only honest answer left.
				return Buffer.alloc(0);
			}

			throw error;
		}
	}

	/** `POST /{appId}/uploads` — opens a session (SPEC §2.21). */
	async createSession(input: CreateUploadSessionInput): Promise<UploadSessionRecord> {
		this.#assertAppId(input.appId);

		if (!Number.isSafeInteger(input.fileLength) || input.fileLength <= 0) {
			throw invalidParameterError("Param file_length must be a whole number of bytes greater than zero");
		}

		if (input.fileLength > this.#maxBytes) {
			throw invalidParameterError(
				`Param file_length must be at most ${String(this.#maxBytes)} bytes, the upload cap of this instance`,
			);
		}

		if (input.fileType.trim() === "") {
			throw invalidParameterError("Param file_type is required and must be a MIME type such as image/jpeg");
		}

		return this.#repositories.uploadSessions.insert({
			id: createUploadSessionId(this.#random),
			appId: input.appId,
			fileType: input.fileType.trim(),
			fileLength: input.fileLength,
			...(input.fileName !== undefined && input.fileName !== "" && { fileName: input.fileName }),
			createdAt: this.#scheduler.now().toISOString(),
		});
	}

	/** `GET /upload:<id>` — how far along the session is, truthfully. */
	async status(sessionId: string): Promise<UploadSessionStatus> {
		const session = await this.#findOrThrow(sessionId);

		return { id: uploadSessionIdOf(session), fileOffset: session.receivedBytes };
	}

	/**
	 * `POST /upload:<id>` — stores a chunk at `fileOffset` and, when it completes the session,
	 * mints the handle. Re-posting a completed session's last chunk is not a resume: a session
	 * that already has a handle answers with the one it has, which keeps the call idempotent for
	 * a client that never saw the response.
	 */
	async append(sessionId: string, fileOffset: number, bytes: Uint8Array): Promise<UploadSessionRecord> {
		const session = await this.#findOrThrow(sessionId);

		if (session.handle !== null) {
			return session;
		}

		if (fileOffset !== session.receivedBytes) {
			throw invalidUploadOffsetError(session.receivedBytes, fileOffset);
		}

		const received = session.receivedBytes + bytes.byteLength;

		if (received > session.fileLength) {
			throw uploadTooLongError(session.fileLength, received);
		}

		const existing = await this.#stored(session);
		const combined = existing.byteLength === 0 ? Buffer.from(bytes) : Buffer.concat([existing, bytes]);
		const stored = await this.#storage.put(combined, session.storageKey === null ? {} : { key: session.storageKey });
		const isComplete = stored.byteSize >= session.fileLength;
		const updated = await this.#repositories.uploadSessions.update(session.id, {
			receivedBytes: stored.byteSize,
			storageKey: stored.storageKey,
			sha256: stored.sha256,
			...(isComplete && {
				handle: createUploadHandle(session.fileType, this.#random),
				urlToken: createMediaUrlToken(this.#random),
			}),
			updatedAt: this.#scheduler.now().toISOString(),
		});

		if (updated === null) {
			throw unknownObjectError(UPLOAD_SESSION_PREFIX + sessionId);
		}

		return updated;
	}

	/** The upload a handle names, or `null` when nothing finished under it. */
	async findByHandle(handle: string): Promise<UploadSessionRecord | null> {
		const session = await this.#repositories.uploadSessions.findByHandle(handle);

		return session?.handle === null ? null : session;
	}

	/** Resolves the opaque token in a public upload URL (SPEC §2.22). */
	async findByUrlToken(urlToken: string): Promise<UploadSessionRecord | null> {
		return this.#repositories.uploadSessions.findByUrlToken(urlToken);
	}

	/** The byte URL of a completed session; `null` while it is still being filled. */
	url(session: UploadSessionRecord): string | null {
		return session.urlToken === null ? null : `${this.#publicUrl}${UPLOAD_DOWNLOAD_PATH}/${session.urlToken}`;
	}

	/** The descriptor the control plane serves, so the UI can preview a template's header media. */
	descriptor(session: UploadSessionRecord): UploadDescriptor | null {
		const url = this.url(session);

		if (url === null || session.handle === null) {
			return null;
		}

		return {
			handle: session.handle,
			url,
			mimeType: session.fileType,
			sha256: session.sha256 ?? "",
			fileSize: session.receivedBytes,
			fileName: session.fileName,
			createdAt: session.createdAt,
		};
	}

	/** Opens a completed upload's bytes, optionally narrowed to a `Range`. */
	async open(session: UploadSessionRecord, range?: { start: number; end: number }): Promise<Readable> {
		if (session.storageKey === null) {
			throw new MediaObjectNotFoundError(uploadSessionIdOf(session));
		}

		const object = await this.#storage.get(session.storageKey, range === undefined ? {} : { range });

		return object.stream;
	}
}
