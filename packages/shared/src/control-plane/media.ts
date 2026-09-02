import { z } from "zod";

/**
 * `GET /api/media/:id` — the metadata behind a media id, so the UI can render an inline
 * preview of a message whose payload only carries `{id, mime_type, sha256}` (SPEC §5).
 *
 * It is the control-plane twin of the Graph API's first download hop (SPEC §1.7): same
 * descriptor, whaloc's own error shape, and no bearer token — the UI is not the app under
 * test. The `url` is absolute and built from `WHALOC_PUBLIC_URL`, which may name a host only
 * reachable from inside the compose network, so a browser uses its path against its own
 * origin.
 */
export const mediaDescriptorSchema = z.object({
	id: z.string(),
	url: z.string(),
	mimeType: z.string(),
	sha256: z.string(),
	fileSize: z.number().int().nonnegative(),
});

export type MediaDescriptor = z.infer<typeof mediaDescriptorSchema>;

export const mediaResponseSchema = z.object({ data: mediaDescriptorSchema });

export type MediaResponse = z.infer<typeof mediaResponseSchema>;

/**
 * `GET /api/uploads?handle=…` — the same idea for a **resumable-upload handle** (SPEC §2.21).
 *
 * A handle is not a media id: it comes out of the Upload API and is what Meta's own console
 * puts in a template's `example.header_handle` or in `profile_picture_handle`. The UI resolves
 * one here so a template header can be previewed with the picture it will actually send.
 */
export const uploadDescriptorSchema = z.object({
	handle: z.string(),
	url: z.string(),
	mimeType: z.string(),
	sha256: z.string(),
	fileSize: z.number().int().nonnegative(),
	/** The `file_name` the session was opened with, when it named one. */
	fileName: z.string().nullable(),
	createdAt: z.iso.datetime(),
});

export type UploadDescriptor = z.infer<typeof uploadDescriptorSchema>;

export const uploadResponseSchema = z.object({ data: uploadDescriptorSchema });

export type UploadResponse = z.infer<typeof uploadResponseSchema>;

export const uploadQuerySchema = z.object({ handle: z.string().min(1) });

export type UploadQuery = z.infer<typeof uploadQuerySchema>;
