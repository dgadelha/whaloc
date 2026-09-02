import { invalidParameterError } from "../domain/index.ts";

/**
 * Cursor pagination the way the consumer reads it (SPEC §1.5), shared by every Graph listing.
 *
 * `paging.cursors` is always there — empty strings on an empty page — and `paging.next` appears
 * **only when another page actually follows**, because its absence is what stops the consumer's
 * paging loop. `paging.previous` follows the same rule in the other direction: it is the link a
 * `before` cursor is read off, and it is absent when the page is the first one.
 */

/** Cursors are opaque to the consumer, so an object id in base64url is as good as anything. */
export function encodeCursor(id: string): string {
	return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string, parameter = "after"): string {
	const id = Buffer.from(cursor, "base64url").toString("utf8");

	if (!/^\d{1,32}$/.test(id)) {
		throw invalidParameterError(`Param ${parameter} is not a valid cursor`);
	}

	return id;
}

/** The `next` / `previous` links a page has, each present only when that page exists. */
export interface PagingLinks {
	next?: string;
	previous?: string;
}

export function pagingOf(ids: readonly string[], links: PagingLinks = {}): Record<string, unknown> {
	const first = ids[0];
	const last = ids.at(-1);
	const cursors = {
		before: first === undefined ? "" : encodeCursor(first),
		after: last === undefined ? "" : encodeCursor(last),
	};

	return { cursors, ...links };
}
