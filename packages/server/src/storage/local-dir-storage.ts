import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { measureWhileStreaming } from "./measure-stream.ts";
import {
	assertValidStorageKey,
	InvalidStorageKeyError,
	MediaObjectNotFoundError,
	SHA256_DIGEST_ENCODING,
	type GetMediaOptions,
	type MediaObject,
	type MediaStorage,
	type PutMediaOptions,
	type StoredMedia,
} from "./media-storage.ts";

export interface LocalDirStorageOptions {
	/** `WHALOC_MEDIA_DIR`; created on demand, on the first upload. */
	rootDir: string;
	/** Key factory, injectable so tests get predictable filenames. */
	createKey?: () => string;
}

const KEY_RANDOM_BYTES = 16;

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Flat, hex-only filenames: always valid keys, never a directory to traverse into. */
function createRandomKey(): string {
	return randomBytes(KEY_RANDOM_BYTES).toString("hex");
}

/**
 * Waits for a write stream to be completely done with its file descriptor.
 *
 * `pipeline` rejects as soon as the **source** fails, while the destination may still be inside
 * the `open()` its `_construct` hook started — and that `open()` creates the file. Deleting
 * before it lands leaves a zero-byte object behind: the `rm` runs first, the descriptor opens
 * second. `finished()` resolves once the stream is closed (or errored), which is after
 * `_destroy` has closed the descriptor, so the delete that follows it always has something to
 * delete. The error is discarded on purpose — the caller re-throws the one `pipeline` gave it,
 * which describes what actually went wrong.
 */
async function whenClosed(target: WriteStream): Promise<void> {
	try {
		await finished(target);
	} catch {
		// Already reported by `pipeline`; this await is only here to sequence the delete.
	}
}

/**
 * The `MediaStorage` that ships today: one flat directory of opaque files (SPEC §6). The
 * directory is created lazily so a whaloc that never receives an upload leaves no trace.
 */
export class LocalDirStorage implements MediaStorage {
	readonly #rootDir: string;
	readonly #createKey: () => string;

	constructor(options: LocalDirStorageOptions) {
		this.#rootDir = path.resolve(options.rootDir);
		this.#createKey = options.createKey ?? createRandomKey;
	}

	/**
	 * Turns a key into a path inside the root, twice over: the key alphabet already excludes
	 * separators and leading dots, and the resolved path is checked to still be under the root.
	 */
	#filePathOf(storageKey: string): string {
		assertValidStorageKey(storageKey);

		const filePath = path.resolve(this.#rootDir, storageKey);

		if (!filePath.startsWith(this.#rootDir + path.sep) || path.basename(filePath) !== storageKey) {
			throw new InvalidStorageKeyError(storageKey);
		}

		return filePath;
	}

	async put(source: Readable | Uint8Array, options: PutMediaOptions = {}): Promise<StoredMedia> {
		const storageKey = options.key ?? this.#createKey();
		const filePath = this.#filePathOf(storageKey);
		const hash = createHash("sha256");
		const input = source instanceof Uint8Array ? Readable.from([source]) : source;
		let byteSize = 0;

		await mkdir(this.#rootDir, { recursive: true });

		const target = createWriteStream(filePath);

		try {
			await pipeline(
				input,
				measureWhileStreaming(hash, byteLength => (byteSize += byteLength)),
				target,
			);
		} catch (error) {
			// A half-written object is worse than none: the caller never learns its key, so the
			// bytes must not survive either. The rendezvous is what makes that true every time
			// rather than most of the time — see {@link whenClosed}.
			await whenClosed(target);
			await this.delete(storageKey);

			throw error;
		}

		return { storageKey, sha256: hash.digest(SHA256_DIGEST_ENCODING), byteSize };
	}

	async get(storageKey: string, options: GetMediaOptions = {}): Promise<MediaObject> {
		const filePath = this.#filePathOf(storageKey);

		let size: number;

		try {
			({ size } = await stat(filePath));
		} catch (error) {
			if (isNotFound(error)) {
				throw new MediaObjectNotFoundError(storageKey, { cause: error });
			}

			throw error;
		}

		const stream =
			options.range === undefined
				? createReadStream(filePath)
				: createReadStream(filePath, { start: options.range.start, end: options.range.end });

		return { stream, size };
	}

	async delete(storageKey: string): Promise<void> {
		await rm(this.#filePathOf(storageKey), { force: true });
	}
}

export function createLocalDirStorage(options: LocalDirStorageOptions): MediaStorage {
	return new LocalDirStorage(options);
}
