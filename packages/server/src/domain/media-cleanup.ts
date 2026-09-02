import type { Logger } from "../logging/index.ts";
import type { MediaStorage } from "../storage/index.ts";

export interface DeleteStoredMediaOptions {
	storageKeys: Iterable<string>;
	mediaStorage: MediaStorage;
	logger: Logger;
	/** Keys to leave alone — what an import is about to write back under the same name. */
	keep?: ReadonlySet<string>;
}

/**
 * Deletes media bytes through the storage adapter, best effort.
 *
 * Both operations that replace all state need this: `POST /api/reset` (SPEC §5), where leaving
 * orphaned objects behind would make "reset" quietly untrue, and `POST /api/import`, which
 * clears the old bytes before writing the snapshot's. An object that is already gone is not a
 * reason to fail either of them — the rows that pointed at it are gone too.
 *
 * @returns how many objects were deleted.
 */
export async function deleteStoredMedia(options: DeleteStoredMediaOptions): Promise<number> {
	const keep = options.keep ?? new Set<string>();
	let deleted = 0;

	for (const storageKey of options.storageKeys) {
		if (keep.has(storageKey)) {
			continue;
		}

		try {
			await options.mediaStorage.delete(storageKey);
			deleted += 1;
		} catch (error) {
			options.logger.warn({ err: error, storageKey }, "could not delete a media object");
		}
	}

	return deleted;
}
