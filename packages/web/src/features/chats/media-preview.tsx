import type { MediaDescriptor } from "@whaloc/shared";
import { useEffect, useState } from "react";
import { describeError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { formatBytes } from "../../lib/format.ts";

/**
 * A media message stores only what the webhook carries — `{id, mime_type, sha256}` — so the
 * id has to be resolved to a URL before anything can be rendered (`GET /api/media/:id`). The
 * answers are cached for the session: ids are immutable and a chat re-renders constantly.
 */
const descriptors = new Map<string, MediaDescriptor>();

interface MediaState {
	media: MediaDescriptor | null;
	error: string | null;
}

export function useMediaDescriptor(id: string | null): MediaState {
	const cached = id === null ? null : (descriptors.get(id) ?? null);
	const [state, setState] = useState<MediaState>({ media: cached, error: null });

	useEffect(() => {
		if (id === null) {
			return;
		}

		const known = descriptors.get(id);

		if (known !== undefined) {
			setState({ media: known, error: null });

			return;
		}

		const controller = new AbortController();

		async function resolve(mediaId: string): Promise<void> {
			try {
				const media = await api.getMedia(mediaId, { signal: controller.signal });

				descriptors.set(mediaId, media);
				setState({ media, error: null });
			} catch (error) {
				if (!controller.signal.aborted) {
					setState({ media: null, error: describeError(error) });
				}
			}
		}

		void resolve(id);

		return () => {
			controller.abort();
		};
	}, [id]);

	return state;
}

/**
 * The descriptor's URL is built from `WHALOC_PUBLIC_URL`, which usually names a host only
 * other containers can reach; the browser wants the same path on its own origin.
 *
 * It takes anything with a `url`, because an upload handle's descriptor (SPEC §2.21) has the
 * same problem and the same answer.
 */
export function mediaSrc(media: { url: string }): string {
	try {
		const url = new URL(media.url);

		return `${url.pathname}${url.search}`;
	} catch {
		return media.url;
	}
}

export interface MediaPreviewProps {
	mediaId: string;
	/** From the stored node; the descriptor's own MIME type wins once it arrives. */
	mimeType?: string | null;
	caption?: string | null;
	filename?: string | null;
	sticker?: boolean;
}

export function MediaPreview(props: MediaPreviewProps) {
	const { media, error } = useMediaDescriptor(props.mediaId);

	if (error !== null) {
		return (
			<span className="media media--error">
				media {props.mediaId} is gone ({error})
			</span>
		);
	}

	if (media === null) {
		return <span className="media media--loading mono">loading media {props.mediaId}…</span>;
	}

	const src = mediaSrc(media);
	const mimeType = media.mimeType || (props.mimeType ?? "");
	const label = props.filename ?? props.caption ?? "attachment";

	if (mimeType.startsWith("image/")) {
		return (
			<a href={src} target="_blank" rel="noreferrer" className="media">
				<img
					className={props.sticker === true ? "media__sticker" : "media__image"}
					src={src}
					alt={label}
					loading="lazy"
				/>
			</a>
		);
	}

	if (mimeType.startsWith("video/")) {
		return <video className="media__video" src={src} controls preload="metadata" />;
	}

	if (mimeType.startsWith("audio/")) {
		return <audio className="media__audio" src={src} controls preload="metadata" />;
	}

	return (
		<a className="media__document" href={src} target="_blank" rel="noreferrer" download={props.filename ?? undefined}>
			<span className="media__document-icon" aria-hidden="true">
				⇩
			</span>
			<span className="media__document-body">
				<span className="media__document-name">{label}</span>
				<span className="faint mono">
					{mimeType || "unknown type"} · {formatBytes(media.fileSize)}
				</span>
			</span>
		</a>
	);
}
