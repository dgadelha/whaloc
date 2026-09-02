import {
	DeleteObjectCommand,
	GetObjectCommand,
	S3Client,
	type GetObjectCommandOutput,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { measureWhileStreaming } from "./measure-stream.ts";
import {
	assertValidStorageKey,
	MediaObjectNotFoundError,
	SHA256_DIGEST_ENCODING,
	type GetMediaOptions,
	type MediaObject,
	type MediaStorage,
	type PutMediaOptions,
	type StoredMedia,
} from "./media-storage.ts";

/**
 * The S3-compatible `MediaStorage` (SPEC §6): the same contract as `LocalDirStorage`, against a
 * bucket instead of a directory, so whaloc can share media between replicas — or just keep the
 * bytes somewhere a `docker run --rm` cannot lose.
 *
 * **The `@aws-sdk` dependency stops here.** Nothing above the storage module knows whether the
 * bytes are on disk or in a bucket; that is the whole point of the interface, and it is what
 * lets a snapshot exported from a local-backed whaloc be imported into an S3-backed one.
 *
 * Tested against **MinIO** (see `s3-storage.spec.ts`), which is also what CI runs — an
 * S3-compatible server is the realistic target here, and anything MinIO and AWS both honor is
 * the subset whaloc uses: `PutObject`, multipart upload, ranged `GetObject`, `DeleteObject`.
 */
export interface S3MediaStorageOptions {
	/** `WHALOC_S3_BUCKET`. It must already exist: whaloc never creates one. */
	bucket: string;
	/** `WHALOC_S3_REGION`; any value will do for MinIO, but the SDK insists on having one. */
	region: string;
	/** `WHALOC_S3_ENDPOINT` — set for MinIO, R2 or any other S3-compatible server. */
	endpoint?: string | undefined;
	/** Path-style addressing (`<endpoint>/<bucket>/<key>`), which is what MinIO serves. */
	forcePathStyle?: boolean;
	/** Omitted, the SDK's default credential chain applies (profile, IMDS, env, …). */
	credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
	/** Key factory, injectable so tests get predictable object names. */
	createKey?: () => string;
	/** A ready-made client, for tests that want to point one somewhere else. */
	client?: S3Client;
}

const KEY_RANDOM_BYTES = 16;

/**
 * Multipart threshold and part size for a streamed upload. 5 MiB is S3's minimum part size;
 * anything smaller than one part is sent as a single `PutObject` by `lib-storage` itself.
 */
const UPLOAD_PART_BYTES = 5 * 1024 * 1024;

/** Object keys are flat hex, exactly like the local backend's filenames. */
function createRandomKey(): string {
	return randomBytes(KEY_RANDOM_BYTES).toString("hex");
}

/** `bytes 2-5/10` → `10`; the total is the one thing a ranged response still reports. */
function totalSizeFromContentRange(contentRange: string | undefined): number | undefined {
	const total = contentRange?.split("/", 2)[1];

	if (total === undefined || !/^\d+$/.test(total)) {
		return undefined;
	}

	return Number(total);
}

/**
 * The size of the **whole** object, whatever slice of it was asked for: `ContentLength` covers
 * only the returned bytes on a ranged read, so the total comes off `Content-Range` there.
 */
function objectSize(response: GetObjectCommandOutput, storageKey: string): number {
	const size = totalSizeFromContentRange(response.ContentRange) ?? response.ContentLength;

	if (size === undefined) {
		throw new Error(`the S3 response for ${JSON.stringify(storageKey)} carried no object size`);
	}

	return size;
}

/** The HTTP status the SDK attaches to every error it raises, when it got that far. */
function httpStatusOf(error: object): unknown {
	const metadata: unknown = "$metadata" in error ? error.$metadata : undefined;

	return typeof metadata === "object" && metadata !== null && "httpStatusCode" in metadata
		? metadata.httpStatusCode
		: undefined;
}

/** Whether S3 (or MinIO, or R2) is saying "no such object" rather than failing. */
function isMissingObject(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}

	const name: unknown = "name" in error ? error.name : undefined;

	// `NoSuchKey` is S3's own; a bare 404 covers the servers that answer `NotFound` instead.
	return name === "NoSuchKey" || name === "NotFound" || httpStatusOf(error) === 404;
}

/**
 * whaloc runs on Node, where the SDK hands back a `Readable`. The other two shapes the type
 * allows (a web stream, a `Blob`) belong to browser and React Native builds.
 */
function toNodeStream(response: GetObjectCommandOutput, storageKey: string): Readable {
	const { Body: body } = response;

	if (body === undefined) {
		throw new MediaObjectNotFoundError(storageKey);
	}

	if (!(body instanceof Readable)) {
		throw new TypeError(`the S3 client returned a non-Node body for ${JSON.stringify(storageKey)}`);
	}

	return body;
}

function createClient(options: S3MediaStorageOptions): S3Client {
	const config: S3ClientConfig = {
		region: options.region,
		forcePathStyle: options.forcePathStyle ?? false,
		// S3-compatible servers (MinIO's older builds, R2, Ceph) reject the flexible checksum
		// trailers the SDK started adding by default; whaloc computes its own SHA-256 anyway.
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
		...(options.endpoint !== undefined && { endpoint: options.endpoint }),
		...(options.credentials !== undefined && { credentials: options.credentials }),
	};

	return new S3Client(config);
}

export class S3MediaStorage implements MediaStorage {
	readonly #client: S3Client;
	readonly #bucket: string;
	readonly #createKey: () => string;

	constructor(options: S3MediaStorageOptions) {
		this.#client = options.client ?? createClient(options);
		this.#bucket = options.bucket;
		this.#createKey = options.createKey ?? createRandomKey;
	}

	/** Best effort: the upload's own failure is the one worth reporting. */
	async #deleteQuietly(storageKey: string): Promise<void> {
		try {
			await this.delete(storageKey);
		} catch {
			// Nothing to add — the caller is about to throw the real error.
		}
	}

	/** Releases the SDK's sockets; the boot sequence calls it on shutdown. */
	close(): void {
		this.#client.destroy();
	}

	async put(source: Readable | Uint8Array, options: PutMediaOptions = {}): Promise<StoredMedia> {
		const storageKey = options.key ?? this.#createKey();

		assertValidStorageKey(storageKey);

		const hash = createHash("sha256");
		let byteSize = 0;
		const bytes = source instanceof Uint8Array ? Readable.from([Buffer.from(source)]) : source;
		const measure = measureWhileStreaming(hash, byteLength => (byteSize += byteLength));
		// `lib-storage` sends anything under one part as a single `PutObject` and switches to
		// multipart above it — so a 100 MiB upload never has to be buffered to learn its length,
		// which is what a bare `PutObjectCommand` would demand of a stream.
		const upload = new Upload({
			client: this.#client,
			partSize: UPLOAD_PART_BYTES,
			queueSize: 1,
			params: { Bucket: this.#bucket, Key: storageKey, Body: Readable.from(measure(bytes)) },
		});

		try {
			await upload.done();
		} catch (error) {
			// A half-written object is worse than none: `Upload` aborts its own multipart, and
			// this covers the single-request case (and any part that did land).
			await this.#deleteQuietly(storageKey);

			throw error;
		}

		return { storageKey, sha256: hash.digest(SHA256_DIGEST_ENCODING), byteSize };
	}

	async get(storageKey: string, options: GetMediaOptions = {}): Promise<MediaObject> {
		assertValidStorageKey(storageKey);

		const { range } = options;
		const command = new GetObjectCommand({
			Bucket: this.#bucket,
			Key: storageKey,
			...(range !== undefined && { Range: `bytes=${String(range.start)}-${String(range.end)}` }),
		});
		let response: GetObjectCommandOutput;

		try {
			response = await this.#client.send(command);
		} catch (error) {
			if (isMissingObject(error)) {
				throw new MediaObjectNotFoundError(storageKey, { cause: error });
			}

			throw error;
		}

		return { stream: toNodeStream(response, storageKey), size: objectSize(response, storageKey) };
	}

	async delete(storageKey: string): Promise<void> {
		assertValidStorageKey(storageKey);

		// S3 deletes are idempotent: removing a key that is not there answers 204.
		await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: storageKey }));
	}
}

export function createS3MediaStorage(options: S3MediaStorageOptions): MediaStorage {
	return new S3MediaStorage(options);
}
