import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDirStorage } from "./local-dir-storage.ts";
import { CONTRACT_CONTENT, describeMediaStorageContract } from "./media-storage-contract.ts";
import { InvalidStorageKeyError, MediaObjectNotFoundError } from "./media-storage.ts";

/** Every root handed out below, removed after each test whether it was used or not. */
const roots: string[] = [];

/**
 * A throwaway media directory: **nested and missing on purpose**, since the directory is
 * created by the first upload and a whaloc that never receives one leaves no trace.
 */
async function createMediaDir(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "whaloc-storage-"));

	roots.push(root);

	return path.join(root, "data", "media");
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describeMediaStorageContract({
	name: "LocalDirStorage",
	createStorage: async () => new LocalDirStorage({ rootDir: await createMediaDir() }),
});

/** What is true of a directory specifically; the shared behavior is in the contract above. */
describe("LocalDirStorage", () => {
	let mediaDir: string;
	let storage: LocalDirStorage;

	beforeEach(async () => {
		mediaDir = await createMediaDir();
		storage = new LocalDirStorage({ rootDir: mediaDir });
	});

	it("creates the media directory on demand", async () => {
		const { storageKey } = await storage.put(Buffer.from(CONTRACT_CONTENT));

		await expect(readdir(mediaDir)).resolves.toEqual([storageKey]);
	});

	it("writes the object as a file named after its key", async () => {
		await storage.put(Buffer.from(CONTRACT_CONTENT), { key: "fixed-key" });

		await expect(readFile(path.join(mediaDir, "fixed-key"), "utf8")).resolves.toBe(CONTRACT_CONTENT);
	});

	it("takes its keys from the factory it was built with", async () => {
		const keyed = new LocalDirStorage({ rootDir: mediaDir, createKey: () => "generated" });
		const stored = await keyed.put(Buffer.from(CONTRACT_CONTENT));

		const object = await keyed.get("generated");

		expect(stored.storageKey).toBe("generated");
		await expect(text(object.stream)).resolves.toBe(CONTRACT_CONTENT);
	});

	it("never lets a key reach a file outside the media directory", async () => {
		// The upload is what creates the tree the sibling below can live in.
		await storage.put(Buffer.from(CONTRACT_CONTENT));

		const outside = path.join(mediaDir, "..", "secret.txt");

		await writeFile(outside, "top secret");
		await expect(storage.get("../secret.txt")).rejects.toThrow(InvalidStorageKeyError);
		await expect(readFile(outside, "utf8")).resolves.toBe("top secret");
	});

	/**
	 * The failure races the destination's own `open()`, so the assertion is about the directory
	 * and not only about `get`: a file created *after* the cleanup deleted it would still be
	 * there, and reading the directory is what proves the upload took its bytes with it.
	 */
	it("leaves nothing behind when the source fails mid-stream", async () => {
		// Pushed and destroyed below; the stream never needs to pull anything itself.
		const failing = new Readable({ read: () => {} });

		failing.push(Buffer.from("half"));
		failing.destroy(new Error("upload aborted"));

		await expect(storage.put(failing, { key: "aborted" })).rejects.toThrow("upload aborted");
		await expect(storage.get("aborted")).rejects.toThrow(MediaObjectNotFoundError);
		await expect(readdir(mediaDir)).resolves.toEqual([]);
	});
});
