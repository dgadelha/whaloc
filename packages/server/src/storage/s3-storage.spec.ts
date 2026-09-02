import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { describeMediaStorageContract } from "./media-storage-contract.ts";
import { S3MediaStorage } from "./s3-storage.ts";

/**
 * The S3 backend against a real S3-compatible server (SPEC §6).
 *
 * **These specs need MinIO**, so they are opt-in: with `WHALOC_TEST_S3_ENDPOINT` unset they
 * skip, which is what keeps `npm test` green on a machine without Docker. CI sets the variable
 * against its `minio` service container; locally, one command is enough:
 *
 * ```sh
 * docker run -d --name whaloc-minio -p 9000:9000 \
 *   -e MINIO_ROOT_USER=whaloc -e MINIO_ROOT_PASSWORD=whaloc-secret minio/minio:edge-cicd
 * WHALOC_TEST_S3_ENDPOINT=http://127.0.0.1:9000 npm test --workspace @whaloc/server
 * ```
 *
 * The bucket is created by `beforeAll` rather than by a `mc` step, so the only thing the
 * environment has to provide is a running server.
 */
const endpoint = process.env["WHALOC_TEST_S3_ENDPOINT"];
const bucket = process.env["WHALOC_TEST_S3_BUCKET"] ?? "whaloc-test";
const region = process.env["WHALOC_TEST_S3_REGION"] ?? "us-east-1";
const credentials = {
	accessKeyId: process.env["WHALOC_TEST_S3_ACCESS_KEY_ID"] ?? "whaloc",
	secretAccessKey: process.env["WHALOC_TEST_S3_SECRET_ACCESS_KEY"] ?? "whaloc-secret",
};

if (endpoint === undefined) {
	// One line, once: a backend that skips itself in silence is worse than a noisy one.
	console.info(
		"S3MediaStorage specs skipped — set WHALOC_TEST_S3_ENDPOINT (e.g. http://127.0.0.1:9000) to run them against MinIO",
	);
}

const s3Options = {
	bucket,
	region,
	endpoint,
	forcePathStyle: true,
	credentials,
};

describe.skipIf(endpoint === undefined)("S3MediaStorage", () => {
	beforeAll(async () => {
		const client = new S3Client({ region, endpoint, forcePathStyle: true, credentials });

		try {
			await client.send(new CreateBucketCommand({ Bucket: bucket }));
		} catch (error) {
			// Owning it already is the normal case on a second run.
			const name = Error.isError(error) ? error.name : "";

			if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") {
				throw error;
			}
		} finally {
			client.destroy();
		}
	});

	describeMediaStorageContract({
		name: "S3MediaStorage",
		createStorage: () => new S3MediaStorage(s3Options),
	});

	/** Beyond one part, `lib-storage` switches to multipart — the path a 100 MiB upload takes. */
	it("stores an object larger than one multipart chunk", async () => {
		const storage = new S3MediaStorage(s3Options);
		const bytes = Buffer.alloc(6 * 1024 * 1024, "w");
		const stored = await storage.put(bytes, { key: "multipart-object" });
		const object = await storage.get("multipart-object", { range: { start: 5_000_000, end: 5_000_009 } });
		const slice: Buffer[] = [];

		for await (const chunk of object.stream) {
			slice.push(chunk as Buffer);
		}

		expect(stored.byteSize).toBe(bytes.byteLength);
		expect(object.size).toBe(bytes.byteLength);
		expect(Buffer.concat(slice).toString()).toBe("wwwwwwwwww");

		await storage.delete("multipart-object");
		storage.close();
	});
});
