import type { Readable } from "node:stream";

/**
 * Where media bytes live (SPEC §6). Nothing outside this module touches the filesystem — or the
 * bucket — which is what makes the two backends drop-in replacements for each other.
 */
export interface MediaStorage {
	/**
	 * Stores an upload and reports what went in. The hash and the byte count are measured
	 * while the bytes stream past, so a 100 MiB upload is never held in memory.
	 */
	put: (source: Readable | Uint8Array, options?: PutMediaOptions) => Promise<StoredMedia>;
	/** Opens a stored object for reading. Throws {@link MediaObjectNotFoundError} when it is gone. */
	get: (storageKey: string, options?: GetMediaOptions) => Promise<MediaObject>;
	/** Removes a stored object. Deleting something that is not there is not an error. */
	delete: (storageKey: string) => Promise<void>;
	/**
	 * Releases whatever the implementation holds open, on shutdown. Optional: a directory holds
	 * nothing, while an S3 client keeps keep-alive sockets that would otherwise sit there until
	 * the shutdown timeout gives up on them.
	 */
	close?: () => void | Promise<void>;
}

export interface PutMediaOptions {
	/** Storage key to write to. Generated when omitted, which is the usual case. */
	key?: string;
}

/**
 * How the SHA-256 of a stored object is written down.
 *
 * **Base64, because that is what Meta sends.** The digest surfaces in three places a consumer
 * reads — the `sha256` of an inbound webhook's media node, the descriptor `GET /{media-id}`
 * answers, and the control plane's inspector view — and Meta writes all of them base64
 * (`SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=`). A consumer that base64-decodes the value to
 * compare it against its own hash of the downloaded bytes is doing the obvious thing, and hex
 * would hand it 64 bytes of garbage.
 *
 * It is only ever a value, never a key or a path segment, so the `+`, `/` and `=` in the
 * alphabet cost nothing — storage keys are generated separately and stay inside
 * {@link STORAGE_KEY_PATTERN}.
 */
export const SHA256_DIGEST_ENCODING = "base64";

export interface StoredMedia {
	/** Handle to store in the `media` table; opaque to everything above this module. */
	storageKey: string;
	/** Base64 SHA-256 of the stored bytes — what `GET /{media-id}` reports (SPEC §1.7). */
	sha256: string;
	byteSize: number;
}

export interface GetMediaOptions {
	/** Inclusive byte range, for the `Range` requests the consumer makes (SPEC §1.7). */
	range?: { start: number; end: number };
}

export interface MediaObject {
	/** The bytes, narrowed to `options.range` when one was given. */
	stream: Readable;
	/** Size of the whole object, regardless of any range. */
	size: number;
}

/**
 * Storage keys end up as path segments, so they are restricted to a conservative alphabet
 * that cannot escape the storage root: no slashes, no leading dot, nothing to traverse with.
 */
export const STORAGE_KEY_PATTERN = /^[\dA-Za-z][\w.-]{0,127}$/;

export class InvalidStorageKeyError extends Error {
	readonly storageKey: string;

	constructor(storageKey: string, options?: ErrorOptions) {
		super(`invalid media storage key: ${JSON.stringify(storageKey)}`, options);
		this.name = "InvalidStorageKeyError";
		this.storageKey = storageKey;
	}
}

export class MediaObjectNotFoundError extends Error {
	readonly storageKey: string;

	constructor(storageKey: string, options?: { cause?: unknown }) {
		super(`no media object stored under ${JSON.stringify(storageKey)}`, options);
		this.name = "MediaObjectNotFoundError";
		this.storageKey = storageKey;
	}
}

export function assertValidStorageKey(storageKey: string): void {
	if (!STORAGE_KEY_PATTERN.test(storageKey)) {
		throw new InvalidStorageKeyError(storageKey);
	}
}
