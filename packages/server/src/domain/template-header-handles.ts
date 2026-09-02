import type { JsonObject } from "../db/index.ts";
import { invalidParameterError } from "./meta-errors.ts";
import type { UploadService } from "./upload-service.ts";

/**
 * `components[].example.header_handle[]` on a template (SPEC §2.7).
 *
 * A media header — `{"type":"HEADER","format":"IMAGE","example":{"header_handle":["4::…"]}}` —
 * names the picture Meta shows in the template gallery, and the handle in it comes from the
 * Resumable Upload API (SPEC §2.21). whaloc **resolves** every handle a create or an edit
 * carries, for the reason it resolves a `profile_picture_handle`: a template whose header points
 * at nothing is exactly the bug this emulator exists to catch, and the UI's preview has to be
 * able to render the header with the bytes that were actually uploaded.
 *
 * The components themselves are stored **verbatim**. The association whaloc needs is already
 * there — the handle is in the component, the bytes are in `upload_sessions` — so nothing is
 * rewritten into Meta's shape, and a template exported and re-imported still previews.
 */

/** The `header_handle` entries of one component, or an empty list when it has none. */
export function componentHeaderHandles(component: JsonObject): string[] {
	const example = component["example"];

	if (typeof example !== "object" || example === null || Array.isArray(example)) {
		return [];
	}

	const handles = (example as JsonObject)["header_handle"];

	if (!Array.isArray(handles)) {
		return [];
	}

	return handles.filter(handle => typeof handle === "string");
}

/** Every `header_handle` across a component array, in the order they appear. */
export function templateHeaderHandles(components: readonly JsonObject[]): string[] {
	return components.flatMap(component => componentHeaderHandles(component));
}

/**
 * Refuses a template whose header names a handle no completed upload session owns.
 *
 * The complaint is Meta's `(#100) Invalid parameter` with the offending handle in `details`,
 * which is the shape every other bad parameter on this surface takes (SPEC §1.4).
 */
export async function assertHeaderHandlesResolve(
	uploads: UploadService,
	components: readonly JsonObject[] | undefined,
): Promise<void> {
	if (components === undefined) {
		return;
	}

	for (const handle of templateHeaderHandles(components)) {
		if ((await uploads.findByHandle(handle)) === null) {
			throw invalidParameterError(
				`Param components[].example.header_handle (${handle}) is not a completed upload handle: ` +
					"create one with POST /{app-id}/uploads and POST /upload:{id}",
			);
		}
	}
}
