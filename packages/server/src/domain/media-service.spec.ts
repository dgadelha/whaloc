import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDatabase,
	createRepositories,
	runMigrations,
	type DatabaseHandle,
	type Repositories,
} from "../db/index.ts";
import { createLocalDirStorage } from "../storage/index.ts";
import { stringMatching } from "../testing/expectations.ts";
import { GraphApiError } from "./graph-api-error.ts";
import { MAX_MEDIA_BYTES, MediaService } from "./media-service.ts";

const WABA_ID = "102290129340398";
const PHONE_NUMBER_ID = "15550000100";
const PUBLIC_URL = "http://localhost:9999";

describe("MediaService", () => {
	let handle: DatabaseHandle;
	let repositories: Repositories;
	let rootDir: string;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		repositories = createRepositories(handle.db);
		await repositories.wabas.insert({ id: WABA_ID, name: "Acme" });
		await repositories.phoneNumbers.insert({
			id: PHONE_NUMBER_ID,
			wabaId: WABA_ID,
			displayPhoneNumber: "+55 11 91234-5678",
			verifiedName: "Acme",
		});
		rootDir = await mkdtemp(path.join(tmpdir(), "whaloc-media-service-"));
	});

	afterEach(async () => {
		await handle.close();
		await rm(rootDir, { recursive: true, force: true });
	});

	function makeSut(maxBytes?: number): MediaService {
		return new MediaService({
			repositories,
			storage: createLocalDirStorage({ rootDir }),
			publicUrl: PUBLIC_URL,
			maxBytes,
		});
	}

	function uploadHello(service: MediaService, bytes = Buffer.from("hello whaloc")) {
		return service.upload({ phoneNumberId: PHONE_NUMBER_ID, bytes, mimeType: "text/plain" });
	}

	it("defaults to the 100 MiB cap (SPEC §2.6)", () => {
		expect(makeSut().maxBytes).toBe(MAX_MEDIA_BYTES);
		expect(MAX_MEDIA_BYTES).toBe(104_857_600);
	});

	it("measures the bytes it stored", async () => {
		const media = await uploadHello(makeSut());

		expect(media).toMatchObject({
			phoneNumberId: PHONE_NUMBER_ID,
			mimeType: "text/plain",
			fileSize: 12,
			// Base64, like Meta's: 43 characters of the alphabet plus the single `=` a 32-byte
			// digest always pads to.
			sha256: stringMatching(/^[\d+/A-Za-z]{43}=$/),
		});
	});

	it("refuses an upload above the cap without storing anything", async () => {
		const service = makeSut(4);

		await expect(uploadHello(service)).rejects.toThrow(GraphApiError);
		expect(await repositories.media.listByPhoneNumberId(PHONE_NUMBER_ID)).toEqual([]);
	});

	it("reports the cap in Meta's wording", () => {
		expect(() => {
			makeSut(16 * 1024 * 1024).assertWithinCap(20 * 1024 * 1024);
		}).toThrow("(#100) Media file size too big. Max file size we currently support: 16MB");
	});

	it("refuses an upload for a phone number that does not exist", async () => {
		const service = makeSut();

		await expect(
			service.upload({ phoneNumberId: "404404404404404", bytes: Buffer.from("x"), mimeType: "text/plain" }),
		).rejects.toMatchObject({ code: 100, subcode: 33 });
	});

	it("builds the public URL from WHALOC_PUBLIC_URL (SPEC §1.7)", async () => {
		const service = makeSut();
		const media = await uploadHello(service);

		expect(service.describe(media).url).toBe(`${PUBLIC_URL}/whaloc-media/${media.urlToken}`);
	});

	it("hides media belonging to another phone number", async () => {
		const service = makeSut();
		const media = await uploadHello(service);

		expect(() => service.describe(media, "888888888888888")).toThrow(GraphApiError);
		expect(service.describe(media, PHONE_NUMBER_ID).id).toBe(media.id);
	});

	it("gives every upload its own unguessable token", async () => {
		const service = makeSut();
		const first = await uploadHello(service);
		const second = await uploadHello(service);

		expect(first.urlToken).not.toBe(second.urlToken);
		expect(await service.findByUrlToken(first.urlToken)).toMatchObject({ id: first.id });
		expect(await service.findByUrlToken("nope")).toBeNull();
	});
});
