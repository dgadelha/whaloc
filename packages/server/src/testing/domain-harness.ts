import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { pino } from "pino";
import {
	createDatabase,
	createRepositories,
	runMigrations,
	type DatabaseHandle,
	type Repositories,
} from "../db/index.ts";
import {
	createBackgroundTasks,
	MediaService,
	UploadService,
	type BackgroundTasks,
	type Scheduler,
} from "../domain/index.ts";
import type { Logger } from "../logging/index.ts";
import { MediaObjectNotFoundError, SHA256_DIGEST_ENCODING, type MediaStorage } from "../storage/index.ts";

/**
 * An in-memory database with one WABA, one phone number and one contact — the smallest world
 * the webhook engine, the status ladder and the template lifecycle can be exercised in.
 *
 * The ids are fixed and match the captured Meta fixtures in `docs/fixtures/webhooks/`, so the
 * builder specs can compare payloads field by field instead of loosening every assertion.
 */
export interface DomainHarness {
	handle: DatabaseHandle;
	repositories: Repositories;
	logger: Logger;
	tasks: BackgroundTasks;
	/** Bytes for the domain specs, in a `Map` — no directory to make and none to clean up. */
	mediaStorage: MediaStorage;
	/** The Upload API over that storage, which the template and profile services need (SPEC §2.21). */
	uploads: UploadService;
	/** Media over the same storage; `InboundService` mints its nodes' byte URLs through it. */
	media: MediaService;
	wabaId: string;
	phoneNumberId: string;
	contactWaId: string;
	close: () => Promise<void>;
}

/** The public URL the harness's byte URLs are built from. */
export const HARNESS_PUBLIC_URL = "http://localhost:9999";

/** The app id the harness's upload sessions are opened under. */
export const HARNESS_APP_ID = "700000000000001";

/** 100 MiB, the same ceiling `MediaService` enforces. */
const HARNESS_MAX_BYTES = 100 * 1024 * 1024;

/**
 * A `MediaStorage` that keeps objects in a `Map`.
 *
 * The contract suite (SPEC §6) is what proves the two *real* backends behave; a domain spec only
 * needs bytes to go in and come out, and a temporary directory per test is cleanup nobody reads.
 */
export function createMemoryMediaStorage(): MediaStorage {
	const objects = new Map<string, Buffer>();
	let sequence = 0;

	return {
		put: async (source, options = {}) => {
			const bytes = source instanceof Uint8Array ? Buffer.from(source) : await buffer(source);

			sequence += 1;

			const storageKey = options.key ?? `mem${String(sequence).padStart(6, "0")}`;

			objects.set(storageKey, bytes);

			return {
				storageKey,
				sha256: createHash("sha256").update(bytes).digest(SHA256_DIGEST_ENCODING),
				byteSize: bytes.byteLength,
			};
		},
		get: (storageKey, options = {}) => {
			const bytes = objects.get(storageKey);

			if (bytes === undefined) {
				return Promise.reject(new MediaObjectNotFoundError(storageKey));
			}

			const slice = options.range === undefined ? bytes : bytes.subarray(options.range.start, options.range.end + 1);

			return Promise.resolve({ stream: Readable.from(slice), size: bytes.byteLength });
		},
		delete: storageKey => {
			objects.delete(storageKey);

			return Promise.resolve();
		},
	};
}

/** The ids the fixtures use. */
export const HARNESS_WABA_ID = "102290129340398";
export const HARNESS_PHONE_NUMBER_ID = "106540352242922";
export const HARNESS_DISPLAY_PHONE_NUMBER = "+1 555 078-3881";
export const HARNESS_CONTACT_WA_ID = "16505551234";
export const HARNESS_CONTACT_NAME = "Sheena Nelson";

export async function createDomainHarness(): Promise<DomainHarness> {
	const handle = createDatabase({ dbPath: ":memory:" });

	await runMigrations({ db: handle.db });

	const repositories = createRepositories(handle.db);
	const logger = pino({ enabled: false });

	await repositories.wabas.insert({ id: HARNESS_WABA_ID, name: "whaloc Test Business" });
	await repositories.phoneNumbers.insert({
		id: HARNESS_PHONE_NUMBER_ID,
		wabaId: HARNESS_WABA_ID,
		displayPhoneNumber: HARNESS_DISPLAY_PHONE_NUMBER,
		verifiedName: "whaloc Test Business",
	});
	await repositories.contacts.insert({ waId: HARNESS_CONTACT_WA_ID, profileName: HARNESS_CONTACT_NAME });

	const mediaStorage = createMemoryMediaStorage();

	return {
		handle,
		repositories,
		logger,
		tasks: createBackgroundTasks(logger),
		mediaStorage,
		uploads: new UploadService({
			repositories,
			storage: mediaStorage,
			publicUrl: HARNESS_PUBLIC_URL,
			appId: HARNESS_APP_ID,
			maxBytes: HARNESS_MAX_BYTES,
		}),
		media: new MediaService({
			repositories,
			storage: mediaStorage,
			publicUrl: HARNESS_PUBLIC_URL,
			maxBytes: HARNESS_MAX_BYTES,
		}),
		wabaId: HARNESS_WABA_ID,
		phoneNumberId: HARNESS_PHONE_NUMBER_ID,
		contactWaId: HARNESS_CONTACT_WA_ID,
		close: () => handle.close(),
	};
}

/**
 * A scheduler that never really waits: `sleep` resolves immediately and records the delay it
 * was asked for, and `now` is a clock the test moves by hand. The webhook specs use it so the
 * retry ladder is asserted on its *intent* rather than on wall-clock time.
 */
export interface RecordingScheduler extends Scheduler {
	sleeps: number[];
	setNow: (value: Date) => void;
}

export function createRecordingScheduler(startAt = new Date("2026-06-12T12:00:00.000Z")): RecordingScheduler {
	const sleeps: number[] = [];
	let current = startAt;

	return {
		sleeps,
		setNow: value => {
			current = value;
		},
		now: () => current,
		schedule: (_delayMs, task) => {
			// The specs that care about timing use vitest's fake timers with the real
			// scheduler; here a scheduled task simply runs on the next tick.
			const timer = setTimeout(task, 0);

			timer.unref();

			return {
				cancel: () => {
					clearTimeout(timer);
				},
			};
		},
		sleep: async delayMs => {
			sleeps.push(delayMs);

			await Promise.resolve();
		},
	};
}
