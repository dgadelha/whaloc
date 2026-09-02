import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { buffer, text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
	InvalidStorageKeyError,
	MediaObjectNotFoundError,
	SHA256_DIGEST_ENCODING,
	type MediaStorage,
} from "./media-storage.ts";

/**
 * The `MediaStorage` contract (SPEC §6), as one suite both implementations run.
 *
 * A second backend is only a drop-in replacement if it behaves identically, so the behavior
 * lives here instead of in either spec: what a hash and a byte count mean, what a byte range
 * answers, what a missing object throws, which keys are refused, and what a failed upload
 * leaves behind. `local-dir-storage.spec.ts` adds what is true of a directory only (the media
 * directory being created on demand, a key that must never reach a file outside it), and
 * `s3-storage.spec.ts` adds nothing — if the contract passes against MinIO, the backend works.
 *
 * This file is not a `*.spec.ts` on purpose: vitest collects the two specs that import it.
 */
export const CONTRACT_CONTENT = "olá 🌍, this is a media file";
export const CONTRACT_CONTENT_SHA256 = createHash("sha256").update(CONTRACT_CONTENT).digest(SHA256_DIGEST_ENCODING);

/**
 * Keys that no valid `createKey` would ever produce, and that every backend must refuse. The
 * NUL is written as an escape on purpose: as a raw byte it makes Git treat this file as binary
 * (which is how it lived in the local spec until this suite was extracted from it).
 */
export const UNSAFE_STORAGE_KEYS = [
	"../escape",
	"..",
	".hidden",
	"nested/key",
	"/absolute",
	"with space",
	"key ",
	"key\u{0}",
	"",
];

export interface MediaStorageContractOptions {
	/** Names the suite: the implementation under test. */
	name: string;
	/** Built per test, so nothing leaks between them. */
	createStorage: () => MediaStorage | Promise<MediaStorage>;
}

export function describeMediaStorageContract(options: MediaStorageContractOptions): void {
	describe(`${options.name} (MediaStorage contract)`, () => {
		const storageOf = async (): Promise<MediaStorage> => options.createStorage();

		it("stores a buffer and reports its hash and size", async () => {
			const storage = await storageOf();
			const stored = await storage.put(Buffer.from(CONTRACT_CONTENT));

			expect(stored.storageKey).toMatch(/^[\da-f]{32}$/);
			expect(stored.sha256).toBe(CONTRACT_CONTENT_SHA256);
			expect(stored.byteSize).toBe(Buffer.byteLength(CONTRACT_CONTENT));
		});

		/**
		 * The digest is base64, like Meta's: a consumer that decodes it to compare against its own
		 * hash of the downloaded bytes has to get 32 bytes back, not 64 characters of hex.
		 */
		it("reports the hash base64-encoded, the way Meta writes it", async () => {
			const storage = await storageOf();
			const stored = await storage.put(Buffer.from(CONTRACT_CONTENT));

			expect(stored.sha256).toMatch(/^[\d+/A-Za-z]{43}=$/);
			expect(Buffer.from(stored.sha256, "base64")).toHaveLength(32);
			expect(Buffer.from(stored.sha256, "base64").toString("hex")).toBe(
				createHash("sha256").update(CONTRACT_CONTENT).digest("hex"),
			);
		});

		it("stores a stream and measures it while it flows past", async () => {
			const chunks = ["olá 🌍", ", this is ", "a media file"].map(chunk => Buffer.from(chunk));
			const storage = await storageOf();
			const stored = await storage.put(Readable.from(chunks));

			expect(stored).toMatchObject({
				sha256: CONTRACT_CONTENT_SHA256,
				byteSize: Buffer.byteLength(CONTRACT_CONTENT),
			});
		});

		it("reads back exactly what was written", async () => {
			const storage = await storageOf();
			const { storageKey, byteSize } = await storage.put(Buffer.from(CONTRACT_CONTENT));
			const object = await storage.get(storageKey);

			expect(object.size).toBe(byteSize);
			await expect(text(object.stream)).resolves.toBe(CONTRACT_CONTENT);
		});

		/** The `Range` half of a media download (SPEC §1.7): the slice, and the whole size with it. */
		it("serves a byte range without losing the object size", async () => {
			const storage = await storageOf();
			const { storageKey } = await storage.put(Buffer.from("0123456789"));
			const object = await storage.get(storageKey, { range: { start: 2, end: 5 } });
			const bytes = await buffer(object.stream);

			expect(object.size).toBe(10);
			expect(bytes.toString()).toBe("2345");
		});

		it("uses the key it is given", async () => {
			const storage = await storageOf();
			const stored = await storage.put(Buffer.from(CONTRACT_CONTENT), { key: "fixed-key" });

			expect(stored.storageKey).toBe("fixed-key");

			const object = await storage.get("fixed-key");

			await expect(text(object.stream)).resolves.toBe(CONTRACT_CONTENT);
		});

		it("overwrites an object stored under a key it already used", async () => {
			const storage = await storageOf();

			await storage.put(Buffer.from("first"), { key: "same" });
			await storage.put(Buffer.from("second"), { key: "same" });

			const object = await storage.get("same");

			expect(object.size).toBe("second".length);
			await expect(text(object.stream)).resolves.toBe("second");
		});

		it("deletes an object, and says nothing when there is none", async () => {
			const storage = await storageOf();
			const { storageKey } = await storage.put(Buffer.from(CONTRACT_CONTENT));

			await storage.delete(storageKey);

			await expect(storage.get(storageKey)).rejects.toThrow(MediaObjectNotFoundError);
			await expect(storage.delete(storageKey)).resolves.toBeUndefined();
		});

		it("reports an unknown key as a missing object", async () => {
			// Freshly generated: a shared bucket must not be able to make this one pass.
			const unknown = randomBytes(16).toString("hex");

			const storage = await storageOf();

			await expect(storage.get(unknown)).rejects.toThrow(MediaObjectNotFoundError);
		});

		it.each(UNSAFE_STORAGE_KEYS)("refuses the unsafe storage key %j", async key => {
			const storage = await storageOf();

			await expect(storage.put(Buffer.from(CONTRACT_CONTENT), { key })).rejects.toThrow(InvalidStorageKeyError);
			await expect(storage.get(key)).rejects.toThrow(InvalidStorageKeyError);
			await expect(storage.delete(key)).rejects.toThrow(InvalidStorageKeyError);
		});

		/**
		 * A `put` that fails takes its bytes with it: the caller never learns the key, so an
		 * object left under it would be unreachable — and, on the local backend, would survive
		 * the failure only because of a race (see `LocalDirStorage`'s `whenClosed`).
		 */
		it("leaves nothing behind when the source fails mid-stream", async () => {
			const storage = await storageOf();
			// Pushed and destroyed below; the stream never needs to pull anything itself.
			const failing = new Readable({ read: () => {} });

			failing.push(Buffer.from("half"));
			failing.destroy(new Error("upload aborted"));

			await expect(storage.put(failing, { key: "aborted" })).rejects.toThrow("upload aborted");
			await expect(storage.get("aborted")).rejects.toThrow(MediaObjectNotFoundError);
		});
	});
}
