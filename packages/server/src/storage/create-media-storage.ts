import type { AppConfig } from "../config/index.ts";
import { createLocalDirStorage } from "./local-dir-storage.ts";
import type { MediaStorage } from "./media-storage.ts";
import { createS3MediaStorage } from "./s3-storage.ts";

export interface CreateMediaStorageOptions {
	/** `WHALOC_MEDIA_BACKEND` and the variables that go with it (SPEC §6, §7). */
	config: AppConfig;
}

/**
 * Builds the one `MediaStorage` this process uses (SPEC §6).
 *
 * The choice is made **once**, at boot, from an environment that has already been validated —
 * an `s3` backend without a bucket never reaches this function, it fails config parsing. That
 * is what keeps the rest of the server ignorant of where media bytes live: it is handed an
 * implementation and never asks which one.
 */
export function createMediaStorage(options: CreateMediaStorageOptions): MediaStorage {
	const { config } = options;

	if (config.mediaBackend === "s3") {
		// Guaranteed by `checkS3Env`: the parse fails before a boot with an incomplete bucket.
		const s3 = config.s3!;

		return createS3MediaStorage({
			bucket: s3.bucket,
			region: s3.region,
			endpoint: s3.endpoint,
			forcePathStyle: s3.forcePathStyle,
			credentials: s3.credentials,
		});
	}

	return createLocalDirStorage({ rootDir: config.mediaDir });
}
